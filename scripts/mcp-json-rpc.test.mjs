import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createJsonRpcClient } from './mcp-json-rpc.cjs';

function spawnFixture(source) {
  return spawn(process.execPath, ['-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function createStreamFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;

  const close = () => {
    if (child.exitCode !== null) {
      return;
    }
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  };
  child.stdin.on('finish', close);
  child.kill = close;
  return child;
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for fixture state');
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

test('rejects JSON-RPC error responses with the request label and server error details', async () => {
  const serverError = {
    code: -32602,
    message: 'fixture parameters are invalid',
    data: { field: 'value' },
  };
  const child = spawnFixture(`
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).once('line', (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: ${JSON.stringify(serverError)},
      }) + '\\n');
    });
  `);
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    await assert.rejects(
      client.request('fixture/fail', {}, 'the labelled fixture request'),
      (error) => {
        assert.match(error.message, /the labelled fixture request/);
        assert.match(error.message, /fixture parameters are invalid/);
        assert.equal(error.code, serverError.code);
        assert.deepEqual(error.data, serverError.data);
        assert.deepEqual(error.serverError, serverError);
        return true;
      },
    );
  } finally {
    await client.stop();
  }
});

test('decodes a UTF-8 response when a multibyte character is split across stdout chunks', async () => {
  const child = createStreamFixture();
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });
  const encoded = Buffer.from(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: '€' } })}\n`,
    'utf8',
  );
  const multibyteStart = encoded.indexOf(Buffer.from('€', 'utf8'));

  try {
    const response = client.request('fixture/split-utf8');
    child.stdout.write(encoded.subarray(0, multibyteStart + 1));
    child.stdout.write(encoded.subarray(multibyteStart + 1));

    assert.equal((await response).result.value, '€');
  } finally {
    await client.stop();
  }
});

test('reports non-protocol stdout together with buffered stderr', async () => {
  const child = spawnFixture(`
    const readline = require('node:readline');
    let lineNumber = 0;
    readline.createInterface({ input: process.stdin }).on('line', () => {
      lineNumber += 1;
      if (lineNumber === 1) {
        process.stderr.write('fixture diagnostic\\n');
      } else {
        process.stdout.write('debug noise\\n');
      }
    });
  `);
  const client = createJsonRpcClient(child, { timeoutMs: 2_000 });

  try {
    const response = client.request('fixture/fail', {});
    await waitUntil(() => client.getStderr().includes('fixture diagnostic'));
    client.notify('fixture/emit-stdout-noise');
    await assert.rejects(
      response,
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
