/**
 * SQLite database layer for AgentForge.
 *
 * Manages all persistent state:
 * - Chat metadata (discovery, last activity)
 * - Message history (for agent context)
 * - Scheduled tasks and run logs
 * - Router state (polling cursors)
 * - Claude session IDs (per-group conversation continuity)
 * - Registered group definitions
 *
 * Uses better-sqlite3 for synchronous access — all reads and writes
 * are blocking and happen on the main thread alongside the event loop.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MESSAGE_RETENTION_DAYS,
  STORE_DIR,
  TASK_LOG_RETENTION_DAYS,
} from './config.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

/**
 * Create all tables and indexes if they don't exist.
 * Also runs inline migrations for columns added after the initial release,
 * using try/catch to silently skip columns that already exist.
 *
 * @param database - The better-sqlite3 database instance to initialize
 */
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      agent_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS pending_cursors (
      chat_jid TEXT PRIMARY KEY,
      cursor TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.includes('duplicate column name')
    ) {
      throw err;
    }
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.includes('duplicate column name')
    ) {
      throw err;
    }
  }
}

/**
 * Delete old rows from `messages` and `task_run_logs` to bound table growth.
 *
 * Retention windows are controlled by env vars:
 * - `MESSAGE_RETENTION_DAYS`  (default 90) — rows older than this are deleted
 * - `TASK_LOG_RETENTION_DAYS` (default 30) — run log rows older than this are deleted
 *
 * Called automatically at the end of `initDatabase()`.
 */
export function runRetentionSweep(): void {
  const msgResult = db
    .prepare(
      `DELETE FROM messages WHERE timestamp < datetime('now', '-${MESSAGE_RETENTION_DAYS} days')`,
    )
    .run();
  if (msgResult.changes > 0) {
    logger.info(
      { deleted: msgResult.changes, retentionDays: MESSAGE_RETENTION_DAYS },
      'Retention sweep: deleted old messages',
    );
  }

  const logResult = db
    .prepare(
      `DELETE FROM task_run_logs WHERE run_at < datetime('now', '-${TASK_LOG_RETENTION_DAYS} days')`,
    )
    .run();
  if (logResult.changes > 0) {
    logger.info(
      { deleted: logResult.changes, retentionDays: TASK_LOG_RETENTION_DAYS },
      'Retention sweep: deleted old task run logs',
    );
  }
}

/**
 * Initialize the SQLite database at the configured path.
 * Creates the store directory if needed, then runs schema creation and
 * migrates any legacy JSON state files to the database.
 */
export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();

  // Purge rows that exceed the configured retention windows
  runRetentionSweep();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 *
 * Uses MAX() on last_message_time to avoid regressing a newer timestamp
 * if an older event arrives out of order.
 *
 * @param chatJid - The chat's unique identifier
 * @param timestamp - ISO timestamp of the most recent activity in this chat
 * @param name - Optional display name; preserved from previous record if omitted
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/** Shape of a row from the `chats` table. */
export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 * Used by the main group to display available groups for activation.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 * Uses INSERT OR REPLACE to handle duplicate message IDs idempotently.
 *
 * @param msg - The message to store, including sender, content, and timestamps
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Fetch new non-bot messages across multiple chats since a given timestamp.
 *
 * Used by the message loop to detect incoming messages that need agent attention.
 * Filters bot messages using both the `is_bot_message` flag and a content prefix
 * pattern as a backstop for messages inserted before the migration ran.
 *
 * @param jids - List of chat JIDs to query (must be non-empty)
 * @param lastTimestamp - Exclusive lower bound; only messages after this are returned
 * @param botPrefix - The assistant name prefix used to identify outbound bot messages
 * @returns Matching messages and the highest timestamp seen (for cursor advancement)
 */
export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

/**
 * Fetch all non-bot messages in a chat since a given timestamp.
 *
 * Used by `processGroupMessages` to build the full context window for a
 * single group, including messages that arrived between trigger invocations.
 *
 * @param chatJid - The target chat to query
 * @param sinceTimestamp - Exclusive lower bound timestamp
 * @param botPrefix - The assistant name prefix used to filter outbound messages
 * @returns Ordered list of user messages since the given timestamp
 */
export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

/**
 * Create a new scheduled task record.
 *
 * @param task - Task definition; last_run and last_result are omitted on creation
 */
export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

/**
 * Fetch a single task by its ID.
 *
 * @param id - The task ID
 * @returns The task record, or undefined if not found
 */
export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

/**
 * Get all scheduled tasks, ordered by creation time descending.
 * Used to build the tasks snapshot written to each group's IPC directory.
 */
export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

/**
 * Update mutable fields on a scheduled task.
 * Only fields present in `updates` are changed; omitted fields are left as-is.
 * No-ops if `updates` is empty.
 *
 * @param id - The task ID to update
 * @param updates - Partial set of fields to change
 */
export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

/**
 * Permanently delete a task and all its run log entries.
 * Deletes child `task_run_logs` rows first to satisfy the foreign key constraint.
 *
 * @param id - The task ID to delete
 */
export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Fetch all active tasks whose `next_run` is at or before the current time.
 * Results are ordered by `next_run` so the oldest overdue tasks run first.
 */
export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

/**
 * Record a task run outcome and advance the task's schedule.
 *
 * Sets `last_run` to now, `last_result` to the summary, and `next_run` to the
 * computed next fire time. When `nextRun` is null (one-time tasks), the task
 * status is flipped to 'completed' so it won't be picked up again.
 *
 * @param id - The task ID
 * @param nextRun - Next ISO timestamp to run, or null for one-time tasks
 * @param lastResult - Short summary of the run result (truncated if needed)
 */
export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

/**
 * Append a task run log entry for audit and debugging.
 *
 * @param log - The run log record to insert
 */
export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

/**
 * Read a key from the persistent router_state table.
 * Used to restore polling cursors (last_timestamp, last_agent_timestamp) on startup.
 *
 * @param key - The state key to read
 * @returns The stored value string, or undefined if the key doesn't exist
 */
export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * Write or overwrite a key in the persistent router_state table.
 *
 * @param key - The state key to write
 * @param value - The value to store
 */
export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

/**
 * Persist a Claude session ID for a group.
 * Session IDs allow the agent to resume a conversation after a restart.
 *
 * @param groupFolder - The group's folder name (primary key)
 * @param sessionId - The Claude session ID to persist
 */
export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

/**
 * Load all persisted session IDs keyed by group folder name.
 * Called once on startup to restore in-memory session state.
 *
 * @returns Map of groupFolder -> sessionId
 */
export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

/**
 * Fetch a single registered group by its JID.
 *
 * @param jid - The chat JID to look up
 * @returns The group with its JID included, or undefined if not found
 */
export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        agent_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

/**
 * Persist a registered group to the database.
 * Uses INSERT OR REPLACE so this also handles updates to an existing registration.
 *
 * @param jid - The chat JID (primary key)
 * @param group - Group metadata to store
 */
export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.agentConfig ? JSON.stringify(group.agentConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

/**
 * Load all registered groups into a JID-keyed map.
 * Called once on startup to restore in-memory state.
 *
 * @returns Map of chatJid -> RegisteredGroup
 */
export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    agent_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- Pending cursor accessors (two-phase commit for agent dispatch) ---

/**
 * Write a pending cursor for a chat JID.
 * Called before dispatching an agent so a crash during processing can be
 * detected on the next startup via recoverPendingMessages().
 *
 * @param chatJid - The chat JID being processed
 * @param cursor - The timestamp the agent is about to process up to
 */
export function setPendingCursor(chatJid: string, cursor: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO pending_cursors (chat_jid, cursor) VALUES (?, ?)',
  ).run(chatJid, cursor);
}

/**
 * Remove the pending cursor for a chat JID after the agent has confirmed
 * successful delivery. This completes the two-phase commit.
 *
 * @param chatJid - The chat JID whose pending cursor should be cleared
 */
export function clearPendingCursor(chatJid: string): void {
  db.prepare('DELETE FROM pending_cursors WHERE chat_jid = ?').run(chatJid);
}

/**
 * Load all pending cursors as a JID-keyed map.
 * Called on startup to detect crash-in-flight scenarios: any chat JID whose
 * pending cursor is ahead of its last_agent_timestamp was being processed
 * when the previous run crashed and needs to be requeued.
 *
 * @returns Map of chatJid -> pending cursor timestamp
 */
export function getAllPendingCursors(): Record<string, string> {
  const rows = db
    .prepare('SELECT chat_jid, cursor FROM pending_cursors')
    .all() as Array<{ chat_jid: string; cursor: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.chat_jid] = row.cursor;
  }
  return result;
}

// --- JSON migration ---

/**
 * One-time migration from the legacy JSON file store to SQLite.
 *
 * Reads router_state.json, sessions.json, and registered_groups.json from the
 * data directory, imports their contents into the appropriate DB tables, then
 * renames each file to `*.migrated` so the migration doesn't repeat on the
 * next startup. Files that don't exist or can't be parsed are silently skipped.
 */
function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
