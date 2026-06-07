import { stripAnsi, isRateLimited, findRateLimitMessage } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, getPaneCommand, isProcessForeground } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];

// Signature of the bottom of the pane — used to detect whether Claude has
// actually started responding after we sent a retry message. The rate-limit
// message lingers in the TUI scrollback even after Claude resumes, so
// re-running isRateLimited() always returns true and produces redundant
// retries. A change in the bottom 5 non-blank lines is a much more reliable
// "Claude is alive again" signal.
function paneSignature(stripped) {
  const lines = stripped.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  return lines.slice(-5).join('\n');
}

export function createMonitorState() {
  return { status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null, _sigBeforeSend: null };
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive) {
  if (!isAlive()) return 'exit';

  const raw = await tmuxAdapter.capturePane(pane, 20);
  const stripped = stripAnsi(raw);

  if (state.status === 'waiting') {
    if (Date.now() < state.waitUntil) return 'waiting';
    if (!isAlive()) return 'exit';

    // After we've sent at least one retry, prefer the "pane moved" signal
    // over re-pattern-matching the rate-limit text. The limit message stays
    // in scrollback after Claude resumes, so isRateLimited() would keep
    // returning true and the loop would resend the retry message every 30s.
    if (state._sigBeforeSend && paneSignature(stripped) !== state._sigBeforeSend) {
      state.status = 'monitoring';
      state.attempts = 0;
      state._sigBeforeSend = null;
      return 'user-continued';
    }

    // Always check if rate limit cleared FIRST — even when maxRetries
    // exhausted, the user (or time passing) may have resolved it.
    if (!isRateLimited(stripped, config.customPatterns)) {
      state.status = 'monitoring'; state.attempts = 0;
      state._sigBeforeSend = null;
      return 'user-continued';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit
      // on the next tick and creating an infinite max-retries loop.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      return 'max-retries';
    }

    // Primary check: is the Claude process in the foreground process group?
    // On macOS, pane_current_command reports "zsh" instead of the child process,
    // so we use `ps -o stat=` to check the '+' (foreground) flag directly.
    // `true` short-circuits past pane_current_command (fixes macOS).
    // `false`/`null` falls back to pane_current_command for safety.
    const isFg = await tmuxAdapter.isClaudeForeground();
    if (isFg !== true) {
      const fg = await tmuxAdapter.getPaneCommand(pane);
      const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
      if (!fgCommands.some(c => fg.toLowerCase().includes(c))) {
        state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
        state._lastForeground = fg;
        return 'skipped-not-claude';
      }
    }

    // Increment attempts and set cooldown BEFORE sendKeys so that a failure
    // (e.g. pane destroyed) still consumes a retry and avoids tight-loop errors.
    // Snapshot the pane signature before sending so the next tick can detect
    // whether Claude actually started responding (vs. our retry being eaten).
    state._sigBeforeSend = paneSignature(stripped);
    state.attempts++;
    state.waitUntil = Date.now() + 30_000;
    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    return 'retried';
  }

  if (isRateLimited(stripped, config.customPatterns)) {
    const message = findRateLimitMessage(stripped, config.customPatterns);
    const parsed = message ? parseResetTime(message) : null;
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    // Stale-message guard: if an absolute reset time is already in the past,
    // calculateWaitMs adds 24h and returns ~next-day waiting. That's almost
    // never what we want — the Claude TUI keeps old "resets HH:MMam" lines
    // in scrollback, and treating them as "tomorrow" makes the monitor sleep
    // through the actual fresh rate limit. If the wait is suspiciously close
    // to a full day, stay in monitoring and re-check on the next tick.
    if (waitMs > 22 * 3600 * 1000) {
      return 'monitoring';
    }

    state.lastRateLimitMessage = message;
    state.waitUntil = Date.now() + waitMs;
    state.status = 'waiting';
    return 'waiting';
  }

  return 'monitoring';
}

export async function startMonitor(pane, pid) {
  const config = await loadConfig();
  const logger = createLogger();
  const state = createMonitorState();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  await logger.info(`Monitor started for pane ${pane} (claude PID: ${pid})`);

  const tmuxAdapter = { capturePane, sendKeys, getPaneCommand, isClaudeForeground: () => isProcessForeground(pid) };
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const loop = async () => {
    try {
      const result = await processOneTick(state, tmuxAdapter, pane, config, isAlive);
      consecutiveErrors = 0;

      if (result === 'exit') { await logger.info('Claude exited. Monitor shutting down.'); process.exit(0); }
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'retried') await logger.info(`Sent retry message (attempt ${state.attempts})`);
      if (result === 'user-continued') await logger.info('User already continued. Attempt counter reset.');
      if (result === 'max-retries') await logger.warn(`Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      if (result === 'skipped-not-claude') await logger.warn(`Foreground is "${state._lastForeground}", not Claude. Skipping send-keys. (Add to foregroundCommands in ~/.claude-auto-retry.json if this is wrong)`);
    } catch (err) {
      consecutiveErrors++;
      await logger.error(`Monitor tick error: ${err.message}`).catch(() => {});
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors. Pane likely destroyed. Exiting.`).catch(() => {});
        process.exit(1);
      }
    }
  };

  // Use recursive setTimeout instead of setInterval to prevent concurrent
  // tick execution when a tick takes longer than the poll interval.
  const scheduleNext = () => {
    setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };
  loop().then(scheduleNext);
}

// Direct execution: node monitor.js <pane> <pid>
const isDirectRun = process.argv[1]?.endsWith('monitor.js') && process.argv.length >= 4;
if (isDirectRun) {
  startMonitor(process.argv[2], parseInt(process.argv[3], 10));
}
