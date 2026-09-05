'use strict';

function createJsonRpcClient(child, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pending = new Map();
  const stdoutNoise = [];
  let stderr = '';
  let stdoutBuffer = '';
  let nextId = 1;
  let stopped = false;
  let closed = false;
  let exitStatus;

  const diagnostic = (message) => {
    const details = [message];
    if (stdoutNoise.length > 0) {
      details.push(`unexpected non-JSON stdout: ${stdoutNoise.join(' | ')}`);
    }
    if (stderr.trim().length > 0) {
      details.push(`stderr: ${stderr.trim()}`);
    }
    return new Error(details.join('; '));
  };

  const settleAllWithError = (message) => {
    const error = diagnostic(message);
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line) => {
    if (line.trim().length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stdoutNoise.push(line);
      setImmediate(() => settleAllWithError('MCP server wrote diagnostic noise to stdout'));
      return;
    }

    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      stdoutNoise.push(line);
      setImmediate(() => settleAllWithError('MCP server wrote a non-protocol message to stdout'));
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
      return;
    }

    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timeout);
    pending.delete(message.id);
    entry.resolve(message);
  };

  const onStdout = (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  };

  const onStderr = (chunk) => {
    stderr += chunk.toString('utf8');
  };

  const onExit = (code, signal) => {
    exitStatus = { code, signal };
  };

  const onClose = (code, signal) => {
    closed = true;
    if (stdoutBuffer.trim().length > 0) {
      stdoutNoise.push(stdoutBuffer.trim());
      stdoutBuffer = '';
    }
    const status = exitStatus ?? { code, signal };
    settleAllWithError(
      `MCP server exited before responding (code ${status.code}, signal ${status.signal})`,
    );
  };

  const onError = (error) => {
    settleAllWithError(`MCP server process error: ${error.message}`);
  };

  const onStdinError = (error) => {
    settleAllWithError(`MCP server stdin error: ${error.message}`);
  };

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  child.on('exit', onExit);
  child.on('close', onClose);
  child.on('error', onError);
  child.stdin.on('error', onStdinError);

  const write = (message) => {
    if (stopped || closed || child.exitCode !== null || child.stdin.destroyed) {
      throw diagnostic('MCP server is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        onStdinError(error);
      }
    });
  };

  const waitForClose = async () => {
    if (closed) {
      return;
    }
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  };

  return {
    request(method, params = {}, label = method) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(diagnostic(`timed out after ${timeoutMs}ms waiting for ${label}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });

        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method, params = {}) {
      write({ jsonrpc: '2.0', method, params });
    },

    assertNoStdoutNoise() {
      if (stdoutNoise.length > 0) {
        throw diagnostic('MCP server wrote diagnostic noise to stdout');
      }
    },

    getStderr() {
      return stderr;
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;

      if (!closed && child.exitCode === null && !child.stdin.destroyed) {
        child.stdin.end();
      }
      await waitForClose();

      if (!closed && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForClose();
      }

      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onError);
      child.stdin.off('error', onStdinError);
      settleAllWithError('MCP client stopped before receiving a response');
    },
  };
}

module.exports = { createJsonRpcClient };
