// Full CSI sequence range per ECMA-48: parameter/intermediate bytes (0x20-0x3f) + final byte (0x40-0x7e)
// Covers standard, private-mode (\x1b[?25h), and extended sequences
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
// OSC sequences: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
// Covers hyperlinks (\x1b]8;;url\x1b\\), window titles (\x1b]0;title\x07), etc.
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS sequences: \x1bP ... ST
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
// APC, SOS, PM sequences: \x1b[_X^] ... ST
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders rate limits across multiple lines in its TUI, e.g.:
//   "⚠ You've hit your limit"
//   "· resets 3pm (UTC)"
// Detection: find a "limit" line and a "resets" line within 6 lines of each other.

const LIMIT_PATTERNS = [
  /(?:hit|exceeded|reached).*?limit/i,              // "hit/exceeded/reached ... limit" (handles "You've hit your session limit")
  /\d+-hour limit/i,                                // "5-hour limit"
  /limit reached/i,                                  // "limit reached"
  /session limit/i,                                  // "You've hit your session limit"
  /weekly limit/i,                                   // "Weekly limit reached"
  /usage limit/i,                                    // "usage limit"
  /out of.*usage/i,                                  // "out of extra usage"
  /rate limit/i,                                     // "rate limit"
  /try again in/i,                                   // "try again in X hours" (implies rate limiting)
];

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,   // "resets 3pm" / "resets at 3:00 PM"
  /resets?\s+in[:\s]\s*\d/i,                                   // "resets in: 3 hours"
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,               // "try again in 5 hours"
];

const WINDOW = 6;

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(lines.length, idx + WINDOW + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

export function isRateLimited(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Custom patterns: check full text (user controls their own regex)
  if (customPatterns.length > 0) {
    const full = lines.join('\n');
    const custom = customPatterns.map(p => typeof p === 'string' ? new RegExp(p, 'i') : p);
    if (custom.some(p => p.test(full))) return true;
  }

  // Find a "limit" line with a "resets" line nearby (works for both
  // single-line messages and multi-line TUI renders)
  for (let i = 0; i < lines.length; i++) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) {
      if (hasNearbyMatch(lines, i, RESET_PATTERNS)) return true;
    }
  }

  return false;
}

export function findRateLimitMessage(text, customPatterns = []) {
  const lines = stripAnsi(text).split('\n');

  // Scan from the bottom up — the most recent "resets" line in the pane is
  // the one we should parse. The Claude TUI never clears earlier rate-limit
  // messages from scrollback, so a forward scan would lock on stale ones
  // (e.g. an 11:30am message lingering after Claude has resumed; a fresh
  // 4:30pm message is below it but never reached).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  // Fallback: any "limit" line, also scanned from the bottom.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) return lines[i].trim();
  }

  return null;
}

// Detects the interactive Claude Code prompt asking user to wait or upgrade
// "What do you want to do?"
// "❯ 1. Stop and wait for limit to reset"
// "  2. Upgrade your plan"
// We auto-select option 1 by sending Enter
export function isLimitPrompt(text) {
  const stripped = stripAnsi(text);
  return /What do you want to do\?/i.test(stripped) &&
         /Stop and wait.*limit/i.test(stripped);
}

// Detects the spend-limit menu ("Adjust monthly spend limit" variant) and
// returns the key sequence needed to navigate to "Wait for limit to reset".
// Returns null when the menu is absent or not the spend-limit variant.
export function findSpendLimitMenuAction(text) {
  const lines = stripAnsi(text).split('\n');
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/What do you want to do\?/i.test(lines[i])) { promptIdx = i; break; }
  }
  if (promptIdx === -1) return null;

  const block = lines.slice(promptIdx, Math.min(lines.length, promptIdx + 8));

  const hasSpendLimitOption = block.some(l => /Adjust monthly spend limit/i.test(l));
  const waitOffset = block.findIndex(l => /Wait for limit to reset/i.test(l));
  if (!hasSpendLimitOption || waitOffset === -1) return null;

  const selectedOffset = block.findIndex(l => /^[\s]*[❯>]/.test(l));
  const waitIdx = promptIdx + waitOffset;
  const selectedIdx = selectedOffset === -1 ? -1 : promptIdx + selectedOffset;
  const keys = [];

  if (selectedIdx === -1) {
    keys.push('Down');
  } else if (selectedIdx < waitIdx) {
    keys.push(...Array(waitIdx - selectedIdx).fill('Down'));
  } else if (selectedIdx > waitIdx) {
    keys.push(...Array(selectedIdx - waitIdx).fill('Up'));
  }

  keys.push('Enter');
  return { keys };
}

const NETWORK_ERROR_PATTERNS = [
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /ECONNRESET/,
  /ECONNABORTED/,
  /fetch failed/i,
  /Failed to fetch/i,
  /socket hang up/i,
  /connection timed out/i,
  /network.*error/i,
  /request.*timed? out/i,
  /gateway timeout/i,
  /API.*(?:unreachable|unavailable)/i,
];

export function isNetworkError(text) {
  const stripped = stripAnsi(text);
  return NETWORK_ERROR_PATTERNS.some(p => p.test(stripped));
}
