# AgentForge API Reference

This document describes the key APIs, interfaces, and extension points in AgentForge.

## Table of Contents

- [Core Exports](#core-exports)
- [Router API](#router-api)
- [Channel Interface](#channel-interface)
- [Agent Execution](#agent-execution)
- [IPC Task API](#ipc-task-api)
- [Database API](#database-api)
- [Extension Points](#extension-points)

## Core Exports

AgentForge exports the main orchestrator functions from `src/index.ts`:

### `getAvailableGroups(): AvailableGroup[]`

Returns a list of all available groups/chats, ordered by most recent activity.

```typescript
interface AvailableGroup {
  jid: string; // Chat identifier (e.g., "tg:123456789")
  name: string; // Display name
  lastActivity: string; // ISO timestamp of last message
  isRegistered: boolean; // Whether this group is registered with AgentForge
}
```

**Usage:** Agents use this to discover and activate new groups.

### `formatMessages(messages: NewMessage[]): string`

Converts an array of messages into XML format for agent processing.

```typescript
interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string; // User ID/identifier
  sender_name: string; // Display name
  content: string; // Message text
  timestamp: string; // ISO timestamp
  is_from_me?: boolean; // Whether sent by the bot
  is_bot_message?: boolean; // Whether sent by another bot
}
```

**Output format:**

```xml
<messages>
<message sender="Alice" time="2024-01-01T12:00:00.000Z">Hello there</message>
<message sender="Bob" time="2024-01-01T12:00:05.000Z">Hi Alice</message>
</messages>
```

---

## Router API

The router handles message formatting and channel selection. Located in `src/router.ts`.

### `formatOutbound(channel: Channel, rawText: string): string`

Formats outbound text for a specific channel and strips internal processing tags.

```typescript
// Strips <internal>...</internal> blocks used for agent reasoning
const text = `Here's my response <internal>Need to verify this</internal>`;
const formatted = formatOutbound(channel, text);
// Result: "Here's my response"
```

Internal tags are stripped because:

- They contain agent reasoning meant for internal use only
- They should never be sent to users
- Different AI models may format reasoning differently

### `findChannel(channels: Channel[], jid: string): Channel | undefined`

Locates the appropriate channel for a given JID.

```typescript
const channel = findChannel(channels, 'tg:123456789');
if (channel && channel.isConnected()) {
  await channel.sendMessage(jid, 'Hello');
}
```

### `routeOutbound(channels: Channel[], jid: string, text: string): Promise<void>`

Routes an outbound message to the correct channel.

```typescript
await routeOutbound(channels, 'tg:123456789', 'Response from agent');
```

Throws `Error` if no channel owns the JID.

### `escapeXml(s: string): string`

Escapes XML special characters in message content.

```typescript
escapeXml('Price: $50 < $75 & available');
// Result: "Price: $50 &lt; $75 &amp; available"
```

---

## Channel Interface

The `Channel` interface in `src/types.ts` defines how to integrate new messaging platforms.

```typescript
interface Channel {
  name: string;
  prefixAssistantName?: boolean; // Default: true

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Message sending
  sendMessage(jid: string, text: string): Promise<void>;

  // JID routing
  ownsJid(jid: string): boolean;

  // Optional: typing indicator
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

### Example: Custom Channel Implementation

```typescript
export class MyChannel implements Channel {
  name = 'my-platform';
  prefixAssistantName = false;

  async connect(): Promise<void> {
    // Initialize connection
    console.log('Connected to My Platform');
  }

  async disconnect(): Promise<void> {
    // Cleanup
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Return true if this channel handles this JID format
    return jid.startsWith('mp:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const id = jid.replace(/^mp:/, '');
    // Send via your platform's API
    await this.api.send(id, text);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const id = jid.replace(/^mp:/, '');
    if (isTyping) {
      await this.api.typing(id);
    }
  }
}
```

### Channel Callbacks

Channels notify the orchestrator of events via callbacks:

```typescript
interface ChannelOptions {
  // Called when a message arrives
  onMessage(chatJid: string, message: NewMessage): void;

  // Called when chat metadata is discovered
  onChatMetadata(chatJid: string, timestamp: string, name?: string): void;

  // Provides current registered groups for auth/filtering
  registeredGroups(): Record<string, RegisteredGroup>;
}
```

---

## Agent Execution

AgentForge executes agents as baremetal Node.js processes. See `src/bare-metal-runner.ts`.

### `runContainerAgent(group, input, onProcess, onOutput): Promise<AgentOutput>`

Spawns an agent process for a group and streams its output.

```typescript
interface AgentInput {
  prompt: string; // User messages formatted as XML
  sessionId?: string; // Claude session ID for continuity
  groupFolder: string; // Which group's workspace to use
  chatJid: string; // Which chat this is for
  isMain: boolean; // Whether this is the main group
  isScheduledTask?: boolean;
}

interface AgentOutput {
  status: 'success' | 'error';
  result: string | null; // Agent's response (may be null for session updates)
  newSessionId?: string; // Updated session ID if changed
  error?: string; // Error message if status='error'
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}
```

**Example:**

```typescript
const output = await runContainerAgent(
  group,
  {
    prompt: '<messages>...(XML formatted messages)...</messages>',
    sessionId: 'session-xyz',
    groupFolder: 'main',
    chatJid: 'tg:123456789',
    isMain: true,
  },
  (proc, name) => {
    console.log(`Process ${name} started with PID ${proc.pid}`);
  },
  async (result) => {
    if (result.result) {
      console.log('Agent said:', result.result);
    }
    if (result.newSessionId) {
      console.log('Session updated to:', result.newSessionId);
    }
  },
);

if (output.status === 'error') {
  console.error('Agent error:', output.error);
}
```

### Process Environment Variables

When spawning agent processes, AgentForge sets:

```javascript
{
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  AGENTFORGE_CHAT_JID: 'tg:123456789',
  AGENTFORGE_GROUP_FOLDER: 'main',
  AGENTFORGE_IS_MAIN: '1' || '0',
  WORKSPACE_IPC: '/data/ipc/main',
  WORKSPACE_GROUP: '/groups/main',
  WORKSPACE_GLOBAL: '/groups/global',
}
```

### Agent Output Markers

AgentForge parses streaming output using markers:

```
---AGENTFORGE_OUTPUT_START---
{"status":"success","result":"Hello!"}
---AGENTFORGE_OUTPUT_END---
```

The agent can emit multiple markers during execution, and each is processed immediately.

---

## IPC Task API

Agents communicate with the orchestrator via JSON files in the IPC directory. See `src/ipc.ts`.

### Message Files

Write to `WORKSPACE_IPC/messages/{random}.json`:

```typescript
interface IpcMessage {
  type: 'message';
  chatJid: string; // Target chat (e.g., 'tg:123456789')
  text: string; // Message to send
  sender?: string; // Optional: which bot/role to send as (Telegram pool only)
}
```

**Example:**

```javascript
const msg = {
  type: 'message',
  chatJid: 'tg:123456789',
  text: 'Hello from agent!',
  sender: 'Research Assistant', // Will use bot pool if available
};
fs.writeFileSync(
  path.join(process.env.WORKSPACE_IPC, 'messages', `msg-${Date.now()}.json`),
  JSON.stringify(msg),
);
```

### Task Files

Write to `WORKSPACE_IPC/tasks/{random}.json`:

#### Schedule Task

```typescript
interface IpcScheduleTask {
  type: 'schedule_task';
  prompt: string;
  targetJid: string; // Which group to run the task for
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string; // Cron expression, milliseconds, or ISO timestamp
  context_mode?: 'group' | 'isolated'; // 'group' shares session, 'isolated' uses new session
}
```

**Examples:**

```javascript
// Run daily at 9 AM
{
  type: 'schedule_task',
  prompt: 'Check emails and summarize',
  targetJid: 'tg:123456789',
  schedule_type: 'cron',
  schedule_value: '0 9 * * *',
  context_mode: 'group'
}

// Run every 30 minutes
{
  type: 'schedule_task',
  prompt: 'Check status',
  targetJid: 'tg:123456789',
  schedule_type: 'interval',
  schedule_value: '1800000'
}

// Run once at specific time
{
  type: 'schedule_task',
  prompt: 'Send reminder',
  targetJid: 'tg:123456789',
  schedule_type: 'once',
  schedule_value: '2024-12-25T15:00:00Z'
}
```

#### Pause Task

```typescript
{
  type: 'pause_task',
  taskId: 'task-123456'
}
```

#### Resume Task

```typescript
{
  type: 'resume_task',
  taskId: 'task-123456'
}
```

#### Cancel Task

```typescript
{
  type: 'cancel_task',
  taskId: 'task-123456'
}
```

#### Register Group

Main group only:

```typescript
{
  type: 'register_group',
  jid: 'tg:987654321',
  name: 'My New Group',
  folder: 'my-new-group',
  trigger: '@Assistant',
  requiresTrigger: true,
  agentConfig: { timeout: 60000 }
}
```

#### Refresh Groups

Main group only:

```typescript
{
  type: 'refresh_groups';
}
```

### Authorization

- **Main group** (`groups/main/`) can:
  - Send messages to any registered group
  - Schedule tasks for any group
  - Register new groups
  - Pause/resume/cancel any task

- **Sub-groups** can only:
  - Send messages to their own group
  - Schedule tasks for themselves
  - Pause/resume/cancel their own tasks

Unauthorized attempts are logged and silently ignored.

---

## Database API

AgentForge uses SQLite via `better-sqlite3`. See `src/db.ts` for low-level operations.

### Messages

```typescript
function storeMessage(msg: NewMessage): void;
function getNewMessages(
  jids: string[],
  since: string,
  excludeSender: string,
): { messages: NewMessage[]; newTimestamp: string };
function getMessagesSince(
  jid: string,
  since: string,
  excludeSender: string,
): NewMessage[];
```

### Scheduled Tasks

```typescript
function createTask(task: ScheduledTask): void;
function updateTask(id: string, updates: Partial<ScheduledTask>): void;
function deleteTask(id: string): void;
function getTaskById(id: string): ScheduledTask | undefined;
function getAllTasks(): ScheduledTask[];
function getDueTasks(): ScheduledTask[];
```

### Sessions

```typescript
function setSession(groupFolder: string, sessionId: string): void;
function getAllSessions(): Record<string, string>;
```

### Registered Groups

```typescript
function setRegisteredGroup(jid: string, group: RegisteredGroup): void;
function getAllRegisteredGroups(): Record<string, RegisteredGroup>;
```

### Router State

```typescript
function getRouterState(key: string): string;
function setRouterState(key: string, value: string): void;
```

---

## Extension Points

### Adding a New Channel

1. Implement the `Channel` interface in a new file
2. Initialize it in `src/index.ts` in the `main()` function
3. Push to the `channels` array

```typescript
// In src/index.ts
const myChannel = new MyChannel(config);
channels.push(myChannel);
await myChannel.connect();
```

### Custom Agent Execution

To use a different agent runtime (instead of baremetal Node.js):

1. Create a new function similar to `runContainerAgent` in `src/bare-metal-runner.ts`
2. It must:
   - Accept `AgentInput` and return `AgentOutput`
   - Support streaming output via callbacks
   - Handle timeouts and process lifecycle
3. Call it from `src/index.ts` in the `runAgent()` function

### Custom Message Formatting

To change how messages are formatted for agents:

1. Modify `formatMessages()` in `src/router.ts`
2. Update the format string in `src/index.ts` where it's called
3. Update agent runner to parse the new format

### Task Scheduling

To add new schedule types (beyond cron/interval/once):

1. Add the type to `ScheduledTask` in `src/types.ts`
2. Implement parsing logic in `src/ipc.ts` in `processTaskIpc()`
3. Update `src/task-scheduler.ts` to handle the new type when scheduling

---

## Configuration

All configuration is environment-based. See `src/config.ts`:

```bash
# Assistant name (used in trigger pattern)
ASSISTANT_NAME=Andy

# Poll intervals (milliseconds)
POLL_INTERVAL=2000
SCHEDULER_POLL_INTERVAL=60000
IPC_POLL_INTERVAL=1000

# Directories (defaults to PROJECT_ROOT/store, /groups, /data)
STORE_DIR=/var/agentforge/store
GROUPS_DIR=/var/agentforge/groups
DATA_DIR=/var/agentforge/data

# Agent execution limits
AGENT_TIMEOUT=1800000          # 30 minutes
AGENT_MAX_OUTPUT_SIZE=10485760 # 10 MB
IDLE_TIMEOUT=1800000           # 30 minutes
MAX_CONCURRENT_PROCESSES=5

# Timezone for cron expressions
TZ=America/New_York

# Telegram (required)
TELEGRAM_BOT_TOKEN=<your_token>
TELEGRAM_BOT_POOL=<token1>,<token2>  # Comma-separated for agent swarms
```

---

## Error Handling

### Common Patterns

**No channel for JID:**

```typescript
const channel = findChannel(channels, jid);
if (!channel) {
  logger.error({ jid }, 'No channel for JID');
  return;
}
```

**Agent timeout:**
When an agent doesn't produce output within `AGENT_TIMEOUT`, it's killed with SIGKILL and the orchestrator receives:

```typescript
{
  status: 'error',
  error: 'Agent timed out after 1800000ms'
}
```

**IPC authorization failure:**
IPC requests that violate authorization rules are logged and silently dropped:

```
Unauthorized schedule_task attempt blocked
```

---

## Performance Considerations

1. **Message Polling:** Default `POLL_INTERVAL` is 2000ms. Decrease for faster response, increase to reduce CPU.

2. **Concurrent Processes:** Default `MAX_CONCURRENT_PROCESSES` is 5. Increase if you have many groups, but watch memory.

3. **IPC Polling:** Default `IPC_POLL_INTERVAL` is 1000ms. Must be fast enough to catch all IPC files.

4. **Output Streaming:** Agent output is streamed and parsed incrementally, not buffered until completion.

5. **Database:** SQLite is synchronous. For very large message histories, add indexing.

---

## Debugging

Enable debug logging:

```bash
LOG_LEVEL=debug npm start
```

This logs:

- All message routing decisions
- IPC file processing
- Agent process lifecycle
- Channel events

For even more detail:

```bash
LOG_LEVEL=trace npm start
```
