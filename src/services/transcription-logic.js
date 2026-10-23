/**
 * Pure text matching used by live microphone echo suppression.
 * Inputs and outputs contain synthetic/text-only data; no audio is needed.
 */
function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

/** How much of the smaller set is contained in the larger one (0..1). */
function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

function isEchoMatch({ utterance, recentSystemLines, threshold = 0.8, windowMs = 6000, minTokens = 4 }) {
  if (!utterance || utterance.streamId !== 'mic') return false;
  const tokens = tokenize(utterance.text);
  if (tokens.size < minTokens) return false;

  for (const entry of recentSystemLines) {
    if (entry.tokens.size < minTokens) continue;
    if (Math.abs(entry.startedAt - utterance.startedAt) > windowMs) continue;
    if (containment(tokens, entry.tokens) >= threshold) return true;
  }
  return false;
}

module.exports = { tokenize, containment, isEchoMatch };
