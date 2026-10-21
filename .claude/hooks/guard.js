#!/usr/bin/env node
// PreToolUse hook: keep secrets and meeting data (transcripts, audio) out of
// the session and out of git. Exit 2 blocks the call and tells Claude why.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const ti = input.tool_input || {};
  const target = String(ti.file_path || ti.path || '');
  const cmd = String(ti.command || '');

  const sensitivePath = /(^|[\\/])(\.env(\..*)?|MeetingTranscripts|timeline[^\\/]*\.jsonl)([\\/]|$)|\.(pem|key|flac|wav)$/i;
  if (target && sensitivePath.test(target) && !/\.env\.example$/i.test(target)) {
    console.error(`Blocked: ${target} is a secret or meeting-data path. See CLAUDE.md privacy rules.`);
    process.exit(2);
  }

  if (cmd) {
    if (/git\s+push\b.*(--force|-f\b)/.test(cmd)) {
      console.error('Blocked: force-push. Ask the user explicitly first.');
      process.exit(2);
    }
    const verbOnData = /\b(cat|type|Get-Content|head|tail|git\s+add)\s+[^|;&\r\n]*(MeetingTranscripts|\.(flac|wav)\b)/i;
    if (verbOnData.test(cmd)) {
      console.error('Blocked: command touches meeting audio/transcripts. See CLAUDE.md privacy rules.');
      process.exit(2);
    }
  }
});
