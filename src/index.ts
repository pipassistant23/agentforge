/**
 * AgentForge Orchestrator
 *
 * Central coordinator that:
 * - Connects to Telegram and routes incoming messages to agent processes
 * - Maintains per-group cursors so agents only see new messages
 * - Queues work through GroupQueue to serialize per-group agent invocations
 * - Delegates long-running work to bare-metal Node.js subprocesses
 */
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GMAIL_APP_PASSWORD,
  GMAIL_POLL_INTERVAL,
  GMAIL_TRIGGER_LABEL,
  GMAIL_TRIGGER_SUBJECT,
  GMAIL_USER,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TELEGRAM_BOT_TOKEN,
  TRIGGER_PATTERN,
  SOCKET_ENABLED,
  SOCKET_PATH,
} from './config.js';
import { TelegramChannel, initBotPool } from './channels/telegram.js';
import { EmailChannel } from './channels/email.js';
import { SocketChannel } from './channels/socket.js';
import {
  AgentOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './bare-metal-runner.js';
import {
  getAllChats,
  getAllCursors,
  getAllPendingCursors,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getCursor,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  clearPendingCursor,
  setCursor,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setPendingCursor,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

/**
 * ISO timestamp of the last message seen across all groups.
 * Used to poll only new messages from the DB on each loop tick.
 */
let lastTimestamp = '';

/**
 * Active Claude session IDs keyed by group folder name.
 * Persisted to SQLite so sessions survive restarts.
 */
let sessions: Record<string, string> = {};

/**
 * All groups that have been activated and should receive agent responses.
 * Keyed by the chat JID (e.g. "tg:-1001234567890").
 */
let registeredGroups: Record<string, RegisteredGroup> = {};

/**
 * Per-group cursor tracking the last message that was handed off to an agent.
 * In-memory cache of the agent_cursors SQLite table. The DB is the source of
 * truth; this map is warmed from getAllCursors() on startup and kept in sync
 * via setCursor() on every write.
 */
let lastAgentTimestamp: Record<string, string> = {};

/** Prevents startMessageLoop from being called more than once. */
let messageLoopRunning = false;

/** All connected messaging channels (currently just Telegram). */
const channels: Channel[] = [];

/** Serializes agent invocations so each group has at most one active process. */
const queue = new GroupQueue();

/**
 * Restore persisted state from the SQLite database on startup.
 * Loads timestamps, session IDs, and registered group definitions.
 */
function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  // Load per-group agent cursors from the dedicated agent_cursors table.
  // Each row is an independent UPSERT so a write failure only affects one group.
  lastAgentTimestamp = getAllCursors();
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Persist the message-seen and agent-processed cursors to the DB.
 * Called after advancing either cursor so crashes don't replay messages.
 */
/**
 * Persist the message-seen cursor to the DB.
 * Agent cursors are now written atomically per-group via setCursor(); this
 * function only needs to persist the global lastTimestamp.
 */
function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
}

/**
 * Advance the agent cursor for a single group and persist it atomically.
 * Updates both the in-memory cache and the agent_cursors DB row.
 *
 * @param chatJid - The chat JID whose cursor should advance
 * @param timestamp - The new cursor timestamp
 */
function advanceCursor(chatJid: string, timestamp: string): void {
  lastAgentTimestamp[chatJid] = timestamp;
  setCursor(chatJid, timestamp);
}

/**
 * Activate a chat JID so the agent starts responding to it.
 * Creates the group's workspace directory tree and persists the registration.
 *
 * @param jid - Chat JID (e.g. "tg:-1001234567890")
 * @param group - Group metadata including folder name and trigger pattern
 */
function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 *
 * Filters out internal sync markers and includes both WhatsApp groups
 * and Telegram chats. The main group uses this list to discover and
 * activate new groups via the register_group IPC action.
 */
export function getAvailableGroups(): import('./bare-metal-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__')
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * Handles the full lifecycle of a single agent invocation:
 * 1. Fetches messages since the last agent-processed timestamp
 * 2. Checks trigger requirements for non-main groups
 * 3. Runs the agent process and streams results back to the channel
 * 4. Manages cursor advancement and rollback on error
 *
 * @param chatJid - The JID of the group to process
 * @returns true if processing succeeded (or was a no-op), false if the agent
 *          errored and the caller should retry
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  // Find the channel that owns this JID
  const channel = findChannel(channels, chatJid);
  if (!channel) return true; // No channel for this JID

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Two-phase commit: write a pending cursor before dispatching the agent.
  // If the process crashes between here and the success path below,
  // recoverPendingMessages() will detect the dangling pending cursor on the
  // next startup and requeue the messages.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const newCursor = missedMessages[missedMessages.length - 1].timestamp;
  setPendingCursor(chatJid, newCursor);

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Reset the idle countdown after each chunk of agent output.
   * When the timer fires, stdin is closed to signal the agent to exit
   * rather than waiting indefinitely for more IPC messages.
   */
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing process stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let responseModel = '';
  const agentStartTime = Date.now();

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result: AgentOutput) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          const formatted = formatOutbound(channel, text);
          if (formatted) await channel.sendMessage(chatJid, formatted);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      // Accumulate token usage across all streaming chunks
      if (result.tokensIn) totalTokensIn += result.tokensIn;
      if (result.tokensOut) totalTokensOut += result.tokensOut;
      if (result.model) responseModel = result.model;

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false, {
    tokensIn: totalTokensIn || undefined,
    tokensOut: totalTokensOut || undefined,
    model: responseModel || undefined,
    durationMs: Date.now() - agentStartTime,
  });
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      // Promote cursor and clear pending even on partial-error so we don't replay
      lastAgentTimestamp[chatJid] = newCursor;
      saveState();
      clearPendingCursor(chatJid);
      return true;
    }
    // Agent failed before sending any output — clear the pending cursor and
    // leave lastAgentTimestamp at previousCursor so retries can re-process.
    clearPendingCursor(chatJid);
    logger.warn(
      { group: group.name },
      'Agent error, cleared pending cursor for retry',
    );
    return false;
  }

  // Success: promote pending cursor to the real cursor, then clear pending.
  lastAgentTimestamp[chatJid] = newCursor;
  saveState();
  clearPendingCursor(chatJid);

  return true;
}

/**
 * Prepare context snapshots and invoke the bare-metal agent process.
 *
 * Writes tasks and available-groups snapshots to the group's IPC directory
 * so the agent can read them as files. Wraps the onOutput callback to
 * capture and persist new session IDs as they arrive in the stream.
 *
 * @param group - The registered group configuration
 * @param prompt - XML-formatted message string to send to the agent
 * @param chatJid - Chat JID used to register the spawned process with the queue
 * @param onOutput - Optional streaming callback invoked for each agent output chunk
 * @returns 'success' or 'error' based on process exit status
 */
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for agent to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, processName) =>
        queue.registerProcess(chatJid, proc, processName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent process error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Safety-net polling loop for message delivery to agents.
 *
 * Real-time dispatch is handled by the push path: each channel's onMessage
 * callback calls queue.enqueueMessageCheck() immediately when a message
 * arrives, so agents fire without waiting for a poll tick.
 *
 * This loop runs at a slower cadence (30 s by default) to catch any messages
 * that the push path may have missed (e.g. a crash between store and enqueue).
 *
 * On each tick:
 * 1. Fetches new messages across all registered groups
 * 2. Advances the global "seen" cursor immediately to prevent double-processing
 * 3. For each group with new messages, either pipes them to an already-running
 *    process (via GroupQueue.sendMessage) or enqueues a new processGroupMessages call
 *
 * Non-trigger messages accumulate in the DB and are included as context when
 * a trigger eventually arrives, giving the agent full conversation history.
 */
async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`AgentForge running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active process',
            );
            // Write pending cursor before advancing the confirmed cursor.
            // The active process is responsible for clearing it on success;
            // if it crashes, recoverPendingMessages() will requeue from the
            // last confirmed lastAgentTimestamp.
            const pipedCursor =
              messagesToSend[messagesToSend.length - 1].timestamp;
            setPendingCursor(chatJid, pipedCursor);
            lastAgentTimestamp[chatJid] = pipedCursor;
            saveState();
            // Show typing indicator while the process processes the piped message
            const channel = findChannel(channels, chatJid);
            channel?.setTyping?.(chatJid, true);
          } else {
            // No active process — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 *
 * Two cases are handled:
 *
 * 1. Normal unprocessed messages: messages that arrived after the last known
 *    agent cursor (lastAgentTimestamp) with no pending cursor — the agent
 *    simply never ran for them yet.
 *
 * 2. Crash-in-flight (two-phase commit): a pending_cursors row exists and is
 *    ahead of lastAgentTimestamp. This means the previous run wrote a pending
 *    cursor but crashed before the agent confirmed delivery. The pending cursor
 *    is cleared so processGroupMessages will re-process from lastAgentTimestamp.
 */
function recoverPendingMessages(): void {
  const pendingCursors = getAllPendingCursors();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Case 2: crash-in-flight — a pending cursor exists from a previous run
    // that never completed. Clear it so the group reprocesses from the last
    // confirmed agent cursor.
    if (pendingCursors[chatJid]) {
      logger.warn(
        { group: group.name, pendingCursor: pendingCursors[chatJid] },
        'Recovery: found dangling pending cursor (crash-in-flight), clearing and requeuing',
      );
      clearPendingCursor(chatJid);
    }

    // Case 1 (and also requeue for Case 2): check for messages since last
    // confirmed agent cursor.
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Application entry point.
 *
 * Initializes the database, restores state, connects to Telegram,
 * then starts the IPC watcher, task scheduler, and message loop.
 */
async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      // Advance the global seen cursor so the message loop's safety-net poll
      // doesn't re-discover and re-dispatch messages already handled here.
      // Without this, the loop finds the message (lastTimestamp not yet advanced),
      // sees an active agent process, pipes the message again, and emits a
      // spurious typing indicator to the client.
      if (msg.timestamp > lastTimestamp) {
        lastTimestamp = msg.timestamp;
        saveState();
      }
      // Push-trigger: immediately enqueue a message check so the agent
      // dispatches without waiting for the next polling loop tick.
      queue.enqueueMessageCheck(chatJid);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect Telegram channel
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is required - AgentForge is Telegram-only',
    );
  }

  const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
  channels.push(telegram);
  await telegram.connect();

  // Initialize email channel if configured
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const email = new EmailChannel({
        gmailUser: GMAIL_USER,
        appPassword: GMAIL_APP_PASSWORD,
        triggerLabel: GMAIL_TRIGGER_LABEL,
        triggerSubject: GMAIL_TRIGGER_SUBJECT || undefined,
        pollIntervalMs: GMAIL_POLL_INTERVAL,
        ...channelOpts,
        registerGroup,
      });
      channels.push(email);
      await email.connect();
      logger.info('Email channel connected');
    } catch (err) {
      logger.error(
        { err },
        'Failed to connect email channel — continuing without it',
      );
    }
  }

  // Initialize socket channel for local client connections (TUI, web, etc.)
  if (SOCKET_ENABLED) {
    try {
      const socket = new SocketChannel({
        ...channelOpts,
        registerGroup,
        groupFolder: MAIN_GROUP_FOLDER,
        assistantName: ASSISTANT_NAME,
      });
      channels.push(socket);
      await socket.connect();
      logger.info({ path: SOCKET_PATH }, 'Socket channel listening');
    } catch (err) {
      logger.error(
        { err },
        'Failed to connect socket channel — continuing without it',
      );
    }
  }

  // Initialize bot pool for agent swarms
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, groupFolder) =>
      queue.registerProcess(groupJid, proc, processName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: () => Promise.resolve(), // No-op: Telegram syncs automatically
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    refreshTasksSnapshot: (groupFolder) => {
      const isMain = groupFolder === MAIN_GROUP_FOLDER;
      const tasks = getAllTasks();
      writeTasksSnapshot(
        groupFolder,
        isMain,
        tasks.map((t) => ({
          id: t.id,
          groupFolder: t.group_folder,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        })),
      );
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start AgentForge');
    process.exit(1);
  });
}
