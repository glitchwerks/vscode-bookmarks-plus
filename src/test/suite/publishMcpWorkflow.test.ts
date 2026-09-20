import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: { contents?: string; 'id-token'?: string };
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  'continue-on-error'?: boolean;
}

interface McpPublishWorkflow {
  permissions?: { contents?: string; 'id-token'?: string };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  on?: {
    push?: { tags?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> };
  };
  jobs?: Record<string, WorkflowJob>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { load } = require('js-yaml') as { load: (source: string) => McpPublishWorkflow };
const workflowPath = path.resolve(__dirname, '../../../.github/workflows/publish-mcp.yml');
const workflow = load(fs.readFileSync(workflowPath, 'utf8'));
const immutableCommit = '${{ needs.resolve-release.outputs.commit }}';

function getJob(name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  assert.ok(job, `MCP publish workflow must define the ${name} job`);
  return job;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `job must define the ${name} step`);
  return step;
}

suite('MCP package publish workflow (#66)', () => {
  test('owns only the MCP tag lane and supports explicit-tag retries', () => {
    assert.deepStrictEqual(workflow.on?.push?.tags, ['mcp-v*.*.*']);
    assert.strictEqual(workflow.on?.workflow_dispatch?.inputs?.tag?.required, true);
    assert.strictEqual(
      workflow.concurrency?.group,
      'publish-mcp-${{ inputs.tag || github.ref_name }}'
    );
    assert.strictEqual(workflow.concurrency?.['cancel-in-progress'], false);
  });

  test('resolves one immutable tag commit', () => {
    const resolver = getJob('resolve-release');
    const checkout = getStep(resolver, 'Checkout selected release');
    const verifyMain = getStep(resolver, 'Verify release commit is on main');
    const resolve = getStep(resolver, 'Resolve immutable release commit');
    assert.strictEqual(
      checkout.with?.ref,
      "${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}"
    );
    assert.strictEqual(checkout.with?.['fetch-depth'], 0);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);
    assert.match(
      verifyMain.run ?? '',
      /git fetch --no-tags origin main:refs\/remotes\/origin\/main/
    );
    assert.match(verifyMain.run ?? '', /git merge-base --is-ancestor HEAD origin\/main/);
    assert.strictEqual(resolve.id, 'release');
    assert.match(resolve.run ?? '', /git rev-parse HEAD/);
    assert.strictEqual(resolver.outputs?.commit, '${{ steps.release.outputs.commit }}');
    assert.strictEqual(resolver.outputs?.tag, '${{ steps.release.outputs.tag }}');
  });

  test('gates publishing on lint and package verification of the immutable commit', () => {
    for (const jobName of ['lint', 'test-package']) {
      const job = getJob(jobName);
      assert.deepStrictEqual(job.needs, ['resolve-release']);
      assert.strictEqual(getStep(job, 'Checkout').with?.ref, immutableCommit);
      assert.strictEqual(getStep(job, 'Checkout').with?.['persist-credentials'], false);
      const setup = getStep(job, 'Setup Node');
      assert.strictEqual(setup.with?.['node-version'], '24.14.0');
      assert.strictEqual(setup.with?.cache, undefined);
      assert.strictEqual(
        getStep(job, 'Use npm 11.9.0').run,
        'npm install --global npm@11.9.0'
      );
    }

    const packageJob = getJob('test-package');
    for (const step of [
      'Validate release metadata',
      'Test',
      'Build',
      'Verify pack contents',
      'Test installed package',
    ]) {
      assert.strictEqual(getStep(packageJob, step)['working-directory'], 'mcp-server');
    }
    assert.strictEqual(
      getStep(packageJob, 'Validate release metadata').env?.MCP_RELEASE_TAG,
      '${{ needs.resolve-release.outputs.tag }}'
    );
    assert.strictEqual(
      getStep(packageJob, 'Validate release metadata').run,
      'npm run verify-release'
    );

    const publish = getJob('publish');
    assert.deepStrictEqual(
      [...(publish.needs as string[])].sort(),
      ['lint', 'resolve-release', 'test-package']
    );
    assert.strictEqual(getStep(publish, 'Checkout').with?.ref, immutableCommit);
  });

  test('grants OIDC only to the publish job and never requests content writes', () => {
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' });
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notStrictEqual(job.permissions?.contents, 'write');
      assert.strictEqual(job.permissions?.['id-token'], name === 'publish' ? 'write' : undefined);
    }
  });

  test('publishes publicly from mcp-server without a token or GitHub Release', () => {
    const publish = getJob('publish');
    const setup = getStep(publish, 'Setup Node');
    assert.strictEqual(setup.with?.['node-version'], '24.14.0');
    assert.strictEqual(setup.with?.cache, undefined);
    assert.strictEqual(
      getStep(publish, 'Use npm 11.9.0').run,
      'npm install --global npm@11.9.0'
    );
    assert.strictEqual(
      getStep(publish, 'Revalidate release metadata').env?.MCP_RELEASE_TAG,
      '${{ needs.resolve-release.outputs.tag }}'
    );
    assert.strictEqual(
      getStep(publish, 'Revalidate release metadata').run,
      'npm run verify-release'
    );
    const publishStep = getStep(publish, 'Publish');
    assert.strictEqual(publishStep['working-directory'], 'mcp-server');
    assert.strictEqual(publishStep.run, 'npm publish --access public');

    const source = fs.readFileSync(workflowPath, 'utf8');
    assert.doesNotMatch(source, /NODE_AUTH_TOKEN|secrets\..*NPM/i);
    assert.doesNotMatch(source, /action-gh-release|gh release/i);
  });

  test('does not permit failed jobs or steps to be bypassed', () => {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notStrictEqual(job['continue-on-error'], true, jobName);
      assert.notStrictEqual(job.if, 'always()', jobName);
      for (const step of job.steps ?? []) {
        assert.notStrictEqual(step['continue-on-error'], true, `${jobName}/${step.name}`);
        assert.notStrictEqual(step.if, 'always()', `${jobName}/${step.name}`);
      }
    }
  });
});
