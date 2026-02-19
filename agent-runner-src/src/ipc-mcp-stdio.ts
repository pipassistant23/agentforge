/**
 * Stdio MCP Server for AgentForge
 *
 * Runs as a standalone subprocess that the Claude Agent SDK spawns for each
 * agent session. Exposes AgentForge-specific tools to the agent over the
 * Model Context Protocol (MCP) stdio transport.
 *
 * Communication with the host orchestrator happens entirely through the
 * file-based IPC system: each tool writes a JSON file to the group's
 * IPC directory, which the host's IPC watcher picks up and acts on.
 * This design means the MCP server itself is stateless — it never needs
 * a network connection back to the host, and sub-agents spawned by agent
 * swarms inherit this server automatically.
 *
 * Context is read from environment variables set by the agent runner:
 *   WORKSPACE_IPC          - Base IPC directory for this group
 *   AGENTFORGE_CHAT_JID    - JID of the chat this agent is serving
 *   AGENTFORGE_GROUP_FOLDER - Folder name of the group
 *   AGENTFORGE_IS_MAIN     - '1' if this is the main orchestrator group
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

// Use environment variable for workspace IPC path (set by bare-metal-runner)
const IPC_DIR = process.env.WORKSPACE_IPC || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.AGENTFORGE_CHAT_JID!;
const groupFolder = process.env.AGENTFORGE_GROUP_FOLDER!;
const isMain = process.env.AGENTFORGE_IS_MAIN === '1';

/**
 * Write a JSON payload atomically to an IPC directory.
 *
 * Uses a write-then-rename pattern: the file is first written to a `.tmp`
 * path, then renamed to its final name. This prevents the host's IPC watcher
 * from reading a partially-written file.
 *
 * @param dir - Target directory (created if it doesn't exist)
 * @param data - The payload to serialize as JSON
 * @returns The filename (not path) of the written file
 */
function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'agentforge',
  version: '1.0.0',
});

/**
 * send_message tool
 *
 * Delivers a message to the group chat immediately, without waiting for the
 * agent to finish its current response. Useful for progress updates in long
 * tasks or when the agent wants to send multiple separate messages.
 *
 * For scheduled tasks, this is the only way to communicate with the user —
 * the task agent's final result text is NOT automatically forwarded.
 *
 * When a `sender` identity is provided and the Telegram bot pool is configured,
 * the message is sent from a dedicated pool bot, giving sub-agents their own
 * named identity in the chat (e.g., "Researcher", "Coder").
 */
server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

/**
 * schedule_task tool
 *
 * Creates a recurring or one-time scheduled task. The task runs as a full
 * agent invocation with access to all tools, at the specified schedule.
 *
 * Context modes:
 * - 'group': Agent runs with access to the group's conversation history
 * - 'isolated': Agent starts fresh with no conversation history; the prompt
 *   should contain all necessary context
 *
 * Authorization: non-main groups can only schedule tasks for themselves.
 * The main group can schedule tasks for any registered group via target_group_jid.
 *
 * Validates the schedule_value before writing the IPC file so the agent gets
 * immediate feedback on invalid expressions rather than a silent failure.
 */
server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC — gives the agent immediate feedback
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves; main can target any group
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

/**
 * list_tasks tool
 *
 * Reads the pre-written current_tasks.json snapshot from the IPC directory.
 * The snapshot is written by the host before each agent invocation, so it
 * reflects the state at the time the agent was started — not necessarily live.
 *
 * Main group sees all tasks; other groups see only their own.
 */
server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      // The snapshot is pre-filtered by the host, but apply an extra filter for safety
      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

/**
 * pause_task tool
 *
 * Writes a pause_task IPC request for the host to act on.
 * The host enforces authorization (non-main groups can only pause their own tasks).
 */
server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

/**
 * resume_task tool
 *
 * Writes a resume_task IPC request for the host to act on.
 * The host enforces authorization (non-main groups can only resume their own tasks).
 */
server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

/**
 * cancel_task tool
 *
 * Writes a cancel_task IPC request for the host to act on.
 * Cancellation permanently deletes the task and its run logs.
 * The host enforces authorization (non-main groups can only cancel their own tasks).
 */
server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

/**
 * register_group tool
 *
 * Writes a register_group IPC request that activates a chat JID so the agent
 * starts receiving and responding to messages from it. Main group only.
 *
 * The available groups list (available_groups.json) is written by the host
 * before each agent invocation and contains the JIDs of all known chats.
 */
server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z
      .string()
      .describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@YourBot")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport — the SDK connects via stdin/stdout
const transport = new StdioServerTransport();
await server.connect(transport);
