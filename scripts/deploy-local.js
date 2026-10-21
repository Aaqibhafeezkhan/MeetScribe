#!/usr/bin/env node
/**
 * One-command local deploy: build the NSIS installer, install it silently over
 * the existing per-user install, and keep a single Start Menu shortcut.
 *
 *   npm run deploy            build + install
 *   npm run deploy -- --launch   ...and start the app afterwards
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const launch = process.argv.includes('--launch');

const installDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', pkg.build.productName);
const exePath = path.join(installDir, `${pkg.build.productName}.exe`);
const programsDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const shortcut = path.join(programsDir, `${pkg.build.nsis.shortcutName}.lnk`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' && cmd === 'npm', ...opts });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

function shortcutTarget(file) {
  const ps = `(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}').TargetPath`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

if (process.platform !== 'win32') {
  console.error('deploy is Windows-only.');
  process.exit(1);
}

console.log('> Stopping running MeetScribe');
spawnSync('taskkill', ['/F', '/IM', `${pkg.build.productName}.exe`], { stdio: 'ignore' });

console.log('> Building installer');
run('npm', ['run', 'build:installer']);

const installer = path.join(dist, `${pkg.build.productName}-Setup-${pkg.version}.exe`);
if (!fs.existsSync(installer)) {
  console.error(`Installer not found: ${installer}`);
  process.exit(1);
}

console.log(`> Installing ${path.basename(installer)} (silent, per-user)`);
run(installer, ['/S']);

if (!fs.existsSync(exePath)) {
  console.error(`Install finished but ${exePath} is missing.`);
  process.exit(1);
}
if (!fs.existsSync(shortcut)) {
  console.error(`Start Menu shortcut missing: ${shortcut}`);
  process.exit(1);
}
const target = shortcutTarget(shortcut);
if (path.resolve(target).toLowerCase() !== exePath.toLowerCase()) {
  console.error(`Shortcut targets ${target}, expected ${exePath}`);
  process.exit(1);
}

// Old per-build shortcuts (e.g. "MeetScribe 1.1.lnk") that pointed into dist/.
const distLower = dist.toLowerCase();
for (const name of fs.readdirSync(programsDir)) {
  if (!/^MeetScribe .*\.lnk$/i.test(name)) continue;
  const file = path.join(programsDir, name);
  if (shortcutTarget(file).toLowerCase().startsWith(distLower)) {
    fs.rmSync(file);
    console.log(`> Removed legacy shortcut ${name}`);
  }
}

// Keep the two newest installers (+ blockmaps); dev builds pile up otherwise.
const installers = fs.readdirSync(dist)
  .filter((f) => /^MeetScribe-Setup-.*\.exe$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(dist, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(2);
for (const { f } of installers) {
  fs.rmSync(path.join(dist, f), { force: true });
  fs.rmSync(path.join(dist, `${f}.blockmap`), { force: true });
}

console.log(`\nInstalled ${pkg.version} -> ${installDir}\nShortcut: ${shortcut}`);
if (launch) spawnSync('cmd', ['/c', 'start', '', exePath], { stdio: 'ignore', detached: true });
