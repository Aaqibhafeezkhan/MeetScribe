const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('CORRECTIONS');

/**
 * Known-mistake corrections, applied when the final transcript is rendered.
 *
 * The glossary only nudges the model; this fixes a recurring mishearing every
 * time. File format: a flat JSON object, `{ "heard": "correct" }`.
 */

const FILE_NAME = 'corrections.json';
// Same idea as the glossary cap: a runaway file should not slow every render.
const MAX_RULES = 500;

// Unicode-aware "whole word": a letter or digit on either side blocks a match,
// so "Tracker" never matches inside "Trackers".
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turn parsed JSON into a clean `{ from, to }` list; junk is skipped, not fatal. */
function normalizeRules(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const rules = [];
  for (const [from, to] of Object.entries(data)) {
    const heard = String(from).trim();
    if (!heard || typeof to !== 'string' || !to.trim()) continue;
    rules.push({ from: heard, to: to.trim() });
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

function readRules(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return normalizeRules(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    logger.warn('Could not read corrections file', { file: path.basename(file), error: error.message });
    return [];
  }
}

/** Global rules first, then the meeting's; a meeting rule replaces a global one with the same key. */
function loadRules(folder, globalFile) {
  const merged = new Map();
  const sources = [globalFile ? readRules(globalFile) : [], folder ? readRules(path.join(folder, FILE_NAME)) : []];
  for (const rules of sources) {
    for (const rule of rules) merged.set(rule.from.toLowerCase(), rule);
  }
  return Array.from(merged.values());
}

/** One pass over all rules at once, so a replacement is never re-matched by a later rule. */
function buildMatcher(rules) {
  if (rules.length === 0) return null;
  const byKey = new Map(rules.map((rule) => [rule.from.toLowerCase(), rule.to]));
  // Longest first, so "Acme Tracker Pro" wins over "Acme Tracker".
  const alternation = rules
    .map((rule) => escapeRegExp(rule.from))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return { byKey, regex: new RegExp(NOT_WORD_BEFORE + '(?:' + alternation + ')' + NOT_WORD_AFTER, 'giu') };
}

/**
 * Replace every known mistake in `text`. Each fix is wrapped as `{correct}` so
 * it stays visible and reversible. `counts` (Map of lowercased heard -> number)
 * is updated in place so the caller can report totals.
 */
function applyCorrections(text, matcher, counts) {
  if (!matcher || !text) return { text, count: 0 };
  let count = 0;
  const out = text.replace(matcher.regex, (match) => {
    const key = match.toLowerCase();
    const to = matcher.byKey.get(key);
    if (to === undefined) return match;
    count++;
    if (counts) counts.set(key, (counts.get(key) || 0) + 1);
    return '{' + to + '}';
  });
  return { text: out, count };
}

module.exports = { FILE_NAME, normalizeRules, loadRules, buildMatcher, applyCorrections };
