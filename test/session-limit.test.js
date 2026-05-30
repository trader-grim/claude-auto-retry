import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, findRateLimitMessage } from '../src/patterns.js';

// Regression tests for newer Claude Code rate-limit wordings that the
// original LIMIT_PATTERNS did not cover: "session limit" and "weekly limit".
// See: https://github.com/cheapestinference/claude-auto-retry/issues

test('detects "You\'ve hit your session limit" with reset time', () => {
  const msg = "⚠ You've hit your session limit · resets 6pm (America/Chicago)";
  assert.equal(isRateLimited(msg), true);
});

test('detects session limit rendered across multiple TUI lines', () => {
  const msg = [
    "⏺ Update(src/app.js)",
    "  ⎿  You've hit your session limit",
    "     · resets 3pm (UTC)",
  ].join('\n');
  assert.equal(isRateLimited(msg), true);
});

test('detects "Weekly limit reached" with reset time', () => {
  const msg = 'Weekly limit reached · resets 9am';
  assert.equal(isRateLimited(msg), true);
});

test('findRateLimitMessage returns the resets line for a session limit', () => {
  const msg = "You've hit your session limit · resets 6pm (America/Chicago)";
  const found = findRateLimitMessage(msg);
  assert.ok(found && /resets/i.test(found), `expected a resets line, got: ${found}`);
});

test('does not flag a benign mention of "session limit" without a reset', () => {
  const msg = 'We were discussing the session limit feature in the meeting.';
  assert.equal(isRateLimited(msg), false);
});

test('does not flag the word "weekly limit" without a reset', () => {
  const msg = 'The weekly limit feature shipped last week.';
  assert.equal(isRateLimited(msg), false);
});
