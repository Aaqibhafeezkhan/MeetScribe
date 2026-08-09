#!/usr/bin/env node
/**
 * Creates a private Python venv with faster-whisper and pre-downloads a model.
 *
 * Runnable two ways, both hitting this same file:
 *   npm run setup:whisper -- --model small [--gpu]
 *   the "Install / Repair Whisper" button in Settings (spawns this and streams
 *   stdout into the log pane)
 *
 * Every progress line goes to stdout so the UI can paint it live. The last line
 * on success is "OK <path-to-python>", which the caller parses and stores as
 * the whisperPython setting.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const useGpu = args.includes('--gpu');
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : 'small';
const dataDirIndex = args.indexOf('--data-dir');

// In the packaged app the caller passes userData; standalone we default to the
// same place Electron would use on Windows so both entry points share a venv.
const dataDir = dataDirIndex >= 0
  ? args[dataDirIndex + 1]
  : path.join(process.env.APPDATA || os.homedir(), 'MeetScribe');

const venvDir = path.join(dataDir, '.venv-whisper');
const modelDir = path.join(dataDir, '.whisper-models');
const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

function say(line) {
  process.stdout.write(`${line}\n`);
}

function run(command, commandArgs, options = {}) {
  say(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    ...options
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

/**
 * Find a usable interpreter. ctranslate2 ships wheels for cp39..cp313 only, so
 * a 3.14 install is rejected rather than left to fail during pip with a
 * confusing "no matching distribution" error.
 */
function findPython() {
  const candidates = isWindows
    ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (probe.status !== 0 || !probe.stdout) continue;
    const version = probe.stdout.trim();
    const [major, minor] = version.split('.').map(Number);
    if (major !== 3 || minor < 9 || minor > 13) {
      say(`  skipping ${command} ${prefix.join(' ')} (Python ${version}; need 3.9-3.13)`);
      continue;
    }
    say(`Using Python ${version} via "${command} ${prefix.join(' ')}".`);
    return { command, prefix };
  }
  throw new Error('No suitable Python found. Install Python 3.11-3.13 from python.org and re-run.');
}

function main() {
  say('=== MeetScribe Whisper setup ===');
  say(`Data directory: ${dataDir}`);

  if (!fs.existsSync(venvPython)) {
    const python = findPython();
    say('Creating virtual environment...');
    fs.mkdirSync(dataDir, { recursive: true });
    run(python.command, [...python.prefix, '-m', 'venv', venvDir]);
  } else {
    say('Virtual environment already exists; reusing it.');
  }

  if (!fs.existsSync(venvPython)) {
    throw new Error(`venv creation did not produce ${venvPython}`);
  }

  say('Upgrading pip...');
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check']);

  say('Installing faster-whisper...');
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'faster-whisper', '--disable-pip-version-check']);

  if (useGpu) {
    // ctranslate2 >= 4.5 does not bundle cuBLAS/cuDNN. Without these the CUDA
    // path dies with "Could not locate cudnn_ops64_9.dll"; the worker service
    // prepends their bin dirs to the child PATH at spawn time.
    say('Installing CUDA runtime libraries (cuBLAS + cuDNN)...');
    run(venvPython, [
      '-m', 'pip', 'install', '--upgrade',
      'nvidia-cublas-cu12', 'nvidia-cudnn-cu12',
      '--disable-pip-version-check'
    ]);
  }

  say(`Downloading the "${model}" model (this can take a few minutes)...`);
  fs.mkdirSync(modelDir, { recursive: true });
  run(venvPython, [
    '-c',
    'import sys;from faster_whisper import WhisperModel;' +
    'WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2]);' +
    'print("model ready")',
    model,
    modelDir
  ]);

  say('');
  say(`Model directory: ${modelDir}`);
  say(`OK ${venvPython}`);
}

try {
  main();
} catch (error) {
  say('');
  say(`ERROR ${error.message}`);
  process.exit(1);
}
