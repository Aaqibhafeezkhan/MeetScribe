/**
 * Decide which buffered transcript entries are safe to write.
 * Kept pure so the reorder window and maximum-hold behavior can be tested
 * without opening an Electron window or writing a meeting file.
 */
function partitionPendingEntries(entries, { all, now, reorderMs, oldestPending, maxHoldMs }) {
  const sorted = [...entries].sort((a, b) => a.startedAt - b.startedAt);
  const cutoff = now - reorderMs;
  const ready = [];
  const remaining = [];

  for (const entry of sorted) {
    if (all) {
      ready.push(entry);
      continue;
    }

    const expired = now - (entry.queuedAt || now) >= maxHoldMs;
    const settled = entry.startedAt <= cutoff;
    const unblocked =
      entry.kind === 'utterance' ||
      oldestPending === null ||
      entry.startedAt <= oldestPending;

    // Once one entry is held, everything after it must wait too — otherwise
    // the release order is not the sort order.
    if (expired || (settled && unblocked && remaining.length === 0)) {
      ready.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  return { ready, remaining };
}

module.exports = { partitionPendingEntries };
