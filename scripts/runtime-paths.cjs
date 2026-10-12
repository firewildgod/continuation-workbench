// Development checks use the current user's CLI, or an explicit test override.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveClaudeCommand({ home = os.homedir(), environment = process.env } = {}) {
  const explicit = environment.CLAUDE_CODE_PATH;
  const candidates = explicit ? [path.resolve(explicit)] : [
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(home, '.local', 'bin', 'claude.exe'),
    ...(environment.PATH || environment.Path || '').split(path.delimiter)
      .filter(Boolean).flatMap(directory => ['claude.cmd', 'claude.exe'].map(name => path.join(directory, name))),
  ];
  for (const candidate of candidates) {
    if (!/\.(?:cmd|exe)$/i.test(candidate)) continue;
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Try the next installation location. */ }
  }
  throw new Error('Claude Code CLI not found. Install it or set CLAUDE_CODE_PATH to its .cmd or .exe path.');
}

module.exports = { resolveClaudeCommand };
