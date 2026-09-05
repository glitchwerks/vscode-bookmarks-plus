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

test('includes fully drained stderr when the server exits without responding', async () => {
  const marker = 'final stderr marker';
  const child = spawnFixture(`
    const fs = require('node:fs');
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', () => {
      fs.writeSync(2, 'x'.repeat(128 * 1024) + '${marker}\\n');
      process.exit(7);
    });
  `);
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    await assert.rejects(
      client.request('fixture/exit', {}),
      (error) => {
        assert.match(error.message, /code 7/);
        assert.match(error.message, new RegExp(marker));
        return true;
      },
    );
  } finally {
    await client.stop();
  }
});

test('rejects a request instead of emitting an unhandled EPIPE when stdin closes early', async () => {
  const child = spawnFixture('setInterval(() => {}, 1_000);');
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    const response = client.request('fixture/write-after-close', {});
    const pipeError = Object.assign(new Error('fixture EPIPE'), { code: 'EPIPE' });
    child.stdin.destroy(pipeError);
    await assert.rejects(
      response,
      /MCP server stdin error: fixture EPIPE/,
    );
  } finally {
    await client.stop();
  }
});
