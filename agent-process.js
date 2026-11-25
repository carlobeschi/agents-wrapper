// @ts-check
/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
}

/**
 * Share the timeout, stream, and lifecycle wiring used by agent steps. Callers
 * keep ownership of their step-specific completion logic.
 *
 * @param {{
 *   child: import('node:child_process').ChildProcess,
 *   timeout: number,
 *   onTimeout: () => void,
 *   onStdout: (chunk: Buffer) => void,
 *   onStderr: (chunk: Buffer) => void,
 *   onError: (error: Error) => void,
 *   onClose: (code: number | null) => void
 * }} config
 * @returns {void}
 */
function watchProcess({ child, timeout, onTimeout, onStdout, onStderr, onError, onClose }) {
  const timer = setTimeout(() => {
    onTimeout();
    killTree(child);
  }, timeout);
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.on('error', onError);
  child.on('close', code => {
    clearTimeout(timer);
    onClose(code);
  });
}

module.exports = { killTree, watchProcess };
