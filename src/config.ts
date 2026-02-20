import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (bare-metal-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// Poll intervals (milliseconds)
export const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000', 10); // Main message poll interval
export const SCHEDULER_POLL_INTERVAL = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL || '60000',
  10,
); // Scheduler poll interval for cron tasks
export const IPC_POLL_INTERVAL = parseInt(
  process.env.IPC_POLL_INTERVAL || '1000',
  10,
); // IPC poll interval for orchestrator reading agent messages

// Absolute paths for AgentForge directories (allow override via env vars)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = process.env.STORE_DIR
  ? path.resolve(process.env.STORE_DIR)
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = process.env.GROUPS_DIR
  ? path.resolve(process.env.GROUPS_DIR)
  : path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(PROJECT_ROOT, 'data');

// Main group folder name (default group for global operations)
export const MAIN_GROUP_FOLDER = process.env.MAIN_GROUP_FOLDER || 'main';

// Data retention periods
export const MESSAGE_RETENTION_DAYS = parseInt(
  process.env.MESSAGE_RETENTION_DAYS || '90',
  10,
);
export const TASK_LOG_RETENTION_DAYS = parseInt(
  process.env.TASK_LOG_RETENTION_DAYS || '30',
  10,
);

// Agent execution limits
export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
); // 30min default
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep agent process alive after last result
export const MAX_CONCURRENT_PROCESSES = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_PROCESSES || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Telegram configuration (AgentForge is Telegram-only)
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// Email (Gmail) channel configuration
export const GMAIL_USER = process.env.GMAIL_USER || '';
export const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
export const GMAIL_TRIGGER_LABEL =
  process.env.GMAIL_TRIGGER_LABEL || 'AgentForge';
export const GMAIL_TRIGGER_SUBJECT = process.env.GMAIL_TRIGGER_SUBJECT || '';
export const GMAIL_POLL_INTERVAL = parseInt(
  process.env.GMAIL_POLL_INTERVAL || '60000',
  10,
);
export const GMAIL_ALLOWED_SENDERS: string[] = process.env.GMAIL_ALLOWED_SENDERS
  ? process.env.GMAIL_ALLOWED_SENDERS.split(',').map(s => s.trim().toLowerCase())
  : []; // empty = allow all (backward compat)
