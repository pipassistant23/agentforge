/**
 * AgentForge Agent Runner
 *
 * Runs as a bare-metal Node.js process. Receives its configuration and initial
 * prompt via stdin (as a JSON blob), then enters a query loop that drives the
 * Claude Agent SDK. Results are streamed back to the host via stdout using
 * sentinel-delimited JSON blocks.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to WORKSPACE_IPC/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: WORKSPACE_IPC/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent result event).
 *   The host's bare-metal-runner parses these pairs in real-time.
 */

import fs from 'fs';
import path from 'path';
import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { initializeQMD, getQMDEnvironment } from './qmd-setup.js';
import { substituteVariables } from './template.js';

/** Full input payload received from the host via stdin. */
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  /** API credentials passed transiently — never written to disk. */
  secrets?: Record<string, string>;
}

/** Structured output block emitted to stdout for each SDK result event. */
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/** Single entry in the Claude sessions index file. */
interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

/** Structure of the sessions-index.json file maintained by the Claude SDK. */
interface SessionsIndex {
  entries: SessionEntry[];
}

/** Shape of a user turn message as expected by the Claude Agent SDK. */
interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Use environment variables for workspace paths (set by bare-metal-runner)
const WORKSPACE_IPC = process.env.WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_GROUP = process.env.WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_EXTRA = process.env.WORKSPACE_EXTRA || '/workspace/extra';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 *
 * Keeps the async iterator alive until `end()` is called, which prevents
 * the SDK from treating the interaction as a single-turn exchange.
 * New messages can be pushed at any time (e.g., from IPC files).
 *
 * The `waiting` callback is a one-shot resolver: when a message is pushed
 * or the stream ends, the pending `await` in the iterator unblocks.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  /** Enqueue a user message for delivery to the SDK. */
  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  /** Signal that no further messages will arrive; the iterator will exit after draining. */
  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Read all stdin until EOF and return it as a string.
 * Used to receive the full ContainerInput JSON from the host process.
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---AGENTFORGE_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AGENTFORGE_OUTPUT_END---';

/**
 * Write a structured output block to stdout.
 * The host's bare-metal-runner scans stdout for these marker pairs and parses
 * the JSON between them, so the format must match exactly.
 *
 * @param output - The result payload to serialize and emit
 */
function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/**
 * Write a debug message to stderr (forwarded to the host logger as debug lines).
 *
 * @param message - The log message to emit
 */
function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Look up a session's summary from the SDK's sessions-index.json.
 * Used to derive a human-readable filename when archiving a conversation.
 *
 * @param sessionId - The Claude session ID to look up
 * @param transcriptPath - Path to the current session's transcript file
 * @returns The session summary string, or null if not found
 */
function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Create a pre-compact hook that archives the full conversation transcript
 * to `conversations/YYYY-MM-DD-{summary}.md` before the SDK compacts it.
 *
 * Compaction discards old messages to stay within context limits; archiving
 * first gives the agent (and user) a permanent record of every exchange.
 * Memory flush (writing key facts to memory.md) happens via a threshold-based
 * message injection in `runQuery`, not here.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Memory flush handled by message count trigger in query loop
    // (injects reminder after ~40 messages to preserve important facts)
    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands the agent runs.
const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/**
 * Create a pre-tool-use hook that strips API secrets from Bash command environments.
 *
 * The SDK needs the secrets to make API calls, but they should never leak into
 * shell commands the agent executes. The hook prepends `unset` to every Bash
 * command, clearing the variables before the command body runs.
 */
function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

/**
 * Convert a session summary to a filesystem-safe filename fragment.
 * Lowercases, replaces non-alphanumeric runs with hyphens, and truncates to 50 chars.
 *
 * @param summary - The human-readable session summary
 * @returns A sanitized string safe for use in a filename
 */
function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Generate a time-based fallback filename when no session summary is available.
 * Format: `conversation-HHMM`
 */
function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

/** A parsed user or assistant message extracted from a JSONL transcript. */
interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Parse a Claude session transcript (JSONL format) into user/assistant message pairs.
 * Only text-type content parts are extracted; tool calls and other content types are ignored.
 *
 * @param content - Raw JSONL transcript file contents
 * @returns Ordered list of parsed messages; empty if the transcript is malformed
 */
function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

/**
 * Format a list of parsed messages as a Markdown conversation archive.
 * Message content is truncated at 2000 characters to keep archive files readable.
 *
 * @param messages - Ordered message list from `parseTranscript`
 * @param title - Optional conversation title (from session summary); defaults to "Conversation"
 * @returns Markdown string ready to write to disk
 */
function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const assistantName = process.env.ASSISTANT_NAME || 'Andy';

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName;
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for the `_close` sentinel file and delete it if present.
 * The host writes this file to signal the agent should exit cleanly.
 *
 * @returns true if the sentinel was found (and removed)
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Read and delete all pending JSON message files from the IPC input directory.
 * Files are sorted before processing to preserve delivery order.
 *
 * @returns Array of message text strings (may be empty)
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Poll the IPC input directory until a message or `_close` sentinel arrives.
 *
 * Used between query loops: after the SDK finishes a query, the runner waits
 * here for the next user message before starting a new query in the same session.
 * The host closes stdin (and later writes _close) to terminate this wait.
 *
 * IMPORTANT: message files are always drained before checking the `_close`
 * sentinel. The filesystem's readdir order is not guaranteed to match creation
 * order, so `_close` may appear before pending message files. Draining first
 * ensures no messages are lost when the host writes both simultaneously.
 *
 * @returns The next message text, or null if `_close` was received
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      // Always drain pending messages before checking _close.
      // If _close arrived alongside message files, the messages must be
      // delivered first; the sentinel is processed only after the queue is empty.
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      if (shouldClose()) {
        resolve(null);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single SDK query and stream results via `writeOutput`.
 *
 * Uses a `MessageStream` (AsyncIterable) to keep `isSingleUserTurn=false`,
 * which allows agent-teams subagents to spawn and complete. While the query
 * is running, a parallel IPC poll loop pipes any new messages into the stream
 * or ends it if `_close` is detected.
 *
 * After the threshold number of messages, a memory flush reminder is injected
 * into the stream so the agent saves key facts before the context window fills.
 *
 * AGENTS.md files are loaded fresh on each query call so configuration changes
 * take effect without a process restart.
 *
 * @param prompt - The initial user message for this query
 * @param sessionId - Claude session ID to resume, or undefined for a new session
 * @param mcpServerPath - Absolute path to the IPC MCP server script
 * @param containerInput - Full input context (group, JID, isMain flags)
 * @param sdkEnv - Environment variables passed to the SDK (includes injected secrets)
 * @param resumeAt - UUID of the last assistant message to resume from, if resuming mid-session
 * @returns Session tracking info and whether `_close` was consumed during the query
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query.
  // Messages get piped into the stream so the agent can respond without a new process.
  // IMPORTANT: drain messages before checking _close so that any message files
  // written alongside the sentinel are not lost due to non-deterministic readdir order.
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let memoryFlushTriggered = false;
  const MEMORY_FLUSH_MESSAGE_THRESHOLD = 40; // Trigger after 40 messages

  // Load and process AGENTS.md files with template variable substitution.
  // Global AGENTS.md applies to all non-main groups (shared identity/behavior).
  const globalAgentsMdPath = path.join(WORKSPACE_GLOBAL, 'AGENTS.md');
  let globalAgentsMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalAgentsMdPath)) {
    const rawContent = fs.readFileSync(globalAgentsMdPath, 'utf-8');
    globalAgentsMd = substituteVariables(rawContent);
  }

  // Group AGENTS.md provides group-specific instructions
  const groupAgentsMdPath = path.join(WORKSPACE_GROUP, 'AGENTS.md');
  let groupAgentsMd: string | undefined;
  if (fs.existsSync(groupAgentsMdPath)) {
    const rawContent = fs.readFileSync(groupAgentsMdPath, 'utf-8');
    groupAgentsMd = substituteVariables(rawContent);
  }

  // Auto-inject BOOTSTRAP.md into system prompt when present.
  // This ensures the agent follows bootstrap instructions without needing to
  // proactively read the file — a Read tool call on the first message is unreliable.
  const bootstrapMdPath = path.join(WORKSPACE_GROUP, 'BOOTSTRAP.md');
  let bootstrapMd: string | undefined;
  if (fs.existsSync(bootstrapMdPath)) {
    const rawContent = fs.readFileSync(bootstrapMdPath, 'utf-8');
    bootstrapMd = substituteVariables(rawContent);
    log('BOOTSTRAP.md detected — injecting into system prompt');
  }

  // Combine global, group AGENTS.md, and optional BOOTSTRAP.md into systemPrompt.
  // Bootstrap goes last so it takes highest contextual priority.
  const systemPromptParts = [globalAgentsMd, groupAgentsMd];
  if (bootstrapMd) {
    systemPromptParts.push(
      `## Active Bootstrap\n\nBOOTSTRAP.md is present and setup is not yet complete. You MUST follow the bootstrap flow described below before responding normally. Once setup is done, delete this file.\n\n${bootstrapMd}`,
    );
  }
  const combinedAgentsMd = systemPromptParts.filter(Boolean).join('\n\n---\n\n');

  // Discover additional directories mounted at extra workspace.
  // These are passed to the SDK for additional context (e.g., shared resources).
  const extraDirs: string[] = [];
  if (fs.existsSync(WORKSPACE_EXTRA)) {
    for (const entry of fs.readdirSync(WORKSPACE_EXTRA)) {
      const fullPath = path.join(WORKSPACE_EXTRA, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: WORKSPACE_GROUP,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: combinedAgentsMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: combinedAgentsMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__agentforge__*',
        'mcp__qmd__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        agentforge: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            AGENTFORGE_CHAT_JID: containerInput.chatJid,
            AGENTFORGE_GROUP_FOLDER: containerInput.groupFolder,
            AGENTFORGE_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        qmd: {
          command: path.join(
            process.cwd(),
            'node_modules',
            '@tobilu',
            'qmd',
            'qmd',
          ),
          args: ['mcp'],
          env: getQMDEnvironment(`/data/qmd/${containerInput.groupFolder}`),
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    // Inject a memory flush reminder after hitting the message threshold (once per query).
    // This prompts the agent to save key facts to memory.md before the context fills.
    if (
      !memoryFlushTriggered &&
      messageCount >= MEMORY_FLUSH_MESSAGE_THRESHOLD
    ) {
      memoryFlushTriggered = true;
      log('Memory flush threshold reached, injecting reminder');
      const todayDate = new Date().toISOString().split('T')[0];
      stream.push(`<internal>Memory flush checkpoint - ${messageCount} messages</internal>

Please save any important information from our conversation so far:

1. Extract key decisions, patterns, or learnings
2. APPEND to /workspace/group/memory/${todayDate}.md
   - IMPORTANT: If the file exists, READ it first and append new content
   - Do NOT overwrite existing entries
3. Update /workspace/group/AGENTS.md only if critical facts emerge
   - Keep AGENTS.md concise (~500 tokens max)
   - Move detail to memory/ topic files

After saving, reply with "Memory updated" or continue our conversation naturally.`);
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

/**
 * Agent runner entry point.
 *
 * 1. Reads ContainerInput JSON from stdin
 * 2. Injects API secrets into a sandboxed SDK environment
 * 3. Initializes QMD memory system for the group
 * 4. Enters the query loop:
 *    - Runs the initial prompt
 *    - Emits a session-update marker after each query completes
 *    - Waits for the next IPC message or `_close` sentinel
 *    - Repeats until closed or an unrecoverable error occurs
 */
async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Initialize QMD memory system for this group
  const qmdDataDir = `/data/qmd/${containerInput.groupFolder}`;
  try {
    await initializeQMD({
      workspaceDir: WORKSPACE_GROUP,
      qmdDataDir,
      groupFolder: containerInput.groupFolder,
    });
  } catch (err) {
    log(
      `QMD initialization failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous runs to avoid premature exit
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt, prepending context for scheduled tasks.
  // Also drain any IPC messages that arrived before the process started.
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat.
  // resumeAt tracks the last assistant message UUID so each successive query
  // can resume from exactly where the previous one left off.
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately without emitting
      // a session-update marker — that would reset the host's idle timer.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit a session-update marker so the host can persist the new session ID
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
