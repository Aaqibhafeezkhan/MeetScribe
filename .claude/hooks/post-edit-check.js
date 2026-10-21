#!/usr/bin/env node
// PostToolUse hook: syntax-check JS/Python files right after Claude edits them.
// Exit 2 feeds stderr back to Claude so it fixes the error immediately.
const { spawnSync } = require('child_process');
const path = require('path');

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let file;
  try {
    file = JSON.parse(raw).tool_input?.file_path;
  } catch {
    return;
  }
  if (!file) return;

  const ext = path.extname(file);
  let r;
  if (ext === '.js') {
    r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  } else if (ext === '.py') {
    const py = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['--version']).status === 0);
    if (!py) return;
    const code = 'import sys,ast;ast.parse(open(sys.argv[1],encoding="utf8").read())';
    r = spawnSync(py, ['-c', code, file], { encoding: 'utf8' });
  } else {
    return;
  }

  if (r.status !== 0) {
    console.error(`Syntax error in ${file}:\n${r.stderr}`);
    process.exit(2);
  }
});
