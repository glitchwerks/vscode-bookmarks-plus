import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { createJsonRpcClient } from './mcp-json-rpc.cjs';

function spawnFixture(source) {
  return spawn(process.execPath, ['-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('matches JSON-RPC responses while accepting protocol notifications', async () => {
  const child = spawnFixture(`
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notice', params: {} }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
    });
  `);
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    const response = await client.request('fixture/ping', { value: 1 });
    assert.deepEqual(response.result, { ok: true });
    client.assertNoStdoutNoise();
  } finally {
    await client.stop();
  }
});

test('reports non-protocol stdout together with buffered stderr', async () => {
  const child = spawnFixture(`
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', () => {
      process.stderr.write('fixture diagnostic\\n');
      process.stdout.write('debug noise\\n');
    });
  `);
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    await assert.rejects(
      client.request('fixture/fail', {}),
      (error) => {
        assert.match(error.message, /unexpected non-JSON stdout: debug noise/);
        assert.match(error.message, /stderr: fixture diagnostic/);
        return true;
      },
    );
  } finally {
    await client.stop();
  }
});
