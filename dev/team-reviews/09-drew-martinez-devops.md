# DevOps & Operational Review
**Reviewer:** Drew Martinez, DevOps Engineer
**Date:** 2026-02-19
**Codebase:** AgentForge v1.0.0

---

## Executive Summary

AgentForge has a solid operational foundation for a personal-scale service. The systemd integration is clean, the install script is user-friendly, and the graceful shutdown handler is correctly implemented. Secrets handling is notably thoughtful — API credentials are passed to child processes via stdin rather than environment variables, keeping them out of `/proc`.

The gaps are almost entirely in the "day two operations" category: there is no log rotation, no disk cleanup automation, no health check endpoint, no DB backup strategy, and no alerting. For a personal assistant running continuously, these omissions are manageable day-to-day but create a silent failure mode: the service can slowly degrade (disk fills, DB grows, error files accumulate) without the operator ever noticing.

The most operationally dangerous issue is that `pino-pretty` is used in production, which is CPU-expensive and produces output that journald cannot efficiently index. The second most pressing issue is the complete absence of log rotation for per-run agent log files, which will quietly consume disk on any busy deployment.

**Verdict:** Functional and safe for personal use. Needs targeted hardening before it can run unattended for months without manual intervention.

---

## Strengths

**Systemd integration is correct and complete.** `Restart=on-failure`, `RestartSec=10s`, `StandardOutput=journal`, `SyslogIdentifier=agentforge` — the template covers all the essentials. The install script auto-detects Node binary location, which sidesteps the classic NVM path problem.

**Graceful shutdown is properly wired.** `src/index.ts` registers `SIGTERM` and `SIGINT` handlers that call `queue.shutdown()` and disconnect channels before exiting. The `GroupQueue.shutdown()` intentionally detaches rather than kills active agent processes, which is the right behavior for a restart-triggered by a code deploy: in-flight agents keep running to completion.

**Secrets are handled well.** `src/env.ts` reads the `.env` file directly (not into `process.env`) and passes credentials to agent subprocesses via stdin as a JSON blob that is deleted from memory immediately after write. This keeps secrets out of `/proc/*/environ` and child process environments.

**Structured logging is in place.** Pino JSON logging with consistent structured fields (`{ group, messageCount, err }`) throughout every subsystem makes logs parseable and grep-friendly.

**Recovery on startup is implemented.** `recoverPendingMessages()` in `src/index.ts` checks for messages that were acknowledged but not yet processed at crash time, preventing silent message drops across restarts.

**IPC error quarantine.** Failed IPC files are moved to `data/ipc/errors/` rather than deleted or retried in a loop. This preserves the artefact for debugging without blocking the processing loop.

**Two-project build structure is clear.** The orchestrator (`src/`) and agent runner (`agent-runner-src/`) are cleanly separated with independent `package.json` and `tsconfig.json` files. The install script enforces build prerequisites before installing the service.

---

## Issues Found

### [HIGH] `pino-pretty` used in production

**File:** `src/logger.ts`, lines 1-6

```typescript
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});
```

`pino-pretty` is a development convenience transport. In production it:
- Serializes every log line through a second Node.js worker thread
- Outputs ANSI color escape codes that pollute `journalctl` output
- Is significantly slower than raw JSON output (50-200ms overhead on bursty logs)
- Discards the structured fields that make Pino useful — pretty-printed output is for humans, not machines

When output goes to `journalctl` (as configured in the service template via `StandardOutput=journal`), ANSI codes appear literally and pretty-printing provides no benefit. The journal already applies its own formatting.

**Risk:** On a busy deployment with many agent runs, the pretty transport introduces unnecessary CPU overhead and makes log parsing with `jq` or `grep` harder because lines are human-formatted, not JSON.

---

### [HIGH] No log rotation for agent run files

**File:** `src/bare-metal-runner.ts`, lines 527-559

Every agent invocation writes a log file to `groups/{folder}/logs/agent-{timestamp}.log`. There is no rotation, no size cap, no TTL cleanup. Each normal-exit run writes a file containing at minimum the header block (8 lines). On verbose or error mode it includes full stdout/stderr up to the 10MB cap.

On a typical deployment receiving 20-50 agent invocations per day, this generates 600-1500 files per month per group. A single verbose or erroring agent run can produce a 10MB file. With multiple registered groups, this compounds quickly.

**There is no mechanism to clean these up automatically.** The troubleshooting docs note this manually (`find groups -name "agent-*.log" -mtime +30 -delete`) but this requires the operator to remember to run it.

---

### [HIGH] IPC error directory accumulates indefinitely

**File:** `src/ipc.ts`, lines 146-152

```typescript
const errorDir = path.join(ipcBaseDir, 'errors');
fs.mkdirSync(errorDir, { recursive: true });
fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
```

Files that fail IPC processing are moved to `data/ipc/errors/` and never removed. If an agent enters a bug loop producing malformed IPC files, the error directory fills without bound. There is no alerting, no rotation, no size limit on this directory.

---

### [MEDIUM] No memory/resource limits on agent subprocesses

**File:** `src/bare-metal-runner.ts`, `spawn()` call, lines 260-282

Agent processes are spawned with no memory limit, no CPU limit, and no cgroup constraints. Node.js defaults to a ~1.5GB V8 heap. With `MAX_CONCURRENT_PROCESSES=5` (the default), a pathological agent run can allocate up to 7.5GB of memory before the OOM killer intervenes — at which point it will kill the orchestrator (higher-priority process), not the agent.

The systemd unit template has `MemoryMax` commented out in the security hardening section. There is also no `SIGKILL` fallback with a hard wall-clock cap independent of the idle/output timeout reset logic.

---

### [MEDIUM] No SQLite database backup strategy

**File:** `src/db.ts`, `store/messages.db`

The SQLite database is the single point of truth for all persistent state: registered groups, session IDs, router cursors, scheduled tasks, and message history. There is no automated backup. The troubleshooting guide advises `rm store/messages.db` as a recovery step for corruption — which destroys all registered group configuration and requires manual re-registration of every group.

SQLite WAL mode is not explicitly configured, so the database uses the default journal mode (DELETE), which is less crash-resilient than WAL.

---

### [MEDIUM] No health check endpoint

The service has no HTTP health endpoint, no `/healthz`, no way for an external watchdog or uptime monitor to verify the service is alive and processing messages. Systemd's `Restart=on-failure` catches crashes, but not hung states: if the polling loop stalls (e.g., a database lock deadlock, or the Telegram long-poll connection silently drops), the process stays alive and systemd reports it as healthy while no messages are processed.

---

### [MEDIUM] `pino-pretty` is a hard dependency, not a dev dependency

**File:** `package.json`, line 28

`pino-pretty` is listed under `dependencies` rather than `devDependencies`. This means it is installed in production (`npm install --omit=dev` would not remove it, but it signals incorrect intent and adds ~15MB of packages including syntax-highlight libraries to the production footprint).

---

### [MEDIUM] No `LimitNOFILE` or `MemoryMax` in systemd unit

**File:** `agentforge.service.template`

The security hardening block is fully commented out. For a service that spawns subprocesses that each open their own file handles and allocate their own heap, no resource limits means a runaway agent or IPC loop can exhaust system file descriptors or memory without being contained at the service level.

---

### [MEDIUM] Build does not rebuild agent-runner-src automatically

**File:** `package.json` scripts section

`npm run build` compiles only the orchestrator TypeScript (`src/`). The agent runner (`agent-runner-src/`) is a separate project that must be built independently. The service template's `ExecStart` points to `dist/index.js` (the orchestrator), but the orchestrator spawns `agent-runner-src/dist/index.js` at runtime. If someone runs `npm run build` after modifying agent runner source, they will deploy a stale agent binary without any warning.

The `setup.sh` script handles this on initial setup, but there is no `prebuild` hook, no `release:check` integration, and no CI enforcement. The `CLAUDE.md` developer notes say "Always restart the service after building" but say nothing about the two-build requirement.

---

### [MEDIUM] `WorkingDirectory` is set to the git checkout root

**File:** `agentforge.service.template`, line 9

```
WorkingDirectory={{WORKING_DIR}}
```

`src/config.ts` uses `process.cwd()` as `PROJECT_ROOT` for resolving relative paths. This couples the service to the exact directory where it was installed. If the project is moved or the home directory changes (e.g., user rename, mount point change), the service silently breaks because all file paths are computed from the old `cwd`. A conventional `/var/lib/agentforge` data directory with `DATA_DIR` set explicitly in `.env` would decouple runtime data from the source checkout.

---

### [LOW] No `.env.example` referenced in the codebase for new installs

The troubleshooting docs and `setup.sh` reference a `.env.example` file (`cp .env.example .env`), but no such file exists in the repository. A new operator must reconstruct the full variable list from `src/config.ts` and scattered documentation. The `.env` variable list in `docs/INSTALLATION.md` (if it exists) is the only canonical reference.

---

### [LOW] `Restart=on-failure` vs `Restart=always`

**File:** `agentforge.service.template`, line 20

The template uses `Restart=on-failure` which does not restart on clean exits (code 0). The `main()` function in `src/index.ts` exits with code 0 on `SIGTERM` (graceful shutdown). This is correct behavior — a `systemctl stop` or `systemctl restart` should not trigger an unwanted auto-restart loop. However, the `CLAUDE.md` docs show `Restart=always` as an example, which would cause the service to restart even after intentional stops. If anyone copies the `CLAUDE.md` example into their unit file, the service becomes impossible to stop without `systemctl disable`.

---

### [LOW] No timestamped deploy log or version tracking

There is no mechanism to record when a deploy happened, what git SHA is running, or how long the service has been on the current build. `journalctl` shows startup messages but these are not tagged with the git commit SHA. When diagnosing issues, it is impossible to tell from logs alone whether a bug was introduced in the current deploy or a previous one.

---

## Recommendations

### 1. Fix the `pino-pretty` production issue

Switch the logger to emit plain JSON in production and only use `pino-pretty` when a TTY is attached or when `NODE_ENV=development`.

```typescript
// src/logger.ts
import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development' || process.stdout.isTTY;

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  isDev
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined,
);
```

Move `pino-pretty` to `devDependencies` in `package.json`. The production service writing to journald will emit structured JSON that `journalctl -o json` and any log shipper can consume directly.

---

### 2. Add logrotate configuration for agent log files

Create `/etc/logrotate.d/agentforge-agent-logs`:

```
/home/user/agentforge/groups/*/logs/agent-*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 user user
    sharedscripts
}
```

Or, since these are discrete run logs (not append-mode logs), add a cleanup script as a systemd timer that removes files older than 14 days:

**`/etc/systemd/system/agentforge-log-cleanup.service`:**
```ini
[Unit]
Description=AgentForge agent log cleanup

[Service]
Type=oneshot
User=user
ExecStart=/usr/bin/find /home/user/agentforge/groups -name "agent-*.log" -mtime +14 -delete
ExecStart=/usr/bin/find /home/user/agentforge/data/ipc/errors -name "*.json" -mtime +7 -delete
```

**`/etc/systemd/system/agentforge-log-cleanup.timer`:**
```ini
[Unit]
Description=Run AgentForge log cleanup daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with: `sudo systemctl enable --now agentforge-log-cleanup.timer`

---

### 3. Add automated SQLite backups

Add a companion systemd timer that runs a daily SQLite backup using the `.backup` API (which is safe to run while the service is live, as SQLite's backup API uses a read lock, not an exclusive lock):

**`/etc/systemd/system/agentforge-db-backup.service`:**
```ini
[Unit]
Description=AgentForge SQLite backup

[Service]
Type=oneshot
User=user
ExecStart=/usr/bin/sqlite3 /home/user/agentforge/store/messages.db ".backup /home/user/agentforge/store/messages.db.$(date +%%Y%%m%%d)"
ExecStart=/usr/bin/find /home/user/agentforge/store -name "messages.db.*" -mtime +7 -delete
```

**`/etc/systemd/system/agentforge-db-backup.timer`:**
```ini
[Unit]
Description=Daily AgentForge DB backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Additionally, enable WAL mode on the SQLite database for better crash resilience. This can be done once manually:

```bash
sqlite3 store/messages.db "PRAGMA journal_mode=WAL;"
```

Or added as a one-time migration in `createSchema()` in `src/db.ts`.

---

### 4. Add resource limits to the systemd unit

Uncomment and configure the security hardening section in `agentforge.service.template`:

```ini
[Service]
# ... existing config ...

# Resource limits
MemoryMax=2G
MemorySwapMax=0
LimitNOFILE=65536
TasksMax=256

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/user/agentforge/store /home/user/agentforge/data /home/user/agentforge/groups /data
```

`MemoryMax=2G` caps the orchestrator. Agent subprocesses are not covered by the service cgroup unless they are spawned as transient units; for baremetal Node.js children, the most practical limit is to add `--max-old-space-size=512` to the node invocation in `runContainerAgent`:

```typescript
const agentProcess = spawn(
  'node',
  ['--max-old-space-size=512', path.join(process.cwd(), 'agent-runner-src/dist/index.js')],
  // ...
);
```

This caps each agent's V8 heap at 512MB, still ample for Claude SDK workloads.

---

### 5. Add a minimal health check mechanism

Since this is a personal service with no inbound HTTP, a lightweight health file approach works well without adding a web server dependency:

In the message loop in `src/index.ts`, write a heartbeat file on every successful poll iteration:

```typescript
// Inside startMessageLoop(), after processing messages:
fs.writeFileSync(
  path.join(DATA_DIR, 'health'),
  JSON.stringify({ ts: new Date().toISOString(), uptime: process.uptime() }),
);
```

Then add a `WatchdogSec` to the systemd unit combined with `sd_notify` calls, or create a simple external check script:

**`scripts/health-check.sh`:**
```bash
#!/bin/bash
HEALTH_FILE="/home/user/agentforge/data/health"
MAX_AGE_SECONDS=30  # Should update every POLL_INTERVAL (2s default)

if [ ! -f "$HEALTH_FILE" ]; then
  echo "CRITICAL: health file missing"
  exit 2
fi

FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$HEALTH_FILE") ))
if [ "$FILE_AGE" -gt "$MAX_AGE_SECONDS" ]; then
  echo "CRITICAL: health file is ${FILE_AGE}s old (max ${MAX_AGE_SECONDS}s)"
  exit 2
fi

echo "OK: service healthy (last update ${FILE_AGE}s ago)"
exit 0
```

This script can be called by cron, a monitoring tool, or manually.

---

### 6. Unify the two-build process

Add a `prebuild` script that builds the agent runner before the orchestrator, or create a top-level `build:all` target:

```json
// package.json
"scripts": {
  "build": "npm run build:runner && tsc",
  "build:runner": "npm --prefix agent-runner-src run build",
  "release:check": "npm run typecheck && npm run format:check && npm test && npm run build:runner"
}
```

This ensures `npm run build` always produces a consistent binary pair. Update `CLAUDE.md` to reference `npm run build` as the single command for a full rebuild.

---

### 7. Enable SQLite WAL mode at init time

In `src/db.ts`, add WAL mode configuration immediately after opening the database, before `createSchema()`:

```typescript
export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');  // Safe with WAL; faster than FULL
  createSchema(db);
  migrateJsonState();
}
```

WAL mode allows concurrent readers while a writer is active, which reduces the chance of "database is locked" errors during high-throughput periods when IPC polling, message polling, and scheduler polling all attempt reads simultaneously.

---

### 8. Add a deploy script that logs the git SHA

Create `scripts/deploy.sh`:

```bash
#!/bin/bash
set -e

GIT_SHA=$(git rev-parse --short HEAD)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BUILD_TIME=$(date +%s)

echo "[$TIMESTAMP] Deploying $GIT_SHA"

# Build both projects
npm run build

# Verify agent runner is fresh
RUNNER_MTIME=$(stat -c %Y agent-runner-src/dist/index.js)
if [ "$RUNNER_MTIME" -lt "$BUILD_TIME" ]; then
  echo "ERROR: agent-runner-src/dist/index.js was not updated by build"
  exit 1
fi

# Write a deploy marker for logs and health checks
echo "{\"sha\":\"$GIT_SHA\",\"deployedAt\":\"$TIMESTAMP\"}" > data/deploy.json

sudo systemctl restart agentforge.service
echo "[$TIMESTAMP] Deploy complete: $GIT_SHA"
```

This gives every deployment a traceable SHA in the data directory and in the service logs.

---

### 9. Create a `.env.example` file

The current install experience requires reading `src/config.ts` to discover all available configuration variables. A `.env.example` file with every variable documented, sane defaults, and inline comments eliminates this friction:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here
ANTHROPIC_API_KEY=your_api_key_here   # OR CLAUDE_CODE_OAUTH_TOKEN

# Identity
ASSISTANT_NAME=AgentForge
MAIN_GROUP_FOLDER=main

# Polling intervals (milliseconds)
POLL_INTERVAL=2000
SCHEDULER_POLL_INTERVAL=60000
IPC_POLL_INTERVAL=1000

# Agent limits
AGENT_TIMEOUT=1800000       # 30 minutes
IDLE_TIMEOUT=1800000        # 30 minutes
MAX_CONCURRENT_PROCESSES=5

# Logging (trace, debug, info, warn, error)
LOG_LEVEL=info

# Optional: Telegram bot pool for agent swarms
# TELEGRAM_BOT_POOL=token1,token2,token3

# Optional: Gmail integration
# GMAIL_USER=you@gmail.com
# GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
# GMAIL_TRIGGER_LABEL=AgentForge

# Optional: custom data paths
# DATA_DIR=/data
# STORE_DIR=/var/lib/agentforge/store
# GROUPS_DIR=/var/lib/agentforge/groups

# Timezone for cron tasks (default: system timezone)
# TZ=America/New_York
```

---

### 10. IPC error directory cleanup

Add a size or age cap on `data/ipc/errors/` to the log cleanup timer (see Recommendation 2). Additionally, consider adding a warning log when the error directory exceeds a threshold (e.g., 50 files), which would surface in `journalctl` and be visible to an attentive operator:

```typescript
// In startIpcWatcher(), on each poll cycle:
const errorDir = path.join(ipcBaseDir, 'errors');
if (fs.existsSync(errorDir)) {
  const errorCount = fs.readdirSync(errorDir).length;
  if (errorCount > 50) {
    logger.warn({ errorCount }, 'IPC error directory has accumulated many files — manual cleanup may be needed');
  }
}
```

---

## Ideas & Proposals

### [IDEA] systemd `sd_notify` watchdog integration

Instead of a file-based health check, integrate the `sd_notify` watchdog protocol. This requires adding a small native module or calling `sd_notify` via a subprocess, but gives systemd native awareness of whether the service's event loop is alive. The unit file gains:

```ini
[Service]
WatchdogSec=60s
NotifyAccess=main
```

And the message loop calls `sd_notify(0, "WATCHDOG=1")` on each successful iteration. If the loop stalls for 60 seconds, systemd automatically restarts the service — even if the process is still alive.

---

### [IDEA] Structured deploy manifest in dist/

Embed a `dist/build-info.json` file as part of the TypeScript build output:

```json
{
  "gitSha": "abc1234",
  "buildTime": "2026-02-19T10:00:00Z",
  "nodeVersion": "v22.11.0"
}
```

The orchestrator can read this at startup and include `gitSha` in every structured log line, making it trivial to correlate logs with code versions across rolling updates.

---

### [IDEA] Message retention policy with configurable TTL

Add a scheduled daily job (as a built-in AgentForge task, not a cron) that deletes messages older than a configurable TTL (default: 90 days). The query is straightforward:

```sql
DELETE FROM messages
WHERE timestamp < datetime('now', '-90 days');
```

Followed by a `VACUUM` to reclaim page space. This keeps the SQLite file from growing indefinitely and is the correct long-term fix for DB size growth.

---

### [IDEA] Two-phase deploy with smoke test

Before restarting the live service, run a quick sanity check that the new build can at least start and connect:

```bash
# In scripts/deploy.sh
timeout 10 node dist/index.js --smoke-test 2>&1 | grep "Database initialized"
if [ $? -ne 0 ]; then
  echo "Smoke test failed — aborting deploy"
  exit 1
fi
```

This requires a `--smoke-test` flag in `src/index.ts` that initializes the database and exits 0 without connecting to Telegram. It catches the most common deploy failures (missing env var, DB migration error, syntax error in compiled JS) before the service restarts.

---

### [IDEA] Operational runbook in docs/

The `docs/TROUBLESHOOTING.md` is already a good start, but an operational runbook (a short, step-by-step checklist for the most common operational scenarios) would complement it:

- **Daily health check** — what to look at, what normal looks like
- **Deploy procedure** — exact commands in order, verification steps
- **Disk space emergency** — which directories to clear first, in what order
- **DB corruption recovery** — backup restore procedure with group re-registration steps
- **Stuck agent** — how to identify, safely kill, and resume

This is distinct from troubleshooting (reactive) — a runbook is proactive and scripted, written to be followed under pressure.

---

### [IDEA] `logrotate` for journald output (optional)

For operators running the service long-term, consider adding journal vacuum configuration to prevent the systemd journal from growing without bound:

```bash
# In install-service.sh or as a note in docs:
sudo journalctl --vacuum-time=30d
```

Or a persistent journal config in `/etc/systemd/journald.conf`:
```ini
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
```

This is a host-level concern, not an application concern, but worth documenting in the operational runbook since AgentForge's verbose logging under `LOG_LEVEL=debug` can generate substantial journal volume.

---

## Summary Table

| Issue | Severity | Effort | Impact |
|-------|----------|--------|--------|
| `pino-pretty` in production | HIGH | Low (30 min) | CPU, log quality |
| No agent log rotation | HIGH | Low (1 hour) | Disk exhaustion |
| IPC error dir accumulates | HIGH | Low (30 min) | Disk exhaustion |
| No resource limits on agent procs | MEDIUM | Low (30 min) | OOM risk |
| No SQLite backup | MEDIUM | Medium (2 hours) | Data loss on corruption |
| No health check | MEDIUM | Medium (2 hours) | Silent failure detection |
| `pino-pretty` in wrong dep group | MEDIUM | Low (5 min) | Correctness, bundle size |
| No `LimitNOFILE`/`MemoryMax` | MEDIUM | Low (30 min) | Resource exhaustion |
| Two-build process not unified | MEDIUM | Low (30 min) | Stale deploy risk |
| `WorkingDirectory` path coupling | MEDIUM | Medium (1 hour) | Portability |
| Missing `.env.example` | LOW | Low (30 min) | Operator experience |
| `Restart=always` in CLAUDE.md | LOW | Low (5 min) | Incorrect docs |
| No deploy SHA tracking | LOW | Low (1 hour) | Observability |
