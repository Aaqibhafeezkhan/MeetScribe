const test = require('node:test');
const assert = require('node:assert/strict');

const TranscriptionStream = require('../src/services/transcription-stream');
const meetingService = require('../src/services/meeting.service');
const transcriptionService = require('../src/services/transcription.service');
const settingsStore = require('../src/core/settings.store');

test('hallucination filter rejects English and German stock phrases', () => {
  const stream = Object.create(TranscriptionStream.prototype);
  stream.language = 'auto';

  assert.equal(stream._sanitize('Thank you for watching'), null);
  assert.equal(stream._sanitize('Vielen Dank fürs Zuschauen'), null);
  assert.equal(stream._sanitize('[Music]'), null);
});

test('hallucination filter preserves genuine English and German meeting text', () => {
  const stream = Object.create(TranscriptionStream.prototype);
  stream.language = 'auto';

  assert.equal(stream._sanitize('The deployment is scheduled for Friday.'), 'The deployment is scheduled for Friday.');
  assert.equal(stream._sanitize('Das Deployment ist für Freitag geplant.'), 'Das Deployment ist für Freitag geplant.');
});

test('meeting reorder emits eligible entries by start time and releases expired entries', () => {
  const originalGet = settingsStore.get;
  const originalEmit = meetingService._emitEntry;
  const emitted = [];
  const now = Date.now();

  try {
    settingsStore.get = (key) => key === 'reorderWindowMs' ? 1000 : originalGet.call(settingsStore, key);
    meetingService.flushTimer = null;
    meetingService.pendingProvider = () => now - 100000;
    meetingService.pending = [
      { kind: 'utterance', startedAt: now - 3000, queuedAt: now - 3000, text: 'later completion' },
      { kind: 'marker', startedAt: now - 4000, queuedAt: now - 16000, text: 'expired marker' },
      { kind: 'utterance', startedAt: now - 5000, queuedAt: now - 3000, text: 'earlier speech' }
    ];
    meetingService._emitEntry = (entry) => emitted.push(entry);

    meetingService._flushPending(false);

    assert.deepEqual(emitted.map((entry) => entry.text), ['earlier speech', 'expired marker', 'later completion']);
    assert.equal(meetingService.pending.length, 0);
  } finally {
    if (meetingService.flushTimer) clearTimeout(meetingService.flushTimer);
    meetingService.flushTimer = null;
    meetingService.pending = [];
    meetingService.pendingProvider = null;
    meetingService._emitEntry = originalEmit;
    settingsStore.get = originalGet;
  }
});

test('echo suppression matches repeated system speech but preserves short replies', () => {
  const originalAll = settingsStore.all;
  const now = Date.now();

  try {
    settingsStore.all = () => ({ echoSuppress: true, echoSimilarity: 0.8 });
    transcriptionService.recentSystemLines = [{
      startedAt: now,
      tokens: transcriptionService._tokenize('Please review the deployment plan before Friday')
    }];

    assert.equal(transcriptionService._isEcho({
      streamId: 'mic',
      startedAt: now,
      text: 'Please review the deployment plan before Friday'
    }), true);

    assert.equal(transcriptionService._isEcho({
      streamId: 'mic',
      startedAt: now,
      text: 'Yes, absolutely'
    }), false);

    assert.equal(transcriptionService._isEcho({
      streamId: 'system',
      startedAt: now,
      text: 'Please review the deployment plan before Friday'
    }), false);
  } finally {
    settingsStore.all = originalAll;
    transcriptionService.recentSystemLines = [];
  }
});
