#!/usr/bin/env node
// AgentForge TUI client — connects to the Unix socket and provides a terminal chat UI
// Uses only Node.js built-ins: net, readline, path, os, child_process
import net from 'net';
import readline from 'readline';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

// ── ANSI color helpers ───────────────────────────────────────────────────────
const C = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  green:     '\x1b[32m',
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  red:       '\x1b[31m',
  clearLine: '\x1b[2K\r',
};

function timestamp() {
  const now = new Date();
  return now.toTimeString().slice(0, 5); // HH:MM
}

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let socketPath = path.join(os.homedir(), '.agentforge.sock');
let assistantName = 'AgentForge';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--socket' && args[i + 1]) {
    socketPath = args[++i];
  } else if (args[i] === '--name' && args[i + 1]) {
    assistantName = args[++i];
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── State ────────────────────────────────────────────────────────────────────
let isThinking = false;
let spinnerInterval = null;
let spinnerFrame = 0;
let workStartTime = null;
let sessionStartTime = null;
let rl = null;
let socket = null;
let lineBuffer = '';
let streamBuffer = '';     // accumulated chunks for current streaming response
let streamStarted = false; // whether we've printed the streaming header yet
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

// ── Readline setup ───────────────────────────────────────────────────────────
function createReadline() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}> ${C.reset}`,
    terminal: true,
  });
  return rl;
}

function showPrompt() {
  if (rl) {
    rl.prompt(true);
  }
}

function clearThinkingLine() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
  if (isThinking) {
    process.stdout.write(C.clearLine);
    isThinking = false;
  }
}

function showThinking() {
  if (spinnerInterval) return; // already running
  workStartTime = Date.now();
  spinnerFrame = 0;
  isThinking = true;
  spinnerInterval = setInterval(() => {
    const elapsed = ((Date.now() - workStartTime) / 1000).toFixed(1);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    spinnerFrame++;
    process.stdout.write(
      `${C.clearLine}${C.cyan}${frame}${C.reset}${C.dim} thinking… ${elapsed}s${C.reset}`,
    );
  }, 80);
}

// ── Print formatted messages ─────────────────────────────────────────────────
function printHeader() {
  const line = '─'.repeat(50);
  console.log(`${C.cyan}${line}${C.reset}`);
  console.log(`  ${C.bold}${C.cyan}${assistantName}${C.reset}  ${C.dim}local session${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}`);
  console.log(`${C.dim}Type a message and press Enter. Ctrl+C to quit.${C.reset}`);
  console.log('');
}

function printUserMessage(text) {
  // Already echoed by readline — just show the dim timestamp prefix above
  // We don't re-print the text; readline handles that.
  // But we do print a styled "You HH:MM" header before the prompt line.
  // Since readline echoes as you type, we instead print user label after submit.
  process.stdout.write(`\n${C.dim}You  ${timestamp()}${C.reset}\n${C.dim}${text}${C.reset}\n\n`);
}

function printAssistantMessage(text) {
  clearThinkingLine();
  process.stdout.write(`${C.cyan}${C.bold}${assistantName}${C.reset}  ${C.dim}${timestamp()}${C.reset}\n${renderMarkdown(text)}\n\n`);
  showPrompt();
}

function printError(message) {
  clearThinkingLine();
  process.stdout.write(`${C.red}Error: ${message}${C.reset}\n\n`);
  showPrompt();
}

// ── Markdown rendering ───────────────────────────────────────────────────────
function renderMarkdown(text) {
  // Code blocks (``` ... ```) — render before inline to avoid conflicts
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    const lines = code.trimEnd().split('\n');
    const formatted = lines.map(l => `  ${C.dim}${l}${C.reset}`).join('\n');
    return `\n${formatted}\n`;
  });

  // Inline code (`code`)
  text = text.replace(/`([^`\n]+)`/g, `${C.yellow}$1${C.reset}`);

  // Bold (**text** or __text__)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, `${C.bold}$1${C.reset}`);
  text = text.replace(/__([^_\n]+)__/g, `${C.bold}$1${C.reset}`);

  // Italic (*text* or _text_) — careful not to match list bullets
  text = text.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, `${C.italic}$1${C.reset}`);
  text = text.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, `${C.italic}$1${C.reset}`);

  // Headers (## Heading) → bold cyan
  text = text.replace(/^(#{1,3})\s+(.+)$/gm, `${C.cyan}${C.bold}$2${C.reset}`);

  // Bullet points (- item or * item at line start) → • item
  text = text.replace(/^[ \t]*[-*]\s+/gm, `  ${C.dim}•${C.reset} `);

  // Numbered list (1. item) → keep numbering but dim the dot
  text = text.replace(/^(\d+)\.\s+/gm, `  $1${C.dim}.${C.reset} `);

  return text;
}

// ── Desktop notifications ────────────────────────────────────────────────────
function sendDesktopNotification(text) {
  // Only notify if terminal is not in focus (process is in background)
  // Simple heuristic: always send, user can disable system-side
  try {
    const preview = text.length > 100 ? text.slice(0, 97) + '...' : text;
    spawn('notify-send', [assistantName, preview], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // notify-send not available — ignore
  }
}

// ── History display ──────────────────────────────────────────────────────────
function printHistory(messages) {
  if (!messages || messages.length === 0) return;
  const sep = '─'.repeat(50);
  process.stdout.write(`${C.dim}${sep}${C.reset}\n`);
  process.stdout.write(`${C.dim}  Recent conversation history${C.reset}\n`);
  process.stdout.write(`${C.dim}${sep}${C.reset}\n\n`);

  for (const msg of messages) {
    const ts = msg.timestamp ? new Date(msg.timestamp).toTimeString().slice(0, 5) : '';
    if (msg.role === 'user') {
      process.stdout.write(`${C.dim}You  ${ts}${C.reset}\n${C.dim}${msg.content}${C.reset}\n\n`);
    } else {
      process.stdout.write(`${C.cyan}${C.bold}${assistantName}${C.reset}  ${C.dim}${ts}${C.reset}\n${renderMarkdown(msg.content)}\n\n`);
    }
  }

  process.stdout.write(`${C.dim}${sep}${C.reset}\n`);
  process.stdout.write(`${C.dim}  New session${C.reset}\n`);
  process.stdout.write(`${C.dim}${sep}${C.reset}\n\n`);
}

// ── Uptime formatting ────────────────────────────────────────────────────────
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── Slash commands ────────────────────────────────────────────────────────────
function handleSlashCommand(input) {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen + move to top
      printHeader();
      showPrompt();
      break;

    case 'status': {
      if (!socket || socket.destroyed) {
        printError('Not connected.');
        return;
      }
      socket.write(JSON.stringify({ type: 'status' }) + '\n');
      break;
    }

    case 'help':
      process.stdout.write(
        `\n${C.dim}Commands:${C.reset}\n` +
        `  ${C.cyan}/clear${C.reset}   Clear the screen\n` +
        `  ${C.cyan}/status${C.reset}  Show service status\n` +
        `  ${C.cyan}/help${C.reset}    Show this help\n\n`
      );
      showPrompt();
      break;

    default:
      printError(`Unknown command: /${cmd}. Type /help for available commands.`);
      break;
  }
}

// ── Socket NDJSON parser ─────────────────────────────────────────────────────
function handleServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.trim());
  } catch {
    // Ignore non-JSON lines
    return;
  }

  switch (msg.type) {
    case 'response':
      clearThinkingLine();
      printAssistantMessage(msg.text || '');
      sendDesktopNotification(msg.text || '');
      break;

    case 'chunk':
      clearThinkingLine();
      if (!streamStarted) {
        // Print the assistant header once at the start of streaming
        process.stdout.write(`${C.cyan}${C.bold}${assistantName}${C.reset}  ${C.dim}${timestamp()}${C.reset}\n`);
        streamStarted = true;
      }
      // Write chunk text inline (no newline — chunks come in as they stream)
      process.stdout.write(renderMarkdown(msg.text || ''));
      streamBuffer += msg.text || '';
      break;

    case 'response_end': {
      if (streamStarted) {
        sendDesktopNotification(streamBuffer);
        process.stdout.write('\n');
        // Stats line — show duration, token counts, model if provided
        const statParts = [];
        if (msg.durationMs !== undefined) statParts.push(`${(msg.durationMs / 1000).toFixed(1)}s`);
        if (msg.tokensIn !== undefined) statParts.push(`${msg.tokensIn} in`);
        if (msg.tokensOut !== undefined) statParts.push(`${msg.tokensOut} out`);
        if (msg.model) statParts.push(msg.model);
        if (statParts.length > 0) {
          process.stdout.write(`${C.dim}  ${statParts.join(' · ')}${C.reset}\n`);
        }
        process.stdout.write('\n');
        streamBuffer = '';
        streamStarted = false;
      }
      showPrompt();
      break;
    }

    case 'typing':
      if (msg.active) {
        showThinking();
      } else {
        // If streaming was active and response_end wasn't sent, finalize
        if (streamStarted) {
          process.stdout.write('\n\n');
          streamBuffer = '';
          streamStarted = false;
        }
        clearThinkingLine();
        showPrompt();
      }
      break;

    case 'history':
      printHistory(msg.messages);
      showPrompt();
      break;

    case 'status': {
      const uptime = msg.uptime !== undefined ? formatUptime(Number(msg.uptime)) : 'unknown';
      const session = sessionStartTime ? formatUptime(Math.floor((Date.now() - sessionStartTime) / 1000)) : 'unknown';
      process.stdout.write(
        `\n${C.cyan}${C.bold}Service Status${C.reset}\n` +
        `  Service uptime:  ${uptime}\n` +
        `  Session time:    ${session}\n` +
        `  Connections:     ${msg.connections}\n\n`,
      );
      showPrompt();
      break;
    }

    case 'pong':
      // Ignore pongs silently
      break;

    case 'error':
      printError(msg.message || 'Unknown error from server');
      break;

    default:
      // Unknown message type — ignore
      break;
  }
}

function onSocketData(chunk) {
  lineBuffer += chunk.toString();
  const lines = lineBuffer.split('\n');
  // Keep the last (possibly incomplete) segment
  lineBuffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) {
      handleServerMessage(line);
    }
  }
}

// ── Send message to socket ───────────────────────────────────────────────────
function sendMessage(text) {
  if (!socket || socket.destroyed) {
    printError('Not connected to AgentForge service.');
    return;
  }
  const payload = JSON.stringify({ type: 'message', text }) + '\n';
  socket.write(payload);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
function cleanup() {
  clearThinkingLine();
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
  if (rl) {
    rl.close();
  }
  process.stdout.write('\n');
}

// ── Readline setup ───────────────────────────────────────────────────────────
function setupReadline() {
  rl = createReadline();

  rl.on('line', (input) => {
    const text = input.trim();
    if (!text) {
      showPrompt();
      return;
    }
    // Handle slash commands
    if (text.startsWith('/')) {
      handleSlashCommand(text);
      return;
    }
    sendMessage(text);
    showThinking();
  });

  rl.on('close', () => {
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  showPrompt();
}

// ── Auto-reconnect ───────────────────────────────────────────────────────────
function handleDisconnect() {
  // Reset streaming state
  if (streamStarted) {
    process.stdout.write('\n');
    streamStarted = false;
    streamBuffer = '';
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    process.stdout.write(`\n${C.red}Connection lost. Could not reconnect.${C.reset}\n`);
    cleanup();
    process.exit(1);
  }

  reconnectAttempts++;
  process.stdout.write(`\n${C.dim}Connection lost. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})${C.reset}\n`);
  setTimeout(connect, RECONNECT_DELAY_MS);
}

function connect() {
  socket = net.connect(socketPath);

  socket.on('error', (err) => {
    if (reconnectAttempts === 0 && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
      console.error(`${C.red}AgentForge is not running.${C.reset}`);
      console.error(`Start it with: ${C.bold}sudo systemctl start agentforge.service${C.reset}`);
      process.exit(1);
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      handleDisconnect();
    } else {
      console.error(`${C.red}Socket error: ${err.message}${C.reset}`);
      handleDisconnect();
    }
  });

  socket.on('connect', () => {
    reconnectAttempts = 0; // reset on successful connect
    if (rl) {
      // Reconnected — just show a message
      process.stdout.write(`\n${C.dim}Reconnected.${C.reset}\n\n`);
      showPrompt();
    } else {
      // First connection — start session timer and set up readline
      sessionStartTime = Date.now();
      setupReadline();
    }
  });

  socket.on('data', onSocketData);

  socket.on('end', () => {
    clearThinkingLine();
    handleDisconnect();
  });

  socket.on('close', (hadError) => {
    if (hadError) return;
    handleDisconnect();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
printHeader();
connect();
