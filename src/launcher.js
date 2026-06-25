import { spawn, fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isInsideTmux, getCurrentPane, capturePane, getTmuxVersion, buildSetWindowOptionArgs } from './tmux.js';
import { isRateLimited, findRateLimitMessage, isNetworkError } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MONITOR_PATH = join(__dirname, 'monitor.js');

function findClaudeBinary() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'claude';
  }
}

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function launchInteractive(args) {
  const claudeBin = findClaudeBinary();
  const pane = getCurrentPane();
  const config = await loadConfig();
  let retries = 0;

  // Signal handlers registered once, referencing a mutable holder so they
  // always forward to the currently-running Claude process without leaking
  // a new listener on every retry.
  const currentClaude = { ref: null };
  const sigwinchHandler = () => { try { currentClaude.ref?.kill('SIGWINCH'); } catch {} };
  process.on('SIGWINCH', sigwinchHandler);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { currentClaude.ref?.kill(sig); } catch {} });
  }

  // The monitor tracks a specific Claude PID. When we respawn Claude after a
  // rate limit, the old PID is dead and its monitor would self-exit, leaving
  // the new Claude unmonitored. Re-fork a monitor for each spawn and kill the
  // previous one so exactly one monitor tracks the live process.
  let monitorProc = null;

  while (true) {
    const claude = spawn(claudeBin, args, {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
    });
    currentClaude.ref = claude;

    if (claude.pid == null) {
      claude.on('error', (err) => {
        process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
      });
      const exitCode = await new Promise((resolve) => {
        claude.on('exit', (code) => resolve(code ?? 1));
        claude.on('error', () => resolve(1));
      });
      return exitCode;
    }

    // Start a monitor for the freshly-spawned Claude; retire any prior one.
    if (pane) {
      if (monitorProc) { try { monitorProc.kill(); } catch {} }
      monitorProc = fork(MONITOR_PATH, [pane, String(claude.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      monitorProc.unref();
    }

    const exitCode = await new Promise((resolve) => {
      claude.on('exit', (code) => resolve(code ?? 1));
    });

    // If Claude exited cleanly, we're done
    if (exitCode === 0) return 0;

    // Check pane content for rate limit detection
    if (!pane) return exitCode;

    const paneText = await capturePane(pane, 30);

    if (!isRateLimited(paneText, config.customPatterns)) {
      if (isNetworkError(paneText)) {
        retries++;
        if (retries > config.maxRetries) {
          process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
          return exitCode;
        }
        const waitMs = config.networkRetrySeconds * 1000;
        process.stderr.write(`[claude-auto-retry] Network error detected. Restarting in ${config.networkRetrySeconds}s (retry ${retries}/${config.maxRetries})...\n`);
        await new Promise((r) => setTimeout(r, waitMs));
        process.stderr.write(`[claude-auto-retry] Restarting Claude...\n`);
        continue;
      }
      return exitCode;
    }

    // Rate limited — wait and retry
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      return exitCode;
    }

    const rateLimitMsg = findRateLimitMessage(paneText, config.customPatterns) || paneText;
    const parsed = parseResetTime(rateLimitMsg);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    // Print message to the pane
    process.stderr.write(`[claude-auto-retry] Rate limited. Restarting in ${Math.round(waitMs / 1000)}s (retry ${retries}/${config.maxRetries})...\n`);
    await new Promise((r) => setTimeout(r, waitMs));

    // Re-spawn Claude
    process.stderr.write(`[claude-auto-retry] Restarting Claude...\n`);
  }
}

async function launchPrintMode(args) {
  const claudeBin = findClaudeBinary();
  const config = await loadConfig();
  let retries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise((resolve) => {
      const chunks = [];
      const errChunks = [];
      const claude = spawn(claudeBin, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_AUTO_RETRY_ACTIVE: '1' },
      });

      claude.stdout.on('data', (d) => chunks.push(d));
      claude.stderr.on('data', (d) => errChunks.push(d));
      claude.on('error', (err) => {
        resolve({ code: 1, stdout: '', stderr: err.message });
      });
      claude.on('exit', (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errChunks).toString(),
        });
      });
    });

    const combined = result.stdout + result.stderr;

    if (!isRateLimited(combined, config.customPatterns)) {
      // Clean exit — write buffered output
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.code;
    }

    // Rate limited — discard buffer, wait and retry
    retries++;
    if (retries > config.maxRetries) {
      process.stderr.write(`[claude-auto-retry] Max retries (${config.maxRetries}) reached.\n`);
      return 1;
    }

    const parsed = parseResetTime(combined);
    const waitMs = calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);

    process.stderr.write(`[claude-auto-retry] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry ${retries}/${config.maxRetries}...\n`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function createTmuxSession(args) {
  const SESSION_NAME = 'claude';

  // Reuse an existing session if one is already running
  try {
    execFileSync('tmux', ['has-session', '-t', SESSION_NAME], { stdio: 'ignore' });
    const attachResult = spawn('tmux', ['attach-session', '-t', SESSION_NAME], { stdio: 'inherit' });
    return new Promise((resolve) => {
      attachResult.on('exit', (code) => resolve(code ?? 0));
      attachResult.on('error', () => resolve(1));
    });
  } catch {}

  const sessionName = SESSION_NAME;
  const launcherPath = __filename;

  // Build the command to run inside tmux; keep shell alive after Claude exits
  const escapedLauncher = shellEscape(launcherPath);
  const escapedArgs = args.map(a => shellEscape(a)).join(' ');
  const innerCmd = `CLAUDE_AUTO_RETRY_ACTIVE=1 node ${escapedLauncher} ${escapedArgs}; exec $SHELL`;

  // Build env propagation args
  // tmux -e flag requires tmux >= 3.0; for older versions, prefix env exports in the command
  const tmuxVer = getTmuxVersion();
  let newSessionArgs;

  if (tmuxVer >= 3.0) {
    const envArgs = [];
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('TMUX')) continue;
      if (v == null) continue;
      envArgs.push('-e', `${k}=${v}`);
    }
    newSessionArgs = ['new-session', '-d', '-s', sessionName, ...envArgs, innerCmd];
  } else {
    // For tmux < 3.0: export critical env vars inline in the command
    const criticalVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY',
      'NO_PROXY', 'NODE_OPTIONS', 'NVM_DIR', 'NODE_PATH'];
    const exports = criticalVars
      .filter(k => process.env[k])
      .map(k => `export ${k}=${shellEscape(process.env[k])}`)
      .join('; ');
    const fullCmd = exports ? `${exports}; ${innerCmd}` : innerCmd;
    newSessionArgs = ['new-session', '-d', '-s', sessionName, fullCmd];
  }

  try {
    execFileSync('tmux', newSessionArgs);

    // Enable mouse mode on the default window (scroll, copy-mode, pane selection) — tmux >= 2.1
    execFileSync('tmux', buildSetWindowOptionArgs(`${sessionName}:0`, 'mouse', 'on'));
    // Set vi-style copy mode keys for copy-mode navigation
    execFileSync('tmux', buildSetWindowOptionArgs(`${sessionName}:0`, 'mode-keys', 'vi'));

    // Attach to the session
    const attachResult = spawn('tmux', ['attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });

    return new Promise((resolve) => {
      attachResult.on('exit', (code) => resolve(code ?? 0));
      attachResult.on('error', () => resolve(1));
    });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to create tmux session: ${err.message}\n`);
    return 1;
  }
}

// Main
const args = process.argv.slice(2);

let exitCode;
if (isPrintMode(args)) {
  exitCode = await launchPrintMode(args);
} else if (isInsideTmux()) {
  exitCode = await launchInteractive(args);
} else {
  exitCode = await createTmuxSession(args);
}

process.exit(exitCode);
