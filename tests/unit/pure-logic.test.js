const test = require('node:test');
const assert = require('node:assert/strict');

const TranscriptionStream = require('../../src/services/transcription-stream');
const { partitionPendingEntries } = require('../../src/services/meeting-ordering');
const { isEchoMatch, tokenize } = require('../../src/services/transcription-logic');

test('hallucination filter drops synthetic English and German boilerplate', () => {
  const english = new TranscriptionStream({
    id: 'system', label: 'Them', vad: {}, transcriber: {}, language: 'en'
  });
  const german = new TranscriptionStream({
    id: 'system', label: 'Them', vad: {}, transcriber: {}, language: 'de'
  });

  assert.equal(english._sanitize('Thank you for watching.'), null);
  assert.equal(german._sanitize('Vielen Dank fürs Zuschauen.'), null);
  assert.equal(english._sanitize('The deployment is scheduled for Friday.'), 'The deployment is scheduled for Friday.');
});

test('meeting entries are emitted in speech-start order after the reorder window', () => {
  const later = { kind: 'utterance', startedAt: 4200, queuedAt: 3000, text: 'later' };
  const earlier = { kind: 'utterance', startedAt: 1000, queuedAt: 3000, text: 'earlier' };

  const result = partitionPendingEntries([later, earlier], {
    all: false, now: 5000, reorderMs: 1000, oldestPending: null, maxHoldMs: 15000
  });

  assert.deepEqual(result.ready.map((entry) => entry.text), ['earlier']);
  assert.deepEqual(result.remaining.map((entry) => entry.text), ['later']);
});

test('maximum hold releases an entry even before its reorder window settles', () => {
  const stuck = { kind: 'marker', startedAt: 19900, queuedAt: 1000, text: 'synthetic marker' };

  const result = partitionPendingEntries([stuck], {
    all: false, now: 20000, reorderMs: 1200, oldestPending: 1000, maxHoldMs: 15000
  });

  assert.deepEqual(result.ready, [stuck]);
  assert.deepEqual(result.remaining, []);
});

test('echo suppression matches overlapping synthetic mic and system text within the time window', () => {
  const systemText = 'project alpha review tomorrow';
  const utterance = {
    streamId: 'mic',
    startedAt: 10000,
    text: 'project alpha review tomorrow'
  };
  const recentSystemLines = [{
    startedAt: 10500,
    tokens: tokenize(systemText)
  }];

  assert.equal(isEchoMatch({ utterance, recentSystemLines }), true);
  assert.equal(isEchoMatch({
    utterance: { ...utterance, startedAt: 20000 },
    recentSystemLines
  }), false);
  assert.equal(isEchoMatch({
    utterance: { ...utterance, text: 'yes okay sure' },
    recentSystemLines
  }), false);
});
