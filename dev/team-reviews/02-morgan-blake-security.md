# Security Audit: AgentForge
**Reviewer:** Morgan Blake, Security Engineer
**Date:** 2026-02-19
**Scope:** Full codebase review — secrets management, IPC authorization, process isolation, message handling, Telegram integration, email channel, filesystem operations
**Branch:** fix/agent-memory-autoload

---

## Executive Summary

AgentForge is a personal assistant platform running a single Node.js orchestrator that spawns baremetal Claude agent processes and routes messages via Telegram. The threat model is deliberately permissive: agents have full system access by design, and the platform is intended for a dedicated single-user server.

Within those design constraints, the security posture is **solid for a personal server** and shows deliberate security thinking throughout. The secrets pipeline (stdin injection, not environment variables) is particularly well-designed. The IPC authorization model (directory-identity-based) is sound in principle but has a few scenarios where it can be circumvented. The biggest real-world risks are the `.env` file permissions, the complete absence of systemd hardening, and a rate limiting / DoS gap in the IPC file accumulation path.

**Risk Profile:** Low for a dedicated personal server with a trusted operator. Medium if the server is ever shared or if the Telegram bot token is ever exposed.

**Issues Found:** 0 Critical, 5 High, 7 Medium, 6 Low, 4 Ideas.

---

## Strengths

These were done right and deserve recognition.

**Secrets delivery via stdin.** Reading API keys from `.env` with `readEnvFile()` and injecting them into the agent subprocess via a stdin JSON blob is genuinely good engineering. The keys never appear in `/proc/*/environ` for the child, never appear in `ps` output, and are deleted from the in-memory object immediately after the stdin write (`delete input.secrets`). This is the correct approach and is better than most production systems.

**Child process environment allowlist.** The `env` block in `runContainerAgent` passes only a named subset of variables — `PATH`, `HOME`, `NODE_ENV`, `LOG_LEVEL`, `ASSISTANT_NAME`, and `AGENTFORGE_*` operational vars. No token leakage through the environment.

**IPC authorization by directory identity.** Using the filesystem directory a file was found in as the authoritative identity (`sourceGroup`) is a sound design decision. An agent can only write to its own IPC directory (it receives its path via `WORKSPACE_IPC`), so directory-as-identity provides meaningful isolation without a separate authentication layer.

**IPC input validation.** The `register_group` action validates folder names with `/^[a-z0-9][a-z0-9_-]*$/` (prevents path traversal via folder name), validates JID format with a regex, and caps name length at 100 characters. This is the right defensive approach for user-controlled data that gets turned into filesystem paths.

**Atomic IPC writes.** The write-then-rename pattern (`writeFileSync` to `.tmp`, then `renameSync`) in both `group-queue.ts` and `ipc-mcp-stdio.ts` prevents the IPC watcher from reading a partially-written file. This is a subtle correctness issue that was handled correctly.

**Bash hook strips API secrets from subprocesses.** The `createSanitizeBashHook` in the agent runner prepends `unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ... 2>/dev/null;` to every Bash command the agent executes. This is a good defense-in-depth measure: even though secrets shouldn't be in the environment, the hook ensures they can't leak into shell commands.

**XML escaping in message routing.** `escapeXml()` in `router.ts` escapes `&`, `<`, `>`, and `"` before embedding user message content in the XML prompt format. This prevents XML injection from user-controlled message content.

**SQLite parameterized queries throughout.** Every SQL query in `db.ts` uses prepared statements with `?` placeholders. No SQL injection surface found.

**Duplicate IPC watcher guard.** `ipcWatcherRunning` flag prevents double-start of the polling loop, which could otherwise create race conditions in file processing.

---

## Issues Found

### [HIGH] .env file is world-readable (permissions 0664)

**File:** `/home/dustin/projects/agentforge/.env`
**Observed:** `stat` output shows `-rw-rw-r-- 1 dustin dustin .env`

The `.env` file contains `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and other secrets. At mode `0664`, it is readable by any user in the `dustin` group and — if group membership is shared — by those users directly. On a single-user system this is acceptable, but the intent is clearly to keep secrets secret.

**Attack vector:** Any process running as a different user in the `dustin` group, or any world-read if the group were inadvertently set to `other`, can read all API keys directly from disk.

**Mitigation:**
```bash
chmod 600 /home/dustin/projects/agentforge/.env
```
The service file template should include a note or an `install-service.sh` step that enforces this. Since `readEnvFile()` reads the file at runtime from `process.cwd()`, the 600 permission is sufficient for the service user.

---

### [HIGH] Systemd hardening directives are commented out

**File:** `/home/dustin/projects/agentforge/agentforge.service.template`

The service template contains several hardening directives but all are commented out:

```ini
# Security hardening (optional - uncomment if desired)
# ProtectSystem=strict
# ProtectHome=read-only
# ReadWritePaths=...
# NoNewPrivileges=true
# PrivateTmp=true
```

Without `NoNewPrivileges=true`, a compromised agent process could use `setuid` binaries or capabilities to escalate privileges. Without `PrivateTmp=true`, `/tmp` is shared with all processes on the system. Without `ProtectSystem=strict`, the service can write anywhere on the filesystem the user account can reach.

The comment "optional - uncomment if desired" undersells the importance of these directives on a production system.

**Mitigation:** Enable at minimum:
```ini
NoNewPrivileges=true
PrivateTmp=true
```
`ProtectSystem=strict` with explicit `ReadWritePaths` is also strongly recommended but requires enumerating every directory the service writes to (`/data`, `store/`, `groups/`, `dist/`).

---

### [HIGH] IPC error directory accumulates indefinitely — potential disk exhaustion

**File:** `src/ipc.ts`, lines 146–150, 179–185

Failed IPC files are moved to `/data/ipc/errors/` and never cleaned up:

```typescript
const errorDir = path.join(ipcBaseDir, 'errors');
fs.mkdirSync(errorDir, { recursive: true });
fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
```

**Attack vector:** An agent that repeatedly writes malformed JSON files (either through a bug or through deliberate behavior after compromise) will fill the errors directory without bound. On a filesystem with a small `/data` partition, this could cause the orchestrator to crash when it can no longer write new files (IPC responses, session logs, task snapshots).

This is especially concerning because the error files are named `${sourceGroup}-${file}` with no timestamp component, so if the same filename appears twice, the second `renameSync` silently overwrites the first (losing the earlier error record).

**Mitigation:**
1. Add a timestamp prefix to error filenames to prevent overwrites: `` `${Date.now()}-${sourceGroup}-${file}` ``
2. Add a background cleanup job that removes files from `errors/` older than N days (7 is reasonable for debugging)
3. Add a startup warning if the errors directory exceeds a configurable size threshold

---

### [HIGH] Agent process has no rate limiting on IPC writes

**Files:** `agent-runner-src/src/ipc-mcp-stdio.ts`, `src/ipc.ts`

An agent (or a compromised agent spawned by the SDK's agent-teams feature) can call `send_message` or `schedule_task` in a tight loop, writing thousands of IPC files per second. The IPC watcher processes these synchronously in a polling loop, which will:

1. Block the main event loop handling new Telegram messages
2. Trigger thousands of Telegram API calls (potentially hitting Telegram's rate limits and getting the bot banned)
3. Fill disk via the error directory if any writes fail

There is no rate limiting on IPC tool calls in `ipc-mcp-stdio.ts`, no per-group message throttle in `ipc.ts`, and no circuit breaker on the Telegram send path.

**Attack vector:** A runaway agent (due to a prompt injection in a user message, an SDK bug, or a misconfigured scheduled task) could exhaust Telegram API quota, fill disk, or lock up the event loop.

**Mitigation (partial):**
```typescript
// In ipc.ts processIpcFiles: track per-group message count per cycle
const MAX_MESSAGES_PER_GROUP_PER_CYCLE = 10;
let groupMessageCount = 0;
for (const file of messageFiles) {
  if (++groupMessageCount > MAX_MESSAGES_PER_GROUP_PER_CYCLE) {
    logger.warn({ sourceGroup }, 'Rate limit: too many IPC messages, deferring rest');
    break;
  }
  // ... process file
}
```

---

### [HIGH] Email channel auto-registers any sender as a new group without confirmation

**File:** `src/channels/email.ts`, lines 198–211

```typescript
if (!groups[chatJid]) {
  this.opts.registerGroup(chatJid, {
    name: senderName || senderEmail,
    folder: `email-${sanitizeFolder(senderEmail)}`,
    trigger: '',
    added_at: timestamp,
    requiresTrigger: false,
  });
}
```

Any email sent to the configured Gmail address is automatically registered as a new group with `requiresTrigger: false`. This means:
- The agent will respond to every email from any sender, with no opt-in from the server operator
- There is no allowlist of permitted senders
- A spammer or attacker who discovers the email address can generate unlimited agent invocations and Telegram messages
- The auto-registered group gets `requiresTrigger: false`, so every follow-up email also triggers the agent without needing a trigger word

This is a significant difference from Telegram behavior, where groups must be explicitly registered via the `register_group` IPC command from the main group.

**Mitigation options:**
1. Add an `GMAIL_ALLOWED_SENDERS` allowlist to config; reject senders not on the list
2. Or require explicit registration (same flow as Telegram), auto-registration makes sense only for a known closed sender set
3. At minimum, add `requiresTrigger: true` so random senders can't trigger the agent freely

---

### [MEDIUM] The `isMain` flag in the MCP server comes from an environment variable the agent itself reads

**File:** `agent-runner-src/src/ipc-mcp-stdio.ts`, line 37

```typescript
const isMain = process.env.AGENTFORGE_IS_MAIN === '1';
```

The MCP server subprocess reads `AGENTFORGE_IS_MAIN` from its own environment, which is set by the agent runner (`index.ts`) when it spawns the MCP server:

```typescript
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
}
```

The agent runner itself receives `isMain` from `containerInput`, which came from the orchestrator's stdin. The orchestrator sets this correctly based on `group.folder === MAIN_GROUP_FOLDER`.

**The concern:** If an agent were able to spawn a second MCP server process (e.g., through Bash tool access or a sub-agent that manages to use `spawn` directly), it could pass `AGENTFORGE_IS_MAIN=1` to that process. However, that MCP process would still only write to the IPC directory that the filesystem identity allows — so the host's authorization check would still block it if the directory identity doesn't match `MAIN_GROUP_FOLDER`.

**The gap is real but partially mitigated:** The IPC authorization in `ipc.ts` uses `sourceGroup === MAIN_GROUP_FOLDER` based on directory identity, which the agent cannot change. However, the `isMain` field in IPC payloads (set by the MCP server and included in `pause_task`, `resume_task`, `cancel_task` files) is read from the environment and trusted by the host. In `processTaskIpc`, these operations check `isMain || task.group_folder === sourceGroup`. If a non-main agent wrote a task file with `isMain: true` in the payload, the host discards the `isMain` from the payload and recomputes it from the directory (`isMain = sourceGroup === MAIN_GROUP_FOLDER`), so this specific vector is already blocked.

**Verdict:** The design is correct at the host level. The risk is low because directory identity is the authoritative check. However, the `isMain` field in IPC payloads could be removed entirely (since it's recomputed at the host) to simplify the trust model.

---

### [MEDIUM] Secrets briefly persist in memory on the `input` object before `delete`

**File:** `src/bare-metal-runner.ts`, lines 305–340

```typescript
input.secrets = readSecrets();
// ...
agentProcess.stdin.write(JSON.stringify(input));
agentProcess.stdin.end();
// ...
delete input.secrets;
```

The secrets are set on the input object, serialized to JSON (which includes them), written to stdin, then deleted. Between the assignment and the delete, if the process crashes, throws, or if the timeout fires and the `resolve` path is taken without reaching the `delete`, secrets remain on the heap.

More concretely: if `agentProcess.stdin.write()` throws (the `catch` block on line 326 calls `agentProcess.kill()` and `resolve()`), the function returns without deleting `input.secrets`. The `input` object is passed in from the orchestrator and lives for the duration of the call — if it's referenced elsewhere after the error return, secrets are still accessible.

**Mitigation:** Delete secrets before the write attempt, or use a local variable instead of mutating the passed-in `input`:

```typescript
// Use local variable, never mutate input
const stdinPayload = { ...input, secrets: readSecrets() };
try {
  agentProcess.stdin.write(JSON.stringify(stdinPayload));
  agentProcess.stdin.end();
} catch (err) {
  // stdinPayload goes out of scope here; GC will collect it
  // input is never mutated
}
```

---

### [MEDIUM] Agent log files may contain secrets on error paths

**File:** `src/bare-metal-runner.ts`, lines 544–557

```typescript
if (isVerbose || isError) {
  logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
}
```

The `input` object is logged verbatim when `isError` (exit code != 0) or when `LOG_LEVEL` is `debug` or `trace`. At the time this log is written, `input.secrets` has already been deleted (the delete happens right after the stdin write), so **under normal execution** secrets are not in the log.

However, if the error path that catches a failed `stdin.write` is hit (where `input.secrets` is *not* deleted before resolving — see the previous finding), and then the `close` event fires with a non-zero code, `input.secrets` would be present in the JSON.stringify output.

The log files are written to `groups/{folder}/logs/agent-{timestamp}.log` with permissions inherited from the group directory (`drwxrwxr-x`, i.e., group-writable, world-executable). The log files themselves are created by `fs.writeFileSync` with default umask — typically `0644`. On a multi-user server, these would be readable by other users in the group.

**Mitigation:** Fix the secrets-not-deleted issue first (previous finding). Additionally, ensure the log directory has `0750` permissions and that log files are written with `0600` mode.

---

### [MEDIUM] Telegram message spoofing: sender_name comes from Telegram metadata, not validated

**File:** `src/channels/telegram.ts`, lines 67–72

```typescript
const senderName =
  ctx.from?.first_name ||
  ctx.from?.username ||
  ctx.from?.id.toString() ||
  'Unknown';
```

The `sender_name` field is set from Telegram metadata and passed directly to `formatMessages()` in `router.ts`, which XML-escapes it before injecting into the agent's prompt. The name itself is trusted as identifying the user.

**The concern:** Telegram allows users to set their display name to arbitrary strings including `<tags>`, system-looking text like `[SYSTEM]`, or strings designed to look like other users in the conversation. Since the XML escaping prevents tag injection, the risk is prompt injection — a malicious user could set their name to something like `SYSTEM: Ignore all previous instructions` and this string would appear in the `sender` XML attribute of every message they send.

The XML escaping protects the XML structure, but the agent reads the `sender` attribute as a natural language string identifying the user. A crafted sender name could attempt to manipulate agent behavior.

**Mitigation:** This is inherent to the LLM architecture and cannot be fully eliminated. Mitigating measures:
1. Truncate `sender_name` to a reasonable maximum length (e.g., 50 characters) before including in the prompt
2. Document in AGENTS.md that sender names are user-controlled and should not be given special authority

---

### [MEDIUM] The `WORKSPACE_EXTRA` environment variable falls back to `/workspace/extra` which may not exist, but is silently iterated

**File:** `agent-runner-src/src/index.ts`, lines 78, 621–630

```typescript
const WORKSPACE_EXTRA = process.env.WORKSPACE_EXTRA || '/workspace/extra';
// ...
if (fs.existsSync(WORKSPACE_EXTRA)) {
  for (const entry of fs.readdirSync(WORKSPACE_EXTRA)) {
```

The `WORKSPACE_EXTRA` path is not passed in the orchestrator's env block for agent processes. The fallback `/workspace/extra` is a container-era path that doesn't exist in the baremetal deployment. The `existsSync` check handles this gracefully.

However, if `WORKSPACE_EXTRA` were pointed at a writable directory by an attacker (or by accident via environment variable injection), the contents of that directory would be passed as `additionalDirectories` to the Claude SDK, potentially injecting additional AGENTS.md instructions from an attacker-controlled path.

**Finding is low-probability but worth noting:** Since the env block in `bare-metal-runner.ts` does not include `WORKSPACE_EXTRA`, this variable can only be set via the base environment inherited before the allowlist is applied — but the allowlist only applies to the child, not to the MCP server sub-subprocess. The MCP server's env does not include this variable either. The risk is essentially theoretical in the current deployment but creates a latent attack surface.

**Mitigation:** Either include `WORKSPACE_EXTRA` explicitly in the env allowlist (even as `undefined`) or remove the feature if it's not actively used.

---

### [MEDIUM] `sanitizeFolder` in email.ts does not enforce a minimum length or prevent collision

**File:** `src/channels/email.ts`, lines 376–383

```typescript
function sanitizeFolder(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
```

This function is used to create the folder name for auto-registered email senders: `email-${sanitizeFolder(senderEmail)}`. Two different email addresses can produce the same folder name:
- `a@b.com` → `a-b-com`
- `a-b.com@x` → `a-b-com` (after truncation)

If two senders produce the same folder, the second sender's auto-registration silently collides with the first, and both senders share one agent group and one conversation context. This is a data integrity issue and a potential privacy issue (sender A's messages are visible to the agent when responding to sender B).

Additionally, the folder name is not validated against the `register_group` folder regex (`/^[a-z0-9][a-z0-9_-]*$/`) before being registered. The sanitization function does produce valid-looking names, but `email-` prefix followed by an all-numeric result would pass that regex.

**Mitigation:** Hash collisions: append a truncated hash of the full email address to the folder name:
```typescript
const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 8);
return `${sanitized.slice(0, 30)}-${hash}`;
```

---

### [LOW] `parseBuffer` in bare-metal-runner has no size cap — large agent output can cause unbounded memory growth

**File:** `src/bare-metal-runner.ts`, lines 345, 373–380

```typescript
let parseBuffer = '';
// ...
parseBuffer += chunk;
```

The `stdout` accumulator has a cap at `AGENT_MAX_OUTPUT_SIZE` (10MB default). The `parseBuffer` does not. If an agent writes a very large blob of text without the `OUTPUT_START_MARKER`, `parseBuffer` will grow without bound until the process exits.

**Scenario:** An agent that has a bug causing it to write megabytes of non-marker output to stdout (e.g., debug dumps, large file contents) will cause the orchestrator's memory to grow significantly before the timeout fires.

**Mitigation:** Apply the same size cap to `parseBuffer`:
```typescript
if (parseBuffer.length > AGENT_MAX_OUTPUT_SIZE) {
  // Keep only the last N bytes to preserve any pending partial markers
  parseBuffer = parseBuffer.slice(-OUTPUT_START_MARKER.length * 2);
}
```

---

### [LOW] Telegram bot token compared case-insensitively via `startsWith('tg:')`, not via a typed check

**File:** `src/channels/telegram.ts`, line 116 (IPC message routing)

```typescript
if (data.sender && data.chatJid.startsWith('tg:') && TELEGRAM_BOT_POOL.length > 0) {
  await sendPoolMessage(data.chatJid, data.text, data.sender, sourceGroup);
}
```

The `chatJid.startsWith('tg:')` check is used to decide whether to route through the bot pool. In `sendMessage()` and `setTyping()`, the JID prefix `tg:` is stripped with `jid.replace(/^tg:/, '')`. If a JID were crafted to start with `tg:` but contain path traversal or special characters after the prefix (e.g., `tg:../admin`), the numeric conversion passed to Telegram's API would fail gracefully (Telegram rejects non-numeric chat IDs), but it's worth noting the implicit trust.

**Verdict:** Low risk given Telegram's API validation, but the JID format regex in `processTaskIpc` (`/^(tg:-?\d+|[\w.+-]+@[\w.+-]+)$/`) should ideally be applied at the message routing layer too, not just at registration time.

---

### [LOW] Bot pool renaming uses user-controlled sender name directly in Telegram API call

**File:** `src/channels/telegram.ts`, lines 300–305

```typescript
await poolApis[idx].setMyName(sender);
```

The `sender` field comes from the IPC file written by the MCP server (`data.sender`), which is set from `args.sender` — a string the agent (and by extension the LLM) controls. The agent can set the bot's Telegram display name to any string it chooses. While Telegram likely enforces their own name length and content policies server-side, a prompt-injected agent could rename pool bots to confusing or offensive names.

**Mitigation:** Sanitize `sender` before passing to `setMyName`: restrict to alphanumeric characters and spaces, cap at 64 characters (Telegram's limit).

---

### [LOW] `processedIds` in EmailChannel is an unbounded in-memory Set

**File:** `src/channels/email.ts`, line 53

```typescript
private processedIds = new Set<string>(); // Dedup across poll cycles
```

Message IDs are added to this set and never removed. For a long-running service that receives many emails, this set will grow without bound. On a typical personal server this is inconsequential (thousands of IDs, negligible memory), but it's worth noting for completeness.

**Mitigation:** Use an LRU cache limited to the last N=10,000 IDs, or reset the set periodically (e.g., every 24 hours).

---

### [LOW] `agentConfig` from IPC `register_group` is passed through without schema validation

**File:** `src/ipc.ts`, line 465

```typescript
deps.registerGroup(data.jid, {
  name: data.name,
  folder: data.folder,
  trigger: data.trigger,
  added_at: new Date().toISOString(),
  agentConfig: data.agentConfig,  // unvalidated
  requiresTrigger: data.requiresTrigger,
});
```

The `agentConfig` field is taken directly from the IPC file and stored to the database (serialized as JSON via `setRegisteredGroup`). The `RegisteredGroup['agentConfig']` type presumably includes a `timeout` field that influences process kill timing. If an agent (even the main group agent) were compromised and submitted a `register_group` with `agentConfig: { timeout: 9999999999 }`, the newly registered group's processes would never be killed by the timeout.

**Mitigation:** Validate and clamp `agentConfig` values — e.g., cap `timeout` at some maximum (e.g., `7_200_000` for 2 hours), reject unknown fields.

---

## Recommendations

### Priority 1 — Fix Immediately

1. `chmod 600 /home/dustin/projects/agentforge/.env` and add this to `install-service.sh` with a `chmod` call after `.env` creation.

2. Enable `NoNewPrivileges=true` and `PrivateTmp=true` in the systemd service template (both are safe to enable without enumerating write paths).

3. Fix secrets-not-deleted-on-error path in `bare-metal-runner.ts` (use a local variable for the stdin payload instead of mutating `input`).

### Priority 2 — Fix Before Expanding Access

4. Add a sender allowlist for the email channel (`GMAIL_ALLOWED_SENDERS` env var, comma-separated). Auto-registration of arbitrary senders is a significant escalation risk.

5. Add per-group rate limiting on IPC file processing (max N messages per poll cycle per group, with a warning log when the limit is hit).

6. Add an error directory cleanup job (remove files older than 7 days) and a size warning at startup.

### Priority 3 — Harden Over Time

7. Add `ReadWritePaths` to the systemd service template and comment in `ProtectSystem=strict` with the correct paths enumerated (this requires knowing all write paths at install time, which `install-service.sh` could compute).

8. Validate and clamp `agentConfig` fields in `register_group` IPC handler.

9. Fix `sanitizeFolder` collision in the email channel by appending a hash suffix.

10. Cap `sender_name` length at 50 characters in `telegram.ts` before including in the agent prompt.

---

## Ideas & Proposals

### [IDEA] Add a security mode for untrusted agent groups

Currently, all registered groups get identical baremetal process capabilities. For groups that handle external/untrusted input (e.g., an email channel, a public Telegram group), consider a `securityLevel: 'restricted'` flag in `agentConfig` that limits the `allowedTools` list passed to the SDK — for example, disabling `Bash`, `Write`, and `Edit` for restricted groups. The IPC tools would remain available so messaging still works.

### [IDEA] Structured IPC file audit log

Every IPC file processed by the orchestrator could be appended to a rotating audit log (one line of JSON per event: timestamp, sourceGroup, action, chatJid, outcome). This would make it trivial to investigate anomalous agent behavior after the fact. The current approach relies on logger output which may be scrolled off or not retained.

### [IDEA] Add a `_close_all` sentinel for orchestrator-initiated shutdown

Currently, `_close` is only written by the orchestrator to signal a specific group's agent to exit. Consider a `_shutdown` sentinel in the base IPC directory that causes all active agents to close cleanly. This would allow graceful shutdown of agent processes before the orchestrator itself exits — the current `shutdown()` in `GroupQueue` detaches processes rather than waiting for them.

### [IDEA] Periodic secrets rotation detection

Since `readSecrets()` reads from `.env` at the time each agent process is spawned, secrets rotated in `.env` take effect automatically on the next agent spawn. This is a useful property. However, there is no mechanism to proactively invalidate long-lived agent sessions (sessions can last 30 minutes via `IDLE_TIMEOUT`) after a key rotation. A `SECRETS_VERSION` file that the orchestrator hashes on each spawn, compared to the version at session start, could detect when a rotation has occurred and force session teardown.

---

## Appendix: Files Reviewed

| File | Focus |
|------|-------|
| `src/bare-metal-runner.ts` | Secrets delivery, process env, output parsing, log file contents |
| `src/ipc.ts` | IPC authorization, file handling, action dispatch |
| `src/channels/telegram.ts` | Telegram message ingestion, bot pool, sender validation |
| `src/channels/email.ts` | Email auto-registration, sender trust, MIME parsing |
| `src/db.ts` | SQL injection, parameterized queries, schema, migration |
| `src/router.ts` | XML escaping, message formatting, internal tag stripping |
| `src/index.ts` | Orchestrator flow, group registration, message loop |
| `src/config.ts` | Environment variable handling, path construction |
| `src/group-queue.ts` | Process management, IPC file writes, retry logic |
| `src/task-scheduler.ts` | Scheduled task execution, session selection |
| `src/env.ts` | .env file parsing, secret loading |
| `agent-runner-src/src/index.ts` | Agent process entry point, SDK invocation, IPC polling |
| `agent-runner-src/src/ipc-mcp-stdio.ts` | MCP server tools, IPC file writes, environment trust |
| `agent-runner-src/src/template.ts` | Variable substitution in markdown files |
| `agentforge.service.template` | Systemd security directives |
| `.env` (permissions only) | File mode / world-readability check |
