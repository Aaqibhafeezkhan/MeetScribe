#!/usr/bin/env node
/**
 * Cross-platform launcher.
 *
 * The old `npm start` was `env -u ELECTRON_RUN_AS_NODE electron .`, which only
 * works in a POSIX shell. npm runs scripts through cmd.exe on Windows, where
 * `env` does not exist. This does the same job with zero dependencies:
 * unset ELECTRON_RUN_AS_NODE (npm sets it in some contexts, which would make
 * the Electron binary behave as a plain Node runtime) and spawn Electron.
 */
const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron');
} catch (error) {
  console.error('Electron is not installed. Run `npm install` first.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(__dirname, '..'), ...process.argv.slice(2)];

const child = spawn(electronPath, args, { stdio: 'inherit', env, windowsHide: false });

child.on('close', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to launch Electron:', error.message);
  process.exit(1);
});
