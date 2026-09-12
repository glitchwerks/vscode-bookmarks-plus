import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';

/** Bound the host run, including forced process-tree cleanup after a stalled test. */
export function runRestrictedProcess(executable, args, { env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    // POSIX descendants inherit a dedicated process group; never signal the test runner's group.
    const child = spawn(executable, args, {
      env, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true,
    });
    let settled = false;
    let timeoutError;
    let cleanupTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (timeoutError) child.unref();
      if (error) reject(error);
      else resolveRun();
    };
    const timer = setTimeout(() => {
      timeoutError = new Error(`Restricted Mode test timed out after ${timeoutMs}ms`);
      clearTimeout(timer);
      // Even a failed OS termination must not prevent the caller's finally cleanup.
      cleanupTimer = setTimeout(() => {
        finish(new Error(`${timeoutError.message}; process termination did not complete`));
      }, 5000);
      if (process.platform === 'win32') {
        // child.kill() only kills the parent on Windows, leaving Electron children alive.
        execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 4000 }, (error) => {
            if (error) {
              child.kill('SIGKILL');
              finish(new Error(`${timeoutError.message}; process-tree termination failed`, { cause: error }));
            } else {
              finish(timeoutError);
            }
          });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code === 'ESRCH') finish(timeoutError);
          else finish(new Error(`${timeoutError.message}; process-tree termination failed`, { cause: error }));
        }
      }
    }, timeoutMs);
    child.once('error', (error) => {
      if (!timeoutError) finish(error);
    });
    child.once('exit', (code, signal) => {
      if (timeoutError) {
        // Windows taskkill must finish traversing descendants before the run settles.
        if (process.platform !== 'win32') finish(timeoutError);
        return;
      }
      console.log(`Restricted Mode VS Code exit: ${code ?? signal}`);
      if (code === 0) finish();
      else finish(new Error(`Restricted Mode test failed (exit ${code}, signal ${signal})`));
    });
  });
}
