# TypeScript Code Quality Review
**Reviewer:** Riley Park, TypeScript Engineer
**Date:** 2026-02-19
**Scope:** Full codebase — `src/` (orchestrator) and `agent-runner-src/src/` (agent runner)

---

## Executive Summary

AgentForge is in good shape for a personal project that grew fast. The architecture is coherent, the module boundaries are intentional, and the test suite covers the most critical authorization paths. That said, there are patterns here that will cause real pain when something goes wrong at 2am: raw `as` casts hiding SQLite schema drift, module-level singletons that make testing awkward, and an untyped IPC protocol that is the system's central nervous system. None of these are disasters in isolation, but taken together they mean a silent bug in the IPC parsing could corrupt message cursors or send a user's message to the wrong chat without a type error in sight.

The two most impactful things to fix: (1) give the IPC payloads a proper discriminated union type so the switch in `processTaskIpc` is exhaustive and verified at compile time, and (2) replace the raw `as` casts on SQLite results with row-mapping functions that make the schema-to-type contract explicit and auditable. Everything else is refinement.

---

## Strengths

**Strict mode is on and it shows.** The code generally avoids the lazy patterns that strict mode is designed to catch. Non-null assertions (`!`) appear in only a handful of places and each one is locally justified or narrowed by a preceding check.

**Literal union types on domain values.** `schedule_type: 'cron' | 'interval' | 'once'`, `status: 'active' | 'paused' | 'completed'`, `context_mode: 'group' | 'isolated'` — all correct. The `switch` in `processTaskIpc` maps cleanly to these, and the `createTask` call at the end is fully typed. This is the kind of discipline that pays off when you add a fourth schedule type.

**Dependency injection via typed interfaces.** `IpcDeps`, `SchedulerDependencies`, `TelegramChannelOpts` — all pure interfaces. The orchestrator passes capabilities down rather than having subsystems reach up into global state. This is why the IPC authorization tests can run without spawning a real Telegram bot, and it is the main reason the test suite works at all.

**The `Channel` interface is clean.** Optional `setTyping?` is correctly typed and callsites use optional chaining (`channel?.setTyping?.(chatJid, true)`). `ownsJid` is a good predicate pattern for routing without instanceof checks.

**Error handling perimeter is reasonable.** The message loop, IPC watcher loop, and scheduler loop all have top-level try/catch so one bad message can not crash the whole process. `logger.ts` wires up `uncaughtException` and `unhandledRejection` as final backstops.

**Tests cover the authorization matrix.** The `ipc-auth.test.ts` file exhaustively tests the schedule/pause/resume/cancel/register authorization paths. The `db.test.ts` covers the full message filtering and task CRUD logic. This is the right set of things to test for a security-sensitive IPC system.

**Zod is already in the codebase.** The MCP server (`ipc-mcp-stdio.ts`) uses Zod for all tool parameter validation. This makes it easy to add Zod to the orchestrator-side IPC parsing — the dependency is already available and the team knows how to use it.

---

## Issues Found

### IPC Protocol

**[HIGH] IPC message payloads are parsed as untyped `any` and accessed via duck typing**

In `src/ipc.ts` lines 104-105:
```typescript
const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
if (data.type === 'message' && data.chatJid && data.text) {
```

And lines 171-173:
```typescript
const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
await processTaskIpc(data, sourceGroup, isMain, deps);
```

`JSON.parse` returns `any`. `data.chatJid`, `data.text`, and every other field access is an unchecked read on `any`. TypeScript sees no type error if you mistype `data.chatJid` as `data.chatJid` or if the agent writes `chat_jid` instead of `chatJid`. This is the hot path for every message the system delivers.

The `processTaskIpc` function's parameter type (the large inline object type) is structurally correct but it only applies after the call — inside the function, at the parse site, there is no validation.

The MCP server already uses Zod for all tool inputs. The same approach should be applied here. A discriminated union of Zod schemas, one per IPC action, would make the parse site safe and the switch exhaustive:

```typescript
const MessageFileSchema = z.object({
  type: z.literal('message'),
  chatJid: z.string(),
  text: z.string(),
  sender: z.string().optional(),
});

const ScheduleTaskSchema = z.object({
  type: z.literal('schedule_task'),
  prompt: z.string(),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  targetJid: z.string(),
});

// ...one per action...

const IpcTaskPayload = z.discriminatedUnion('type', [
  ScheduleTaskSchema,
  PauseTaskSchema,
  // ...
]);
```

Then at the parse site:
```typescript
const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
const result = MessageFileSchema.safeParse(raw);
if (!result.success) {
  logger.warn({ file, errors: result.error.issues }, 'Invalid IPC message payload');
  fs.unlinkSync(filePath);
  continue;
}
// result.data is now typed
```

**[HIGH] `processTaskIpc` inline parameter type is fragile and cannot be exhaustiveness-checked**

The inline type for the `data` parameter of `processTaskIpc` is a single object with every optional field across all action types:

```typescript
export async function processTaskIpc(
  data: {
    type: string;      // string, not a union
    taskId?: string;
    prompt?: string;
    // ...15 more optional fields
  },
  ...
```

Because `type` is typed as `string` rather than a union, the switch does not get exhaustiveness checking. Adding a new IPC action means remembering to add a case — the compiler will not remind you. The inline type also hides which fields are required for which action: `taskId` is required for `pause_task` but optional here, so the compiler cannot catch `processTaskIpc({ type: 'pause_task' }, ...)` (missing `taskId`) at the call site.

The fix is the Zod discriminated union described above, where each variant is its own schema with required fields for that action. The `processTaskIpc` function can then accept the inferred union type and use narrowed access inside each case.

**[MEDIUM] `drainIpcInput` in the agent runner has the same untyped parse pattern**

In `agent-runner-src/src/index.ts` lines 446-448:
```typescript
const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
fs.unlinkSync(filePath);
if (data.type === 'message' && data.text) {
```

The agent runner already has Zod available (it imports it indirectly via the MCP SDK). A minimal schema here would catch malformed files before they silently drop messages.

---

### Database Layer

**[MEDIUM] SQLite rows cast directly to TypeScript interfaces without runtime validation**

In `src/db.ts`, rows from `better-sqlite3` are cast with `as` to TypeScript interface types:

```typescript
return db.prepare(sql).all(...args) as NewMessage[];
return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
return db.prepare('SELECT * FROM registered_groups').all() as Array<{ ... }>;
```

`better-sqlite3` returns `unknown` from `.get()` and `unknown[]` from `.all()`. The `as` casts tell TypeScript to trust the shape without checking it. If the DB schema drifts from the TypeScript interface (a missed migration, a column rename, a DEFAULT value changing from INTEGER to TEXT), the runtime value will silently mismatch the type.

The current mitigation is that the migrations are in-process and the schema is small. But `getAllRegisteredGroups` already does explicit row mapping:

```typescript
const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;  // ← different name from interface field 'trigger'
  ...
}>;
```

This is the right approach — the `trigger_pattern` → `trigger` remapping is explicit and visible. The issue is that the intermediate `as Array<{...}>` cast is still unvalidated. The rows could add a Zod schema or at minimum a type assertion function:

```typescript
function assertChatInfo(row: unknown): ChatInfo {
  if (
    typeof row !== 'object' || row === null ||
    typeof (row as Record<string, unknown>).jid !== 'string' ||
    typeof (row as Record<string, unknown>).name !== 'string'
  ) {
    throw new Error(`Unexpected DB row shape: ${JSON.stringify(row)}`);
  }
  return row as ChatInfo;
}
```

This trades a silent runtime mismatch for a loud crash, which is almost always preferable.

**[LOW] The `_initTestDatabase` export pattern is consistent but not signaled by type**

`_initTestDatabase()` and `_setRegisteredGroups()` use the `_` prefix convention to signal test-only exports. This works but is purely social — nothing prevents production code from importing them. A more robust pattern would be to put them in a separate `*.test-helpers.ts` file that is excluded from the production build via `tsconfig.json` `exclude`, or to gate them on `process.env.NODE_ENV === 'test'`. At the very least, the JSDoc `@internal` tag is correct and should be kept.

---

### Type Assertions and `as` Usage

**[MEDIUM] `(ctx.chat as any).title` in `telegram.ts` — avoidable with grammy's type discriminants**

In `src/channels/telegram.ts` lines 47 and 79:
```typescript
(ctx.chat as any).title || 'Unknown'
(ctx.chat as any).title || chatJid
```

grammy exposes chat type as a discriminated union: `ctx.chat.type` is `'private' | 'group' | 'supergroup' | 'channel'`. The `title` field exists on `group`, `supergroup`, and `channel` but not on `private`. The code already checks `ctx.chat.type === 'private'` immediately before, so TypeScript should narrow — the problem is that `ctx.chat` is typed as the full union, and accessing `.title` without narrowing requires a cast.

The same pattern from three lines up already works correctly:
```typescript
const chatName =
  ctx.chat.type === 'private'
    ? ctx.from?.first_name || 'Private'
    : (ctx.chat as any).title || 'Unknown';
```

The `as any` could be replaced with `as { title?: string }` which is at least narrower, or with a type assertion function for the group chat types. The `storeNonText` helper at line 132 takes `ctx: any` — this is a more significant issue because it drops all type safety for the entire non-text message handler set.

**[MEDIUM] `formatOutbound` dual-signature using `as` cast and non-null assertion**

In `src/router.ts` lines 83-84:
```typescript
const channel = channelOrText as Channel;
const text = stripInternalTags(rawText!);
```

The backwards-compatible overload pattern works, but the implementation relies on an `as` cast and a `!` assertion where TypeScript cannot verify the invariant. At the call site in the legacy one-arg form, if someone calls `formatOutbound(someChannel)` (passing a Channel instead of a string), the `typeof` guard falls through to the two-arg path and `rawText` is `undefined`, which `stripInternalTags` receives without TypeScript complaining.

The cleaner approach is proper overloads:
```typescript
export function formatOutbound(rawText: string): string;
export function formatOutbound(channel: Channel, rawText: string): string;
export function formatOutbound(channelOrText: Channel | string, rawText?: string): string {
  ...
}
```

With overloads, callers get the correct signature at each call site and TypeScript enforces that the two-arg form always provides `rawText`. The `as` cast and `!` inside the implementation are still needed (overload implementations are not checked against each other), but the external surface becomes type-safe. Searching the codebase shows the legacy one-arg form is actually used in tests (`formatOutbound('hello world')`) and nowhere in production — which means the backwards compat path could be removed entirely.

**[LOW] `agentProcess.stdout!` non-null assertion in `bare-metal-runner.ts` line 351**

```typescript
agentProcess.stdout!.on('data', (data) => {
```

The process is spawned with `stdio: ['pipe', 'pipe', 'pipe']` so `stdout` is always a stream. The `!` is locally justified but a comment explaining why would prevent future readers from thinking it is sloppy. Similarly for `agentProcess.stderr!` on line 410.

---

### Module-Level State

**[MEDIUM] Singleton module state in `index.ts` makes initialization order load-bearing**

`src/index.ts` has five module-level `let` bindings:
```typescript
let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
```

These are mutable module globals. `loadState()` must be called before `startMessageLoop()`, which must be called after `queue.setProcessMessagesFn()`. This ordering is enforced only by `main()` calling them in the right sequence — nothing in the type system enforces it. If a test imports from `index.ts` without calling `loadState()`, `registeredGroups` is an empty object and the behavior is silently wrong.

The `_setRegisteredGroups` export is the proof that this is already causing friction: tests need a backdoor to inject state because the real state is a module-level binding. The correct fix is to encapsulate this state in a class (`Orchestrator`) with explicit initialization. This would make the dependency on `loadState()` visible as a constructor argument or `init()` method, and remove the need for `_setRegisteredGroups` entirely.

This is a significant refactor, so the [MEDIUM] severity reflects that the current approach works and the tests demonstrate that the backdoor is at least tested. But it should be on the roadmap.

**[MEDIUM] `ipcWatcherRunning` and `schedulerRunning` guard pattern is duplicated and untestable**

Three module-level booleans (`messageLoopRunning`, `ipcWatcherRunning`, `schedulerRunning`) exist in three different files to prevent double-start. They are initialized to `false`, set to `true` on first call, and never reset — they survive module lifetime. This means:

1. In tests, if `startIpcWatcher` is called once, a second call in the same module instance is silently ignored. The test for this is absent.
2. The guard state lives outside any object that can be reset between tests, which is why `ipc-auth.test.ts` tests `processTaskIpc` directly rather than through `startIpcWatcher`.

Encapsulating these subsystems in classes (or using a factory that returns a `stop()` function) would eliminate the module-global guard pattern and make it possible to create fresh instances in tests.

---

### `RegisteredGroup` Interface

**[MEDIUM] `requiresTrigger?: boolean` — three-valued flag encoded in two values**

The `requiresTrigger` field is `boolean | undefined` and is checked everywhere as `requiresTrigger !== false`:

```typescript
// In processGroupMessages (index.ts line 210):
if (!isMainGroup && group.requiresTrigger !== false) {

// In startMessageLoop (index.ts line 458):
const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
```

This means `undefined` and `true` have identical runtime behavior — both require a trigger. The `undefined` state exists because it is the SQLite `DEFAULT 1` case: `requires_trigger` can be `null` in the DB (from `getAllRegisteredGroups`), which maps to `undefined` in TypeScript. The `setRegisteredGroup` function compensates:

```typescript
group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
```

This is working correctly but is unnecessarily complex. The simplest fix is to store `requiresTrigger: boolean` (non-optional) and set it to `true` as the default when loading from DB. The DB migration already has `DEFAULT 1`, so every existing row has a value. The interface would become:

```typescript
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  agentConfig?: { timeout?: number };
  requiresTrigger: boolean;  // default true; false for email/DM groups
}
```

And the check becomes simply:
```typescript
if (!isMainGroup && group.requiresTrigger) {
```

**[LOW] `agentConfig` is typed as `{ timeout?: number }` with no extension path**

```typescript
agentConfig?: { timeout?: number };
```

This inline object type is declared inline in the interface. If a second config field is added later (say, `maxRetries?: number`), every consumer that reads `agentConfig` will need to be updated without any help from TypeScript finding all the places the old type was used. Extracting it to a named type makes it easier to find usages and extend:

```typescript
export interface AgentConfig {
  timeout?: number;
}

export interface RegisteredGroup {
  // ...
  agentConfig?: AgentConfig;
}
```

---

### Agent Runner

**[MEDIUM] `ContainerInput` parsed from stdin with no validation**

In `agent-runner-src/src/index.ts` lines 794-795:
```typescript
const stdinData = await readStdin();
containerInput = JSON.parse(stdinData);
```

The result is immediately used as `ContainerInput` without any runtime check. If the orchestrator sends a malformed payload (a bug, a truncated write, a future field rename), the agent will crash with an unhelpful `undefined is not a string` somewhere deep in `runQuery` rather than at the parse boundary. A Zod parse here would give a precise error message pointing to the missing field.

This is lower risk than the IPC file parsing because the orchestrator controls both sides, but it is still an unvalidated parse across a process boundary.

**[MEDIUM] Type assertions in `runQuery` for SDK message types**

In `agent-runner-src/src/index.ts`:
```typescript
const msgType =
  message.type === 'system'
    ? `system/${(message as { subtype?: string }).subtype}`
    : message.type;
```

And:
```typescript
if (message.type === 'assistant' && 'uuid' in message) {
  lastAssistantUuid = (message as { uuid: string }).uuid;
}
```

And:
```typescript
const textResult =
  'result' in message ? (message as { result?: string }).result : null;
```

These casts exist because the Claude Agent SDK's type exports for the message stream are incomplete or not narrow enough for these specific access patterns. This is an external dependency problem — the SDK should export narrower types for each message variant. Until it does, these casts are the pragmatic choice, but they should be centralized into type guard functions rather than scattered across the for-await loop body:

```typescript
function isSystemMessage(msg: unknown): msg is { type: 'system'; subtype: string; session_id: string } {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>).type === 'system';
}
```

This makes the assumptions explicit, locates the cast in one place, and makes it easy to update when the SDK improves its types.

**[LOW] `parseTranscript` uses inline type annotations on `Array.map` and `Array.filter` callbacks**

```typescript
const textParts = entry.message.content
  .filter((c: { type: string }) => c.type === 'text')
  .map((c: { text: string }) => c.text);
```

Because `entry` comes from `JSON.parse`, `entry.message.content` is `any`. The inline type annotations on `c` are technically redundant (TypeScript infers `c` as `any` from the `any` array) but they serve as documentation. This is better than nothing, but a typed schema for the transcript format would make this safe rather than just documented.

---

### Naming and Conventions

**[LOW] `storeNonText` in `telegram.ts` takes `ctx: any`**

```typescript
const storeNonText = (ctx: any, placeholder: string) => {
```

This function is registered for eight different event types (`message:photo`, `message:video`, etc.). Each grammy event provides a typed context, but since they differ slightly in shape (the sticker handler reads `ctx.message.sticker?.emoji`, the document handler reads `ctx.message.document?.file_name`), the function takes the common denominator as `any`. The correct approach is to extract the varying fields at the call site and pass typed primitives to a shared helper:

```typescript
const storeMedia = (chatJid: string, timestamp: string, senderName: string, senderId: string, msgId: string, placeholder: string) => {
  // all args are primitive strings — no any needed
};

this.bot.on('message:photo', (ctx) => {
  storeMedia(`tg:${ctx.chat.id}`, ..., '[Photo]');
});
```

**[LOW] `GroupQueue.shutdown` takes `_gracePeriodMs: number` but ignores it**

```typescript
async shutdown(_gracePeriodMs: number): Promise<void> {
  this.shuttingDown = true;
  // gracePeriodMs is not used
```

The underscore prefix correctly signals intentional non-use and satisfies the linter. The JSDoc comment explains why (processes are detached, not killed). This is fine as-is, but if the signature is part of an interface contract, removing the parameter entirely would be cleaner. If it might be used in the future, a `// TODO: implement grace period if needed` comment would be appropriate.

---

### Import Patterns

**[LOW] Dynamic `import()` in a return type annotation**

In `src/index.ts` line 151:
```typescript
export function getAvailableGroups(): import('./bare-metal-runner.js').AvailableGroup[] {
```

This works, but `AvailableGroup` is already imported from `bare-metal-runner.ts` in the same file via the named import `runContainerAgent`. Adding `AvailableGroup` to that import statement would make the return type explicit at the top of the file and remove the inline import expression:

```typescript
import {
  AgentOutput,
  AvailableGroup,    // add this
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './bare-metal-runner.js';

export function getAvailableGroups(): AvailableGroup[] {
```

**[LOW] `as any` casts in tests for intentionally invalid input**

In `src/ipc-auth.test.ts` line 588:
```typescript
context_mode: 'bogus' as any,
```

This is the correct way to pass an invalid value to a function that does not accept it — you cannot test the "bad input" path without bypassing the type. The `as any` is justified and the comment in the test makes the intent clear. This is fine.

---

## Recommendations

**Priority 1 (do this now):** Type the IPC payloads.

Define a Zod schema (or at minimum a discriminated union type) for each IPC file format. Apply it at the `JSON.parse` boundary in `startIpcWatcher` before the switch dispatch. This is the highest-leverage change because it closes the gap between the runtime behavior (the switch handles specific action types with specific fields) and the type system (the switch currently operates on an `any`-derived object). The Zod dependency is already in the project. The MCP server shows the pattern working correctly — replicate it in the orchestrator.

**Priority 2 (next sprint):** Replace DB row `as` casts with row-mapping functions.

For each `db.prepare(...).all()` or `.get()` call, create a named mapping function that takes the raw DB row shape and returns the TypeScript interface. The schema-to-interface remapping (e.g., `trigger_pattern` → `trigger`, `requires_trigger` INTEGER → `requiresTrigger` boolean) becomes an explicit, auditable operation rather than an invisible `as` cast. Start with `getAllRegisteredGroups` and `getRegisteredGroup` since they already have the most explicit intermediate type.

**Priority 3 (when touching index.ts):** Eliminate `_setRegisteredGroups`.

Extract the orchestrator state (`sessions`, `registeredGroups`, `lastTimestamp`, `lastAgentTimestamp`) into a class. Pass it into `processGroupMessages`, `startMessageLoop`, etc. as a dependency. Tests that currently use `_setRegisteredGroups` would construct the class with the desired initial state. This also makes the initialization ordering explicit through a constructor.

**Priority 4 (low urgency):** Simplify `requiresTrigger` to a non-optional boolean.

The undefined/true equivalence is documented in tests and comments, but it adds cognitive load to every place the flag is checked. Coerce to `boolean` at the DB read boundary and let the rest of the codebase use a plain `if (group.requiresTrigger)`.

---

## Ideas and Proposals

**[IDEA] Branded string types for JIDs and folder names**

JIDs appear everywhere as `string`. The system already has implicit subtypes: `tg:-{number}` for Telegram, `email:{address}` for email, `{jid}@g.us` for WhatsApp groups. Branded types would make accidental confusion between a JID and a folder name (both are `string`) a compile error:

```typescript
type ChatJid = string & { readonly __chatJid: unique symbol };
type GroupFolder = string & { readonly __groupFolder: unique symbol };

function toChatJid(raw: string): ChatJid { return raw as ChatJid; }
function toGroupFolder(raw: string): GroupFolder { return raw as GroupFolder; }
```

Then `RegisteredGroup.folder` would be `GroupFolder`, `IpcDeps.sendMessage` would take `ChatJid`, and passing a folder name where a JID is expected would be a type error. This is a bigger refactor than anything else on this list, but it would eliminate an entire class of bugs (and there are a few places in `processTaskIpc` where `sourceGroup` — a folder name — is compared against JIDs).

**[IDEA] `Result<T, E>` return type for operations that can fail without throwing**

`runContainerAgent` resolves with `AgentOutput` and signals failure via `output.status === 'error'`. `processGroupMessages` returns `Promise<boolean>` where `false` means retry. These ad-hoc error signals work but are easy to ignore — callers must remember to check the status. A `Result` type makes the failure case explicit in the return type:

```typescript
type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

This is idiomatic in TypeScript projects that want exhaustive error handling without exceptions. Whether the ergonomic overhead is worth it depends on whether the codebase grows more callers.

**[IDEA] Dedicated types file for IPC protocol**

The IPC protocol is currently split across four files: the MCP server defines the write side (with Zod schemas), the IPC watcher defines the read side (with inline types), and `bare-metal-runner.ts` has `AgentInput`/`AgentOutput`. A single `src/ipc-protocol.ts` that exports all the Zod schemas, their inferred types, and both read/write helpers would make the contract between agent and orchestrator visible in one place. When the protocol evolves, there is one file to update and the Zod schemas ensure both sides stay in sync.

**[IDEA] Consider `NodeNext` module resolution implications for `.js` extensions**

The `tsconfig.json` uses `"moduleResolution": "NodeNext"`. This requires `.js` extensions on all relative imports in the compiled output. The code correctly uses `.js` extensions on all local imports (`import { ... } from './config.js'`). One subtle footgun: if a developer coming from CommonJS adds an import without the `.js` extension, TypeScript will silently compile it but Node.js will fail to resolve it at runtime. A custom ESLint rule (or the `@typescript-eslint/consistent-type-imports` + `import/extensions` combo) would catch this. The current code is clean, but it is worth documenting this requirement in the project's dev notes.
