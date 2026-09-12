import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runRestrictedProcess } from './restricted-test-process.mjs';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('the deadline rejects and terminates a hanging child and its descendant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bookmarks-restricted-deadline-'));
  const pidFile = join(directory, 'pids.json');
  let pids = [];
  try {
    const running = runRestrictedProcess(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      });
      require('node:fs').writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `, pidFile], { timeoutMs: 2000 });
    const outcome = running.then(() => 'resolved', error => error);
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        pids = JSON.parse(await readFile(pidFile, 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await delay(10);
      }
    }
    assert.equal(pids.length, 2, 'both fixture processes started');
    assert.ok(pids.every(isAlive), 'both fixture processes are running');
    const result = await Promise.race([outcome, delay(7000, 'still running', { ref: false })]);
    assert.ok(result instanceof Error, `expected a deadline failure, got ${result}`);
    assert.match(result.message, /timed out/);
    for (let attempt = 0; attempt < 100 && pids.some(isAlive); attempt++) {
      await delay(10);
    }
    assert.deepEqual(pids.map(isAlive), [false, false], 'no child survives the deadline');
  } finally {
    for (const pid of pids.reverse()) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'successful exit', executable: process.execPath, args: ['-e', ''], expected: 'resolved' },
  { name: 'failed exit', executable: process.execPath, args: ['-e', 'process.exit(7)'], expected: 'exit 7' },
  { name: 'spawn error', executable: join(tmpdir(), 'bookmarks-nonexistent-executable'), args: [], expected: 'ENOENT' },
]) {
  test(`${scenario.name} settles promptly without leaving a deadline timer alive`, () => {
    // A separate Node runner must exit naturally; a leaked 30s timer fails this 3s guard.
    const runner = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runRestrictedProcess } from ${JSON.stringify(new URL('./restricted-test-process.mjs', import.meta.url).href)};
      try {
        await runRestrictedProcess(${JSON.stringify(scenario.executable)}, ${JSON.stringify(scenario.args)}, { timeoutMs: 30000 });
        console.log('resolved');
      } catch (error) {
        console.log(error.message);
      }
    `], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    assert.equal(runner.error, undefined);
    assert.equal(runner.status, 0, runner.stderr);
    assert.ok(runner.stdout.includes(scenario.expected), runner.stdout);
  });
}
