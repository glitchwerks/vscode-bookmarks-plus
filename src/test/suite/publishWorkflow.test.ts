import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
  with?: {
    ref?: string;
    'fetch-depth'?: number;
    'persist-credentials'?: boolean;
  };
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  'continue-on-error'?: boolean;
  outputs?: Record<string, string>;
  strategy?: {
    matrix?: {
      os?: string[];
    };
  };
  steps?: WorkflowStep[];
}

interface PublishWorkflow {
  on?: {
    push?: {
      tags?: string[];
    };
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean }>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
}

// js-yaml is pinned as a development dependency. Loading the workflow as data
// lets these tests exercise its job graph instead of matching incidental source
// formatting.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { load } = require('js-yaml') as { load: (source: string) => PublishWorkflow };

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/publish.yml');
const workflow = load(fs.readFileSync(workflowPath, 'utf8'));

function getJob(name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  assert.ok(job, `publish workflow must define the ${name} job`);
  return job;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find(candidate => candidate.name === name);
  assert.ok(step, `job must define the ${name} step`);
  return step;
}

suite('Publish workflow native MCP release gates (#136)', () => {
  const checkoutAction =
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
  const setupNodeAction =
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  const releaseAction =
    'softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65';
  const immutableReleaseCommit = '${{ needs.resolve-release.outputs.commit }}';

  test('uses the same release gates for tag pushes and manual dispatches', () => {
    assert.deepStrictEqual(workflow.on?.push?.tags, ['v*.*.*']);
    assert.strictEqual(workflow.on?.workflow_dispatch?.inputs?.tag?.required, true);
  });

  test('resolves a qualified tag once and exports its immutable commit', () => {
    const resolver = getJob('resolve-release');
    const checkout = getStep(resolver, 'Checkout selected release');
    const resolve = getStep(resolver, 'Resolve immutable release commit');

    assert.strictEqual(
      checkout.with?.ref,
      "${{ github.event_name == 'workflow_dispatch' && format('refs/tags/{0}', inputs.tag) || github.sha }}"
    );
    assert.strictEqual(checkout.with?.['fetch-depth'], 0);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);
    assert.strictEqual(resolve.id, 'release');
    assert.match(resolve.run ?? '', /git rev-parse HEAD/);
    assert.match(resolve.run ?? '', /GITHUB_OUTPUT/);
    assert.strictEqual(resolver.outputs?.commit, '${{ steps.release.outputs.commit }}');
    assert.strictEqual(resolver.outputs?.tag, '${{ steps.release.outputs.tag }}');
  });

  test('blocks publishing and GitHub release creation on both native MCP gates', () => {
    const publish = getJob('publish');
    const needs = Array.isArray(publish.needs) ? publish.needs : [publish.needs];

    assert.deepStrictEqual(
      needs.sort(),
      ['mcp-bundle', 'packaged-native-mcp', 'resolve-release'],
      'publish must wait for release resolution and every native MCP gate'
    );
    getStep(publish, 'Publish');
    getStep(publish, 'Create GitHub Release');
  });

  test('publishes the same immutable commit that the gates validate', () => {
    const publish = getJob('publish');
    const checkout = getStep(publish, 'Checkout');
    const setupNode = getStep(publish, 'Setup Node');

    assert.strictEqual(checkout.uses, checkoutAction);
    assert.strictEqual(checkout.with?.ref, immutableReleaseCommit);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);
    assert.strictEqual(setupNode.uses, setupNodeAction);
  });

  test('pins the privileged GitHub release action to an immutable commit', () => {
    const createRelease = getStep(getJob('publish'), 'Create GitHub Release');

    assert.strictEqual(createRelease.uses, releaseAction);
  });

  test('runs the bundled MCP check against the immutable release commit', () => {
    const bundle = getJob('mcp-bundle');
    const checkout = getStep(bundle, 'Checkout');

    assert.deepStrictEqual(bundle.needs, ['resolve-release']);
    assert.strictEqual(checkout.uses, checkoutAction);
    assert.strictEqual(checkout.with?.ref, immutableReleaseCommit);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);
    assert.strictEqual(
      getStep(bundle, 'Test bundled MCP server and VSIX contents').run,
      'npm run test:mcp-bundle'
    );
  });

  test('runs the packaged VSIX check on Linux and Windows against the immutable release commit', () => {
    const packaged = getJob('packaged-native-mcp');
    const checkout = getStep(packaged, 'Checkout');

    assert.deepStrictEqual(packaged.needs, ['resolve-release']);
    assert.deepStrictEqual(
      packaged.strategy?.matrix?.os,
      ['ubuntu-latest', 'windows-latest']
    );
    assert.strictEqual(checkout.uses, checkoutAction);
    assert.strictEqual(checkout.with?.ref, immutableReleaseCommit);
    assert.strictEqual(checkout.with?.['persist-credentials'], false);

    const linux = getStep(packaged, 'Test packaged native MCP integration (Linux)');
    assert.strictEqual(linux.if, "runner.os == 'Linux'");
    assert.strictEqual(linux.run, 'xvfb-run -a npm run test:packaged-mcp');

    const windows = getStep(packaged, 'Test packaged native MCP integration (Windows)');
    assert.strictEqual(windows.if, "runner.os == 'Windows'");
    assert.strictEqual(windows.run, 'npm run test:packaged-mcp');
  });

  test('does not allow a failed resolver or gate to be bypassed', () => {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notStrictEqual(
        job['continue-on-error'],
        true,
        `${jobName} must not continue after failure`
      );
      assert.notStrictEqual(job.if, 'always()', `${jobName} must not run after failed dependencies`);

      for (const step of job.steps ?? []) {
        assert.notStrictEqual(
          step['continue-on-error'],
          true,
          `${jobName}/${step.name ?? 'unnamed step'} must not continue after failure`
        );
      }
    }
  });
});
