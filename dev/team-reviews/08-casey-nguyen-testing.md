# Testing Review — Casey Nguyen, Test Engineer

**Date:** 2026-02-19
**Branch:** `fix/agent-memory-autoload`
**Codebase:** AgentForge (Node.js/TypeScript, Vitest)

---

## Executive Summary

AgentForge has a test foundation that shows intentional design: in-memory SQLite isolation via `_initTestDatabase()`, meaningful behavioral coverage of the authorization layer, and solid unit tests for pure-function modules. The IPC auth tests (`ipc-auth.test.ts`) are the standout — comprehensive, well-structured, and directly testing the security-critical `processTaskIpc` dispatch path with real database state.

That said, the coverage picture is dramatically uneven. The five test files cover approximately **25–30% of production code paths** by line count, and the uncovered areas are precisely the ones that cause real production incidents: the message loop, cursor rollback, agent output parsing, startup recovery, and all channel code. There is also an active test failure in CI — `routing.test.ts` fails at import because `nodemailer` and `imapflow` are not installed as devDependencies, which means CI has been broken since the email channel was added.

The testing strategy leans heavily toward pure-function unit tests and integration tests against real in-memory SQLite, which is the right instinct. The critical work ahead is: fix the broken test, expand coverage into the process orchestration layer, and build lightweight test utilities for the parts that are genuinely hard to test (subprocess spawning, IPC file handling).

**Overall grade: C+** — Strong foundation with critical gaps.

---

## Strengths

### 1. In-Memory Database Isolation

The `_initTestDatabase()` / `_setRegisteredGroups()` backdoor pattern is exactly right for this architecture. Each test file calls `_initTestDatabase()` in `beforeEach`, giving each test a clean SQLite state without touching the filesystem. This prevents the most common class of test pollution bugs and makes tests deterministic. The pattern also composes well — `ipc-auth.test.ts` chains `_initTestDatabase()` with direct `setRegisteredGroup()` calls to build up realistic fixture state.

### 2. IPC Authorization Test Quality

`ipc-auth.test.ts` is the highest-quality test file in the codebase. It tests the actual `processTaskIpc` function (not a reimplementation), uses real database state, and covers every authorization path:

- Main group can perform admin operations (schedule for others, pause any task, register groups)
- Non-main groups are limited to self-service operations
- All four task lifecycle operations (schedule, pause, resume, cancel) are covered
- Input validation is tested (invalid cron, bad intervals, missing required fields)
- The `context_mode` defaulting logic is fully exercised

The `IpcDeps` injection pattern is particularly well-designed — it allows `processTaskIpc` to be tested without a running IPC watcher or filesystem.

### 3. GroupQueue Behavioral Tests

`group-queue.test.ts` uses fake timers correctly and tests behavior through observable outputs rather than internal state. The retry backoff test is especially thorough — it manually advances through all five retry intervals and verifies the process halts at `MAX_RETRIES`. The concurrency limit test properly captures the tricky case where a third group waits behind two active slots.

### 4. Meaningful Schema Tests

`db.test.ts` goes beyond smoke tests. The "upserts on duplicate id+chat_jid" test catches a real correctness requirement. The "preserves newer timestamp on conflict" test validates a subtle `MAX()` behavior in the SQL that would be easy to break during a refactor. The "filters pre-migration bot messages via content prefix backstop" test documents and validates a migration compatibility concern that would otherwise live only in a comment.

### 5. Trigger Pattern Tests Are Authoritative

`formatting.test.ts` tests `TRIGGER_PATTERN` against multiple synthetic assistant names to avoid hardcoding the production name, then tests the exact trigger-gating logic from `processGroupMessages` by copying it verbatim into an inline helper. This means the tests fail if the logic diverges, not just if the regex changes.

---

## Issues Found

### [CRITICAL] Test Suite Fails to Import in CI

**File:** `src/routing.test.ts` imports from `src/index.ts`, which imports `channels/email.ts`, which imports `nodemailer` and `imapflow`. These packages are not installed (`npm ci` on a fresh checkout skips devDependencies). The test runner crashes with:

```
Error: Cannot find package 'nodemailer' imported from '/home/dustin/projects/agentforge/src/channels/email.ts'
```

This failure is visible in the current test run: 4 test files pass, 1 fails. CI has been broken since the email channel was introduced. Any PR to `main` runs against a broken test suite, undermining the value of CI entirely.

**Root cause:** `nodemailer` and `imapflow` are listed as production dependencies (or not listed at all), and the test import chain forces them to load even when the email channel is never instantiated.

**Immediate fix options:**
1. Add `nodemailer` and `imapflow` as `devDependencies` so they install in CI.
2. Mock `channels/email.ts` in the vitest config so the import succeeds without the real packages.
3. Extract `getAvailableGroups` and `_setRegisteredGroups` from `index.ts` into a separate module that doesn't transitively import all channels.

Option 3 is architecturally cleanest. Options 1 or 2 are faster.

---

### [CRITICAL] Cursor Rollback Path Has Zero Test Coverage

`processGroupMessages` in `src/index.ts` (lines 289–307) implements a cursor rollback: if the agent fails and no output was sent, `lastAgentTimestamp[chatJid]` is restored to `previousCursor` and the state is saved. If output was sent before failure, the cursor is intentionally NOT rolled back to prevent duplicate delivery.

This is one of the most important correctness invariants in the system — incorrect behavior means either messages are silently dropped or users receive duplicates. There is no test for it in any form.

A unit test requires the `processGroupMessages` function to be exported or the logic to be extracted. The current architecture of `index.ts` (module-level mutable state, no dependency injection into `processGroupMessages`) makes it difficult to unit test without significant restructuring.

---

### [CRITICAL] Startup Recovery Logic Is Untested

`recoverPendingMessages()` in `src/index.ts` (lines 510–522) is the safety net that catches messages dropped during a crash window. It iterates registered groups, queries for messages since `lastAgentTimestamp[chatJid]`, and enqueues any groups with pending messages.

If this logic has a bug — wrong cursor comparison, missing group iteration, wrong filter — messages that arrived between a crash and restart are silently dropped. There is no test for it.

---

### [HIGH] Agent Output Parsing Has No Tests

`runContainerAgent` in `src/bare-metal-runner.ts` contains a streaming output parser (lines 371–407) that accumulates stdout chunks, searches for `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs, extracts the JSON between them, and calls `onOutput`. This parser handles:

- Partial chunks (a marker split across two `data` events)
- Multiple complete markers in a single chunk
- Malformed JSON between markers (caught and logged)
- The `outputChain` serialization for async `onOutput` calls

None of these behaviors are tested. The parsing logic is pure string manipulation and is fully extractable into a testable pure function.

The following scenarios would all silently misbehave without a failing test:
- A marker split across two 64KB stdout chunks
- Two back-to-back result blocks in a single chunk
- A JSON blob where `result` contains the end marker string

---

### [HIGH] `writeTasksSnapshot` and `writeGroupsSnapshot` Filtering Logic Untested

Both functions in `src/bare-metal-runner.ts` implement access control for file-based context:

- `writeTasksSnapshot`: main group sees all tasks; others see only their own (`groupFolder === t.groupFolder`)
- `writeGroupsSnapshot`: main group gets the full list; others get an empty array

These are pure functions with clear inputs and outputs (file system writes). They are straightforward to test with a temp directory or by mocking `fs.writeFileSync`. The filtering logic is simple but its correctness matters for privacy between groups.

---

### [HIGH] `setupGroupSession` Idempotency Is Untested

`setupGroupSession` in `src/bare-metal-runner.ts` is called on every agent invocation. It must be idempotent — calling it twice should not overwrite user-modified files like `AGENTS.md` or `memory.md`. The code uses `if (!fs.existsSync(filePath))` guards for this, but:

1. There is no test verifying that a second call does not overwrite a modified `AGENTS.md`.
2. There is no test verifying that `settings.json` is created correctly on first call.
3. The skills sync logic (which always overwrites) is not tested.
4. The daily memory log creation path is not tested.

---

### [HIGH] `sanitizeFolder` and `sanitizeFilename` Edge Cases Untested

`sanitizeFolder` in `src/channels/email.ts` and `sanitizeFilename` in `agent-runner-src/src/index.ts` both convert user-controlled strings into filesystem-safe names. These are pure functions with well-defined inputs. Edge cases that should be tested:

- Email addresses with unusual characters (`user+tag@example.com`, `user.name@sub.domain.co`)
- Very long email addresses (truncation at 40 chars)
- Strings that collapse to empty after sanitization
- Path traversal attempts (`../../etc/passwd`)

These functions are used as folder names written to disk. A bug produces either invalid paths or a security issue.

---

### [HIGH] `extractPlainText` MIME Parser Is Untested

`extractPlainText` in `src/channels/email.ts` is a handwritten MIME body parser. It handles both single-part and multipart messages, quoted-reply stripping, and the boundary detection logic. This is the exact kind of code where bugs hide — edge cases in real-world email formats (Gmail vs Outlook vs Apple Mail encoding) will produce wrong behavior silently.

This function is a pure string transformation and is trivial to test with fixture email sources.

---

### [MEDIUM] `substituteVariables` Has No Tests

`substituteVariables` in `agent-runner-src/src/template.ts` is a pure function that replaces `{{VARNAME}}` tokens in markdown content. It is called on `AGENTS.md` files before they are sent to the Claude SDK as system prompts. An untested bug here means agents receive incorrect instructions.

The function is 15 lines, pure, and directly testable. There is no reason it is untested.

```typescript
// Example tests that should exist:
it('substitutes ASSISTANT_NAME', () => {
  process.env.ASSISTANT_NAME = 'Pip';
  expect(substituteVariables('Hello {{ASSISTANT_NAME}}')).toBe('Hello Pip');
});

it('leaves unknown variables as-is', () => {
  expect(substituteVariables('{{UNKNOWN_VAR}}')).toBe('{{UNKNOWN_VAR}}');
});

it('handles multiple substitutions in one string', () => {
  process.env.ASSISTANT_NAME = 'Andy';
  expect(substituteVariables('{{ASSISTANT_NAME}} is {{ASSISTANT_NAME}}')).toBe('Andy is Andy');
});

it('handles content with no variables', () => {
  expect(substituteVariables('no variables here')).toBe('no variables here');
});
```

---

### [MEDIUM] `parseTranscript` and `formatTranscriptMarkdown` Are Untested

These functions in `agent-runner-src/src/index.ts` parse JSONL transcript files and format them as Markdown. They are called during the pre-compact hook. A bug silently produces an empty or malformed archive file with no error visible to the user.

Both are pure functions testable with fixture strings. `parseTranscript` in particular has complex branching for string vs array content and for filtering non-text content parts.

---

### [MEDIUM] `readEnvFile` Has No Tests

`readEnvFile` in `src/env.ts` parses the `.env` file and is called on every module load for `config.ts`. It handles:

- Missing file (returns `{}`)
- Comment lines (skipped)
- Values with and without quotes
- Keys not in the requested set (filtered)
- Lines without `=` (skipped)

None of these behaviors are tested. A bug here would manifest as silent misconfiguration that is hard to diagnose in production.

---

### [MEDIUM] `sendPoolMessage` Bot Assignment Logic Is Untested

The `senderBotMap` in `src/channels/telegram.ts` implements stable bot-to-sender assignment using a module-level `Map`. The assignment logic (round-robin on first use, stable on subsequent calls) is not tested. The key invariant — that the same `groupFolder:sender` always gets the same pool bot — is critical for consistent identity in multi-agent conversations and has no test.

---

### [MEDIUM] Message Deduplication in `processedIds` Is Untested

`EmailChannel` maintains a `processedIds` Set to prevent the same email from being processed twice across poll cycles. This deduplication is untested. A failure mode where `messageId` is unexpectedly null/undefined would cause the Set membership check to always pass on a single `undefined` key, allowing duplicate processing.

---

### [LOW] DB Router State Persistence Is Not Directly Tested

`getRouterState` / `setRouterState` are called frequently but not tested directly. `db.test.ts` exercises them indirectly via `loadState`/`saveState` in `index.ts`, but those paths are not exercised in any test. The behavior on corrupted JSON in `last_agent_timestamp` (the `try/catch` in `loadState`) has no test.

---

### [LOW] `getDueTasks` Query Semantics Are Untested

`getDueTasks` filters tasks where `status = 'active' AND next_run IS NOT NULL AND next_run <= now`. The time comparison uses ISO string ordering. There is no test verifying:

- Tasks with `next_run` in the past are returned
- Tasks with `next_run` in the future are not returned
- Tasks with `status = 'paused'` are excluded
- Tasks with `next_run IS NULL` are excluded

This is a pure DB operation testable with `_initTestDatabase()`.

---

### [LOW] `vitest.config.ts` Has No Coverage Configuration

The vitest config is three lines:
```typescript
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

There is no coverage threshold, no coverage reporter, and no coverage command in `package.json`. The project has `@vitest/coverage-v8` installed as a dependency but it is not wired into any script. Without coverage reporting, it is impossible to know whether new PRs improve or regress test coverage.

---

## Recommendations

### R1. Fix the Broken Test Import Immediately [CRITICAL]

The fastest fix is to add `nodemailer` and `imapflow` to `devDependencies` in `package.json`. The more architecturally sound fix is to extract `getAvailableGroups` and `_setRegisteredGroups` into a module that does not import all channels. Either way, CI must pass before any other testing work is meaningful.

```bash
# Fast fix:
npm install --save-dev nodemailer imapflow
```

### R2. Extract Testable Logic from `index.ts` [HIGH]

`processGroupMessages` and `recoverPendingMessages` are currently impossible to unit test because they close over module-level mutable state (`lastAgentTimestamp`, `registeredGroups`, `sessions`, `channels`, `queue`). The fix is to either:

1. Export them with injected dependencies (like `processTaskIpc` does with `IpcDeps`)
2. Create a `ProcessorDeps` interface and refactor both functions to accept it

Once extractable, the cursor rollback test becomes straightforward:

```typescript
it('rolls back cursor on agent error when no output sent', async () => {
  _initTestDatabase();
  storeChatMetadata('tg:123', '2024-01-01T00:00:00.000Z');
  storeMessage({ id: 'm1', chat_jid: 'tg:123', ... timestamp: '2024-01-01T00:00:01.000Z' });

  const deps: ProcessorDeps = {
    lastAgentTimestamp: {},
    registeredGroups: { 'tg:123': { folder: 'main', ... } },
    runAgent: async () => 'error', // simulated failure
    sendMessage: vi.fn(),          // never called
  };

  const result = await processGroupMessages('tg:123', deps);

  expect(result).toBe(false); // signals retry
  expect(deps.lastAgentTimestamp['tg:123']).toBe(''); // cursor rolled back
});

it('does not roll back cursor when output was sent before error', async () => {
  // ... setup ...
  const deps: ProcessorDeps = {
    lastAgentTimestamp: {},
    registeredGroups: { 'tg:123': { folder: 'main', ... } },
    runAgent: async (_, __, ___, onOutput) => {
      await onOutput({ status: 'error', result: 'partial response' });
      return 'error';
    },
    sendMessage: vi.fn(),
  };

  const result = await processGroupMessages('tg:123', deps);

  expect(result).toBe(true); // treated as success to avoid duplicates
  expect(deps.lastAgentTimestamp['tg:123']).toBe('2024-01-01T00:00:01.000Z'); // not rolled back
});
```

### R3. Extract and Test the Output Parser [HIGH]

The streaming output parser in `runContainerAgent` should be extracted into a pure function:

```typescript
// bare-metal-runner.ts
export function parseOutputChunks(
  buffer: string,
  chunk: string,
): { outputs: AgentOutput[]; remaining: string } {
  const newBuffer = buffer + chunk;
  const outputs: AgentOutput[] = [];
  let current = newBuffer;
  let startIdx: number;

  while ((startIdx = current.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = current.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    const json = current.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
    current = current.slice(endIdx + OUTPUT_END_MARKER.length);
    try {
      outputs.push(JSON.parse(json));
    } catch {
      // malformed, skip
    }
  }

  return { outputs, remaining: current };
}
```

Tests for this pure function:

```typescript
describe('parseOutputChunks', () => {
  const START = '---AGENTFORGE_OUTPUT_START---';
  const END = '---AGENTFORGE_OUTPUT_END---';

  it('parses a complete marker pair in one chunk', () => {
    const chunk = `${START}\n{"status":"success","result":"hello"}\n${END}`;
    const { outputs, remaining } = parseOutputChunks('', chunk);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].result).toBe('hello');
    expect(remaining).toBe('');
  });

  it('handles split marker across two chunks', () => {
    const full = `${START}\n{"status":"success","result":"split"}\n${END}`;
    const mid = Math.floor(full.length / 2);
    const { outputs: o1, remaining: r1 } = parseOutputChunks('', full.slice(0, mid));
    expect(o1).toHaveLength(0);
    const { outputs: o2 } = parseOutputChunks(r1, full.slice(mid));
    expect(o2).toHaveLength(1);
    expect(o2[0].result).toBe('split');
  });

  it('handles two complete markers in one chunk', () => {
    const block = (r: string) => `${START}\n{"status":"success","result":"${r}"}\n${END}`;
    const { outputs } = parseOutputChunks('', block('first') + block('second'));
    expect(outputs).toHaveLength(2);
    expect(outputs[0].result).toBe('first');
    expect(outputs[1].result).toBe('second');
  });

  it('skips malformed JSON between markers', () => {
    const chunk = `${START}\nnot-json\n${END}`;
    const { outputs } = parseOutputChunks('', chunk);
    expect(outputs).toHaveLength(0);
  });

  it('preserves content after incomplete end marker', () => {
    const partial = `${START}\n{"status":"success","result":"hi"}\n${END.slice(0, 10)}`;
    const { outputs, remaining } = parseOutputChunks('', partial);
    expect(outputs).toHaveLength(0);
    expect(remaining).toBe(partial);
  });
});
```

### R4. Add Coverage Configuration [MEDIUM]

Add coverage reporting with a minimum threshold to `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 40,    // start low, raise over time
        functions: 35,
        branches: 30,
      },
    },
  },
});
```

Add to `package.json` scripts:
```json
"test:coverage": "vitest run --coverage"
```

### R5. Add Tests for Pure Functions in `agent-runner-src` [MEDIUM]

The `agent-runner-src/` directory contains several pure functions that are straightforward to test but currently have zero coverage:

- `substituteVariables` (template.ts) — pure string transformation
- `parseTranscript` (index.ts) — pure JSONL parser
- `formatTranscriptMarkdown` (index.ts) — pure formatter
- `sanitizeFilename` (index.ts) — pure string sanitizer

Add a `vitest.config.ts` in `agent-runner-src/` and a separate test command:

```typescript
// agent-runner-src/vitest.config.ts
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

### R6. Add `getDueTasks` and Router State Tests [LOW]

These are cheap wins against real correctness requirements using the existing `_initTestDatabase()` infrastructure:

```typescript
describe('getDueTasks', () => {
  beforeEach(() => _initTestDatabase());

  it('returns tasks where next_run is in the past', () => {
    const past = new Date(Date.now() - 60000).toISOString();
    createTask({ id: 't1', next_run: past, status: 'active', ... });
    expect(getDueTasks()).toHaveLength(1);
  });

  it('excludes tasks with next_run in the future', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    createTask({ id: 't2', next_run: future, status: 'active', ... });
    expect(getDueTasks()).toHaveLength(0);
  });

  it('excludes paused tasks', () => {
    const past = new Date(Date.now() - 60000).toISOString();
    createTask({ id: 't3', next_run: past, status: 'paused', ... });
    expect(getDueTasks()).toHaveLength(0);
  });

  it('excludes tasks with null next_run', () => {
    createTask({ id: 't4', next_run: null, status: 'active', ... });
    expect(getDueTasks()).toHaveLength(0);
  });
});
```

---

## Ideas and Proposals

### [IDEA] IPC File Handling Integration Tests with a Temp Directory

The `startIpcWatcher` polling loop is one of the most important untested paths. Testing it end-to-end without spawning real agent processes is achievable with a temp directory fixture:

```typescript
// ipc-watcher.test.ts
import tmp from 'tmp';
import path from 'path';
import fs from 'fs';

describe('processIpcFiles — message routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
    process.env.DATA_DIR = tmpDir;
    _initTestDatabase();
  });

  it('routes an authorized message to sendMessage', async () => {
    const messagesDir = path.join(tmpDir, 'ipc', 'main', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(messagesDir, '001.json'),
      JSON.stringify({ type: 'message', chatJid: 'tg:123', text: 'hello' }),
    );

    const sent: Array<{ jid: string; text: string }> = [];
    await processIpcFiles({  // extracted function, or trigger one poll cycle
      sendMessage: async (jid, text) => { sent.push({ jid, text }); },
      registeredGroups: () => ({ 'tg:123': { folder: 'main', ... } }),
      // ...
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('hello');
    // File should be deleted after processing
    expect(fs.existsSync(path.join(messagesDir, '001.json'))).toBe(false);
  });

  it('moves malformed JSON to errors directory', async () => {
    // ... writes bad JSON, expects file moved to ipc/errors/
  });
});
```

For this to work, `processIpcFiles` needs to be exported or extracted from the watcher closure.

### [IDEA] Snapshot Tests for XML Output Format

`formatMessages` produces XML that the Claude SDK receives as the user's prompt. A snapshot test would catch accidental format regressions that break the agent's ability to parse message context:

```typescript
it('formatMessages output matches snapshot', () => {
  const msgs = [
    makeMsg({ sender_name: 'Alice', content: 'hello', timestamp: '2024-01-01T00:00:00.000Z' }),
    makeMsg({ sender_name: 'Bob', content: 'world', timestamp: '2024-01-01T00:00:01.000Z' }),
  ];
  expect(formatMessages(msgs)).toMatchInlineSnapshot(`
    "<messages>
    <message sender=\\"Alice\\" time=\\"2024-01-01T00:00:00.000Z\\">hello</message>
    <message sender=\\"Bob\\" time=\\"2024-01-01T00:00:01.000Z\\">world</message>
    </messages>"
  `);
});
```

### [IDEA] Property-Based Testing for `escapeXml` and `sanitizeFolder`

These functions have invariants that are stronger than any fixed set of examples can cover. Consider adding fast-check or similar:

```typescript
import fc from 'fast-check';

it('escapeXml output never contains raw XML special characters', () => {
  fc.assert(fc.property(fc.string(), (s) => {
    const escaped = escapeXml(s);
    expect(escaped).not.toMatch(/[&<>"]/);
  }));
});

it('sanitizeFolder output is always a valid filesystem name', () => {
  fc.assert(fc.property(fc.emailAddress(), (email) => {
    const folder = sanitizeFolder(email);
    expect(folder).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(folder.length).toBeLessThanOrEqual(40);
  }));
});
```

### [IDEA] Test the Telegram @mention Translation Logic

The mention translation in `telegram.ts` (lines 85–98) is a subtle behavior: if the message contains a `mention` entity matching the bot's username, and the message does not already match `TRIGGER_PATTERN`, a trigger prefix is prepended. This is the bridge between Telegram's native mention system and AgentForge's trigger detection.

This logic is testable by constructing mock `ctx` objects and calling the handler directly:

```typescript
it('prepends trigger when bot is @mentioned without existing trigger', () => {
  const received: string[] = [];
  const channel = new TelegramChannel('token', {
    onMessage: (_, msg) => received.push(msg.content),
    onChatMetadata: () => {},
    registeredGroups: () => ({ 'tg:999': { folder: 'main', ... } }),
  });

  const ctx = mockContext({
    text: '@testbot can you help?',
    botUsername: 'testbot',
    entities: [{ type: 'mention', offset: 0, length: 8 }],
    chatId: 999,
  });

  await channel.handleTextMessage(ctx); // extracted handler
  expect(received[0]).toStartWith('@Andy ');
});
```

This requires extracting the message handler into a testable function — currently it is inlined in the `connect()` callback closure.

### [IDEA] Measure and Publish Coverage in CI

Integrate coverage into the CI pipeline so coverage trends are visible on PRs:

```yaml
# .github/workflows/test.yml addition
- run: npx vitest run --coverage --reporter=json
- uses: codecov/codecov-action@v4
  with:
    files: ./coverage/lcov.info
```

Even without a coverage gate, having the number visible on every PR creates accountability and makes coverage regressions obvious.

---

## Summary Table

| Area | Files | Severity | Test Exists? |
|------|-------|----------|--------------|
| Broken test import (nodemailer) | `routing.test.ts` | CRITICAL | Yes (broken) |
| Cursor rollback on agent error | `index.ts:289-307` | CRITICAL | No |
| Startup recovery (`recoverPendingMessages`) | `index.ts:510-522` | CRITICAL | No |
| Output marker parser | `bare-metal-runner.ts:371-407` | HIGH | No |
| `writeTasksSnapshot` / `writeGroupsSnapshot` filtering | `bare-metal-runner.ts:632-692` | HIGH | No |
| `setupGroupSession` idempotency | `bare-metal-runner.ts:93-212` | HIGH | No |
| `sanitizeFolder` edge cases | `channels/email.ts:376-383` | HIGH | No |
| `extractPlainText` MIME parser | `channels/email.ts:300-373` | HIGH | No |
| `substituteVariables` | `agent-runner-src/src/template.ts` | MEDIUM | No |
| `parseTranscript` / `formatTranscriptMarkdown` | `agent-runner-src/src/index.ts` | MEDIUM | No |
| `readEnvFile` | `src/env.ts` | MEDIUM | No |
| `sendPoolMessage` bot assignment | `channels/telegram.ts:278-333` | MEDIUM | No |
| Email deduplication (`processedIds`) | `channels/email.ts:53` | MEDIUM | No |
| `getDueTasks` query semantics | `src/db.ts:418-429` | LOW | No |
| Router state persistence | `src/db.ts:487-504` | LOW | No |
| Coverage configuration | `vitest.config.ts` | LOW | N/A |
| DB `storeMessage`, `getMessagesSince`, `getNewMessages` | `src/db.ts` | — | Yes (good) |
| IPC auth / `processTaskIpc` | `src/ipc.ts` | — | Yes (excellent) |
| `GroupQueue` concurrency, retry, drain | `src/group-queue.ts` | — | Yes (good) |
| `escapeXml`, `formatMessages`, `formatOutbound` | `src/router.ts` | — | Yes (good) |
| `TRIGGER_PATTERN`, trigger gating | `src/config.ts` | — | Yes (good) |
