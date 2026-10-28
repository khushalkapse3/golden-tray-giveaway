'use strict';

// One JSON object per line on stdout/stderr, which Render and journald both keep.

function createLogger({ silent = false } = {}) {
  const write = (level, message, data) => {
    if (silent) return;
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...data });
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    info: (message, data = {}) => write('info', message, data),
    warn: (message, data = {}) => write('warn', message, data),
    error: (message, data = {}) => write('error', message, data),
  };
}

module.exports = { createLogger };
