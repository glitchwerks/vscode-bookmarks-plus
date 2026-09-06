import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface CiWorkflow {
  on?: {
    pull_request?: { branches?: string[] };
    push?: { branches?: string[] };
  };
  jobs?: Record<string, { if?: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { load } = require('js-yaml') as { load: (source: string) => CiWorkflow };

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/ci.yml');
const workflowSource = fs.readFileSync(workflowPath, 'utf8');
const workflow = load(workflowSource);

suite('CI workflow final integration (#124)', () => {
  test('targets only the default branch after the primary feature branch is integrated', () => {
    assert.deepStrictEqual(workflow.on?.pull_request?.branches, ['main']);
    assert.deepStrictEqual(workflow.on?.push?.branches, ['main']);
    assert.doesNotMatch(workflowSource, /feature-124-vscode-native-mcp/);
  });

  test('runs the packaged native MCP gate for pull requests and main pushes', () => {
    assert.strictEqual(
      workflow.jobs?.['packaged-native-mcp']?.if,
      "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'"
    );
  });
});
