#!/usr/bin/env node
/**
 * Dependency-free sanity check used by CI, hooks and /ship.
 * - `node --check` on every JS file (syntax only)
 * - `py_compile` on scripts/*.py (skipped with a warning if Python is missing)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'out', 'build', '.venv-whisper', '.whisper-models', '__pycache__']);

function walk(dir, exts, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.includes(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

let failed = 0;

for (const file of walk(root, ['.js'])) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}\n${r.stderr}`);
  }
}

const pyFiles = walk(path.join(root, 'scripts'), ['.py']);
const py = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['--version']).status === 0);
if (!py) {
  console.warn('WARN python not found, skipping Python checks');
} else {
  for (const file of pyFiles) {
    const code = 'import sys,ast;ast.parse(open(sys.argv[1],encoding="utf8").read())';
    const r = spawnSync(py, ['-c', code, file], { encoding: 'utf8' });
    if (r.status !== 0) {
      failed++;
      console.error(`FAIL ${path.relative(root, file)}\n${r.stderr}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed`);
  process.exit(1);
}
console.log('check ok');
