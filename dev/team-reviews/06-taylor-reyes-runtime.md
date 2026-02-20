# Agent Runtime Review — Taylor Reyes, Runtime Engineer

**Date:** 2026-02-19
**Scope:** `agent-runner-src/src/index.ts`, `agent-runner-src/src/ipc-mcp-stdio.ts`,
`agent-runner-src/src/template.ts`, `agent-runner-src/src/qmd-setup.ts`,
`src/bare-metal-runner.ts`

---

## Executive Summary

The AgentForge runtime is a well-thought-out baremetal agent execution system. The
core design — spawning isolated Node.js processes, communicating via stdin/stdout
with sentinel-delimited JSON, and routing follow-up messages through a file-based
IPC channel — is solid and operationally simple. The secrets handling is notably
careful. The `MessageStream` abstraction for keeping the SDK query alive across
multiple user turns is elegant.

However, there are several meaningful issues that warrant attention. The most
pressing is that `setupGroupSession()` in `bare-metal-runner.ts` performs
unconditional, synchronous file copies on every single agent spawn — including
skills and shared template files — without any staleness check. On a system with
multiple groups receiving simultaneous traffic this creates unnecessary I/O and
mutex pressure. The QMD initialization path has a subtle process.env mutation that
leaks state between groups in theory. The output sentinel parser in the host has
no defense against a malformed JSON block that splits across two of its own markers,
and the IPC polling inside the agent uses a busy-loop pattern with a fixed 500ms
tick that scales poorly when multiple groups are active.

On the whole the runtime is functional and thoughtfully constructed. Most findings
are medium-severity technical debt items rather than active bugs, with two high-
priority items that should be addressed before load increases.

---

## Strengths

**Secrets isolation is well-executed.** Secrets are read from the `.env` file
directly by the host process, injected into the child's stdin payload, merged into
a local `sdkEnv` object inside the agent, and then explicitly stripped from Bash
tool environments via the `PreToolUse` hook. They never appear in the spawned
process's environment block (visible in `/proc/{pid}/environ`), which is the right
call on a shared Linux system. The `unset` prefix injected into every Bash command
is a solid belt-and-suspenders defense. The comment acknowledging that secrets do
still live in `sdkEnv` during the SDK call is honest and accurate.

**The `MessageStream` abstraction is clean.** Using a push/end async iterable to
drive the SDK query loop is the correct pattern for keeping `isSingleUserTurn=false`
while avoiding a tight polling loop inside the SDK call itself. The one-shot `waiting`
resolver pattern prevents spurious wakeups and is easy to reason about.

**Sentinel-delimited output is robust for streaming.** The sliding-window parse
of `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs in `bare-metal-runner.ts` (lines
373–406) correctly handles multi-chunk boundaries. The `parseBuffer` accumulation
and slice logic will not lose data across chunk boundaries. This is a well-known
tricky problem and it is handled correctly here.

**File-based IPC is operationally transparent.** The entire message flow — agent
writes a JSON file, host picks it up on the next poll tick, acts on it, deletes it
— is inspectable with standard Unix tools, easy to debug, and requires no daemon
or network listener. The atomic write-then-rename in `writeIpcFile()` prevents the
host from reading a partially-written file. This is exactly right.

**Authorization uses directory identity, not payload identity.** In `ipc.ts`, the
`sourceGroup` used for authorization is derived from the directory the file was
found in, not from any field inside the payload. An agent cannot escalate privileges
by writing `"groupFolder": "main"` into a task file. This is the correct design.

**The output chain serialization (`outputChain`) is thoughtful.** Chaining
`onOutput` calls via `outputChain = outputChain.then(...)` prevents interleaved
async delivery of streamed output blocks. The error handler on the chain means a
failing callback does not drop the entire output chain.

**Pre-compact hook preserves conversation history.** Archiving the full JSONL
transcript to `conversations/YYYY-MM-DD-{summary}.md` before the SDK compacts the
context window is an excellent design. It gives the agent and user a permanent
record without burdening the context window indefinitely. The fallback to a
timestamp-based filename when no session summary is available is correct defensive
coding.

**The memory autoload fix is the right approach.** Loading `memory.md` and the
last two days of daily logs unconditionally into the system prompt (rather than
relying on an instruction telling the agent to read files) eliminates an entire
class of agent amnesia bugs. System prompt injection is the only reliable way to
guarantee the agent has this context on startup.

---

## Issues Found

### [HIGH] `setupGroupSession()` runs unconditional file copies on every spawn

**File:** `src/bare-metal-runner.ts`, lines 126–158

Every agent invocation — including follow-up messages to an already-running agent
where `runContainerAgent` is called again — executes:

1. A full directory scan and `copyFileSync` for every file in every subdirectory of
   `skills/`.
2. A `copyFileSync` for each of the five shared template files (`SOUL.md`,
   `TOOLS.md`, `IDENTITY.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`).

There is no staleness check — the files are always copied unconditionally. On a
system with five groups and a busy skills directory this means every incoming
message triggers a wave of synchronous `copyFileSync` calls on the main orchestrator
thread before the agent process even spawns. Because `copyFileSync` is blocking,
this directly delays agent startup for every concurrent group.

The fix is simple: compare `fs.statSync().mtimeMs` of the source and destination
before copying, and skip the copy if the destination is already current.

---

### [HIGH] QMD `initializeQMD` mutates `process.env.QMD_DB` on the agent process

**File:** `agent-runner-src/src/qmd-setup.ts`, line 35

```typescript
process.env.QMD_DB = path.join(qmdDataDir, 'qmd.db');
```

The agent process is single-group and single-invocation, so in practice this
mutation only runs once per process. However, if any code path runs `initializeQMD`
more than once in a session (e.g., on a session resume), the second call's
`checkCollectionsExist()` would use whichever `QMD_DB` value was in `process.env`
at the time the spawned `qmd` subprocess runs, which may be stale or wrong. The
correct approach is to pass the db path as an argument to each `runQMD()` call
via the subprocess environment rather than mutating the parent's `process.env`. The
`getQMDEnvironment()` function already returns the correct value for the SDK MCP
server; the same pattern should be used in `runQMD`.

---

### [MEDIUM] IPC polling inside the agent uses a recursive `setTimeout` busy-loop at 500ms

**File:** `agent-runner-src/src/index.ts`, lines 537–553 and 479–493

Both `pollIpcDuringQuery` and `waitForIpcMessage` use a 500ms `setTimeout` recursive
loop. For a single agent this is fine. For a system with many active agents, each
process is waking up twice per second to stat or readdir a filesystem path
regardless of whether any activity is occurring. This is straightforward to address
with `fs.watch()` on the IPC input directory, falling back to polling only if the
watch events are unreliable. Filesystem watches on Linux (inotify) are essentially
free when idle and eliminate the polling latency floor.

The 500ms poll interval also means follow-up messages have up to 500ms of latency
before they reach the SDK stream, which is perceptible in a conversation.

---

### [MEDIUM] Malformed JSON between output sentinels is silently dropped with no recovery signal

**File:** `src/bare-metal-runner.ts`, lines 382–406

When the JSON between a `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pair fails to
parse, the block is logged as a warning and silently discarded:

```typescript
} catch (err) {
  logger.warn({ group: group.name, error: err }, 'Failed to parse streamed output chunk');
}
```

The user receives no response, and the host's `outputChain` is not advanced for
that block, but the process continues. If this happens on a result block (which
contains the agent's actual reply text), the user's message goes unanswered with
no indication of failure. A failed parse should either write an error output to the
user or, at minimum, emit a metric/alert so the operator knows the agent produced
unparseable output.

Additionally, if the agent's response text somehow contains the string
`---AGENTFORGE_OUTPUT_END---` (e.g., the agent is asked to demonstrate the protocol
or write documentation about it), the parser will split at the wrong boundary. A
content-length framing approach or Base64 encoding of the JSON block would eliminate
this class of issue entirely, though it is admittedly a low-probability edge case
in practice.

---

### [MEDIUM] `setupGroupSession()` creates today's daily log on every spawn at midnight boundary

**File:** `src/bare-metal-runner.ts`, lines 189–194

The today's date is computed as `new Date().toISOString().split('T')[0]`, which
is UTC midnight, not local midnight. If the user's local timezone is UTC-5, any
message between 19:00 and midnight local time creates tomorrow's log file, not
today's. This means:

1. The agent's daily log filename does not match the user's actual day.
2. In `runQuery`, when loading memory logs, `toDateStr()` uses the same UTC logic,
   so the mismatch is internally consistent — but the filenames presented to the
   user (or in conversation archives) are confusing.

The system has a `TIMEZONE` config value used for cron scheduling. The same
timezone-aware date computation should be used for daily log filenames.

---

### [MEDIUM] `runQuery` reloads AGENTS.md and all memory files on every call within the same session

**File:** `agent-runner-src/src/index.ts`, lines 562–617

The comment at line 511 explains this is intentional: "AGENTS.md files are loaded
fresh on each query call so configuration changes take effect without a process
restart." However, `memory.md` and the daily logs are also re-read on every query
call, even when they have not changed. In a long-running agent session with many
back-and-forth messages, this means multiple filesystem reads per turn for files
that are almost certainly unchanged (except after the agent itself writes to them
via the memory flush trigger).

A lightweight mtimeMs-based cache keyed on file path would eliminate redundant
reads. For AGENTS.md specifically the live-reload behavior is valuable; for
`memory.md` and daily logs a read-on-change approach would be more efficient.

---

### [MEDIUM] The memory flush reminder injection is a message injected mid-conversation

**File:** `agent-runner-src/src/index.ts`, lines 710–730

After 40 messages within a query, the runner injects a system reminder into the
`MessageStream` asking the agent to flush memory. This message arrives as a user
turn from the agent's perspective, which means it appears in the conversation
transcript and may appear in the archived conversation. The message content is
wrapped in `<internal>` tags, but there is no guarantee the SDK treats these
differently from regular user content — it depends entirely on the agent's
instruction set. If the agent quotes or paraphrases this message in its reply,
the user will see an unexpected internal message in the conversation.

A cleaner design would be to deliver this as an out-of-band system prompt append
rather than a user turn, or to use a dedicated hook mechanism if the SDK exposes
one.

---

### [LOW] `drainIpcInput` in the agent deletes malformed files without quarantine

**File:** `agent-runner-src/src/index.ts`, lines 451–462

If an IPC message file fails to parse, the agent deletes it and moves on:

```typescript
try {
  fs.unlinkSync(filePath);
} catch { /* ignore */ }
```

The host's IPC watcher moves failed files to an `errors/` directory for
post-mortem inspection (a good pattern). The agent's IPC drain does not do
this — malformed files disappear permanently, leaving no trace for debugging.

---

### [LOW] `waitForIpcMessage` concatenates multiple queued messages with a bare newline

**File:** `agent-runner-src/src/index.ts`, line 489

```typescript
resolve(messages.join('\n'));
```

If multiple IPC files arrive in the same poll interval (e.g., two rapid messages
from the user), they are concatenated with a single newline and delivered to the
SDK as a single user turn. This may cause the agent to see what looks like a
single merged message rather than two distinct messages. The SDK's message history
will also record it as one turn. Delivering messages individually as separate stream
pushes would be more semantically correct.

---

### [LOW] Agent process CWD is the group workspace, set in two different places

**File:** `src/bare-metal-runner.ts`, line 265; `agent-runner-src/src/index.ts`,
line 638 (`cwd: WORKSPACE_GROUP`)

The spawned process's OS-level CWD is set to `path.join(GROUPS_DIR, group.folder)`
in the `spawn()` call. Inside the agent, `runQuery` also passes
`cwd: WORKSPACE_GROUP` to the SDK's `query()` options. These should always be the
same value (both resolve to the group workspace), but they are set independently
from separate environment variables. If the environment is misconfigured (e.g.,
`WORKSPACE_GROUP` points to a different path than the spawned process's CWD),
relative path resolution inside the SDK and relative path resolution in the agent's
own `fs` calls will diverge silently. Both should be derived from a single source
of truth.

---

### [LOW] `refreshGroupsSnapshot` tool listed in `ipc-mcp-stdio.ts` description but not implemented

**File:** `agent-runner-src/src/ipc-mcp-stdio.ts`

The `register_group` tool's description references `available_groups.json` and
says "Use available_groups.json to find the JID for a group." A `refresh_groups`
type is handled in `ipc.ts`'s `processTaskIpc`, and the MCP server comment at
the top of the file references `refresh_groups` as a tool. However, no
`refresh_groups` MCP tool is registered in the server. The agent cannot request a
groups refresh — it must rely on the pre-written snapshot. This creates a
discoverability problem: if a new Telegram group is created after the agent starts
and the snapshot was written, the agent has no way to ask for an updated list.

---

## Recommendations

**1. Add mtime-based skip logic to `setupGroupSession()` file copies.**

Before calling `copyFileSync`, check whether the destination file exists and
whether its mtime is >= the source's mtime. If so, skip the copy. This converts
every-spawn full copies into no-ops for the common case where templates have not
changed since the last spawn. Implementation cost: ~10 lines.

**2. Remove the `process.env.QMD_DB` mutation in `initializeQMD`.**

Pass the db path directly to each `runQMD()` invocation via the subprocess `env`
option rather than mutating the parent process's environment. This makes the
function side-effect-free and eliminates the implicit state dependency.

**3. Replace the IPC polling loop with `fs.watch` + poll fallback.**

Use `fs.watch(IPC_INPUT_DIR, ...)` to receive inotify events when new files arrive.
Keep the 500ms poll as a fallback for environments where watch is unavailable. This
eliminates idle CPU overhead and reduces follow-up message latency from ~500ms to
~10ms.

**4. Add a user-visible error output for sentinel parse failures.**

When JSON between sentinel markers fails to parse in `bare-metal-runner.ts`, emit
an `AgentOutput` with `status: 'error'` so the host can deliver a failure message
to the user. Silently dropping the block leaves the user without a response.

**5. Use timezone-aware date computation for daily log filenames.**

Import a timezone-aware date utility or compute local date from the `TIMEZONE`
config value so that daily log filenames match the user's actual calendar day
rather than the UTC day.

**6. Consider framing stdout with content-length or encoding instead of sentinel strings.**

Long-term, replace `OUTPUT_START/END` sentinel delimiters with a length-prefixed
framing protocol (e.g., `Content-Length: N\r\n\r\n{json}`) similar to the
Language Server Protocol. This eliminates the theoretical sentinel-collision issue
and is a more principled IPC framing approach. The current sentinel approach is
fine for now but worth tracking.

**7. Deliver IPC messages individually via `stream.push`, not concatenated.**

In `waitForIpcMessage`, instead of joining multiple queued messages with `\n`,
push each one as a separate `stream.push()` call. This preserves the semantic
boundary between user messages and results in cleaner conversation transcripts.

**8. Add a `refresh_groups` MCP tool to `ipc-mcp-stdio.ts`.**

Implement the missing `refresh_groups` tool that writes a `refresh_groups` IPC
task file. The handler in `ipc.ts` already exists. The agent currently has no
way to request an updated groups list from inside a session.

---

## Ideas & Proposals

**[IDEA] Warm agent process pool.**

Currently every agent invocation spawns a fresh Node.js process. The startup time
(including QMD initialization, which spawns additional subprocesses) adds latency
to the first response. A pool of pre-warmed agent processes waiting on a Unix
socket or named pipe could reduce cold-start latency to near-zero. The challenge
is identity: a pooled process would need to be dynamically configured for the group
it is assigned to. This is feasible by deferring `ContainerInput` parsing until
after the pool process is handed to a group, but requires rethinking the current
stdin-read-until-EOF protocol.

**[IDEA] Shared memory context cache across sessions.**

The memory autoload fix correctly solves the amnesia problem by injecting
`memory.md` and daily logs into every system prompt. However, for groups with
large memory files, this increases the system prompt token cost on every invocation.
A structured approach — loading memory as a separate `<memory>` XML block and
instructing the SDK to treat it as compressed context rather than conversation
history — might yield better token efficiency. This is speculative and depends on
SDK internals.

**[IDEA] Agent health/liveness reporting via stdout.**

The agent currently only writes to stdout when it has a result to report. For
long-running tasks (e.g., a multi-step research job), the host has no signal
that the agent is alive and making progress except that the process hasn't timed
out. A periodic liveness heartbeat marker (e.g., `---AGENTFORGE_HEARTBEAT---\n`)
on stdout every N seconds would allow the host to distinguish "agent is working"
from "agent is stuck" and could drive a more responsive timeout strategy.

**[IDEA] Structured memory tiers.**

The current memory system has two tiers: `memory.md` (long-term) and
`memory/YYYY-MM-DD.md` (daily logs). A third tier — ephemeral in-session context
that is written to the system prompt but not persisted to disk — would give the
agent a scratchpad for within-session state that does not pollute long-term memory.
This could be implemented as a `memory/session-{sessionId}.md` file that is loaded
only when resuming the same session and is automatically deleted after a
configurable TTL.

**[IDEA] Sentinel collision prevention via structured content test.**

Add a startup self-test that verifies the agent runner binary can produce a valid
sentinel-delimited output block and the host can parse it before any real agent
traffic is processed. This would catch misconfigured builds (e.g., minification
stripping the marker strings) before they cause silent failures in production.

**[IDEA] Skills versioning via a manifest file.**

Rather than copying every skill file on every spawn and checking nothing, maintain
a `skills/manifest.json` with a content hash or version tag. `setupGroupSession()`
would compare the group's current manifest against the global manifest and only
copy files that have changed. For a system with large or many skill files this
would meaningfully reduce per-spawn I/O.
