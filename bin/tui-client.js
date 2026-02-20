#!/usr/bin/env node
// AgentForge TUI client — connects to the Unix socket and provides a terminal chat UI
// Uses only Node.js built-ins: net, readline, path, os
import net from 'net';
import readline from 'readline';
import os from 'os';
import path from 'path';

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

// ── State ────────────────────────────────────────────────────────────────────
let isThinking = false;
let rl = null;
let socket = null;
let lineBuffer = '';

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
  if (isThinking) {
    process.stdout.write(C.clearLine);
    isThinking = false;
  }
}

function showThinking() {
  process.stdout.write(`${C.clearLine}${C.dim}${C.italic}  thinking…${C.reset}`);
  isThinking = true;
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
  process.stdout.write(`${C.cyan}${C.bold}${assistantName}${C.reset}  ${C.dim}${timestamp()}${C.reset}\n${text}\n\n`);
  showPrompt();
}

function printError(message) {
  clearThinkingLine();
  process.stdout.write(`${C.red}Error: ${message}${C.reset}\n\n`);
  showPrompt();
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
      break;

    case 'typing':
      if (msg.active) {
        showThinking();
      } else {
        clearThinkingLine();
        showPrompt();
      }
      break;

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

// ── Main ─────────────────────────────────────────────────────────────────────
printHeader();

socket = net.connect(socketPath);

socket.on('error', (err) => {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error(`${C.red}AgentForge is not running.${C.reset}`);
    console.error(`Start it with: ${C.bold}sudo systemctl start agentforge.service${C.reset}`);
    process.exit(1);
  } else {
    console.error(`${C.red}Socket error: ${err.message}${C.reset}`);
    process.exit(1);
  }
});

socket.on('connect', () => {
  // Connection established — set up readline and start accepting input
  rl = createReadline();

  rl.on('line', (input) => {
    const text = input.trim();
    if (!text) {
      showPrompt();
      return;
    }
    // Move up one line and reprint the user message with styling
    // (readline already echoed the raw text, so we print styled version below)
    sendMessage(text);
    showThinking();
  });

  rl.on('close', () => {
    // Ctrl+D or readline closed
    cleanup();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  showPrompt();
});

socket.on('data', onSocketData);

socket.on('end', () => {
  clearThinkingLine();
  console.log(`\n${C.dim}Connection closed by server.${C.reset}`);
  cleanup();
  process.exit(0);
});

socket.on('close', (hadError) => {
  if (hadError) {
    // Error handler already handled it
    return;
  }
});
