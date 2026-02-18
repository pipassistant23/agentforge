# AgentForge Template System

Structured memory and behavior management for AgentForge agents.

## Migration Complete

AgentForge now uses **AGENTS.md** as the primary instruction file, following standard conventions used by other AI coding tools.

## Overview

The template system provides a multi-layered approach to agent context and memory, following [OpenClaw conventions](https://docs.openclaw.ai/reference/templates):

| File | Purpose | Scope | Loaded At |
|------|---------|-------|-----------|
| `BOOTSTRAP.md` | Initial setup guide (delete after first run) | Global → Group | First session only |
| `IDENTITY.md` | Name, nature, vibe, emoji, avatar | Global → Group | Session start |
| `SOUL.md` | Core truths, boundaries, personality | Global → Group | Session start |
| `AGENTS.md` | Operational guidelines & safety defaults | Global or Group | Session start |
| `TOOLS.md` | Environment & tools reference | Global → Group | Session start |
| `USER.md` | User preferences & context | Per-group | Session start |
| `memory.md` | Long-term facts & patterns | Per-group | Session start |
| `memory/YYYY-MM-DD.md` | Daily conversation logs | Per-group | Session start (today + yesterday) |
| `HEARTBEAT.md` | Periodic task definitions | Global → Group | Background checks |
| `memory/heartbeat-state.json` | Heartbeat execution tracking | Per-group | Automatic |

## File Hierarchy

```
groups/
├── global/
│   ├── BOOTSTRAP.md       # Initial setup template (synced to new groups)
│   ├── IDENTITY.md        # Shared identity template
│   ├── SOUL.md            # Shared behavioral template
│   ├── AGENTS.md          # Global operational guidelines (non-main groups)
│   ├── TOOLS.md           # Shared tool reference template
│   └── HEARTBEAT.md       # Shared heartbeat task template
│
└── main/  (or any group)
    ├── BOOTSTRAP.md       # (Synced from global/, delete after setup)
    ├── IDENTITY.md        # (Synced from global/ on each agent startup)
    ├── SOUL.md            # (Synced from global/ on each agent startup)
    ├── AGENTS.md          # Group-specific operational guidelines (primary instruction file)
    ├── TOOLS.md           # (Synced from global/ on each agent startup)
    ├── HEARTBEAT.md       # (Synced from global/ on each agent startup)
    ├── USER.md            # User preferences for this group
    ├── memory.md          # Long-term facts for this group
    └── memory/
        ├── 2026-02-18.md  # Today's log
        ├── 2026-02-17.md  # Yesterday's log
        ├── heartbeat-state.json  # Heartbeat tracking
        └── ...
```

## How It Works

### Session Startup

When an agent starts, it should read (in order):

1. `BOOTSTRAP.md` - First-time setup guidance (if this is a new agent)
2. `IDENTITY.md` - Learn who you are (name, nature, vibe)
3. `SOUL.md` - Understand core truths and boundaries
4. `AGENTS.md` - Learn operational guidelines and safety defaults
5. `TOOLS.md` - Review available tools and environment
6. `USER.md` - Load user preferences and context
7. `memory.md` - Read long-term facts and patterns
8. `memory/YYYY-MM-DD.md` - Read today's log (if exists)
9. `memory/YYYY-MM-DD.md` - Read yesterday's log (if exists)

This is documented in the "Session Startup" section of `AGENTS.md`.

### During Operation

- Append important context to today's log (`memory/YYYY-MM-DD.md`)
- Update `memory.md` when patterns are confirmed across multiple sessions
- Update `USER.md` when discovering new user preferences

### Automatic Management

The `setupGroupSession()` function in `bare-metal-runner.ts`:
- Syncs `BOOTSTRAP.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, and `HEARTBEAT.md` from `groups/global/` to each group on every agent startup
- Does **not** sync `AGENTS.md` — it is group-specific and managed per group
- Ensures `AGENTS.md`, `USER.md`, and `memory.md` exist in each group workspace (creates with defaults if missing)
- Initializes today's memory log if it doesn't exist
- Creates `memory/heartbeat-state.json` for tracking periodic tasks

## Memory System

### Daily Logs

Daily logs capture ephemeral context:
- Conversations and interactions
- Decisions made during the day
- Temporary context and discoveries
- Progress on tasks

Format: `memory/YYYY-MM-DD.md`

The agent reads today + yesterday for recent continuity (2-day sliding window).

### Long-term Memory

`memory.md` stores persistent facts:
- Confirmed user preferences
- Important project context
- Recurring patterns and decisions
- Key file locations and conventions

Update strategy: Promote facts from daily logs when patterns are confirmed.

### AGENTS.md

The primary instruction file loaded by the agent runner:
- Combined from `groups/global/AGENTS.md` (for non-main groups) and `groups/{group}/AGENTS.md`
- Passed to the Claude SDK as a `systemPrompt.append` value
- Template variables (e.g., `{{ASSISTANT_NAME}}`) are substituted before loading
- Keep concise (~500 tokens max per file) — move details to `memory/` topic files

## Utilities

Memory log initialization is handled automatically by `setupGroupSession()` in `src/bare-metal-runner.ts`. It creates today's daily memory log file (`groups/{folder}/memory/YYYY-MM-DD.md`) if it does not already exist.

Agents read and write to memory files directly using standard file tools (Read, Write, Edit). The expected daily log format is:

```markdown
# YYYY-MM-DD

## Summary

(Daily summary - updated throughout the day)

## Conversations

(Conversation notes appended during the day)
```

## Customization

### Per-Group Templates

To customize templates for a specific group:

1. Edit `groups/{groupFolder}/AGENTS.md` (persistent — not overwritten by global sync)
2. Edit `groups/{groupFolder}/USER.md` (persistent, never overwritten)
3. Edit `groups/{groupFolder}/memory.md` (persistent, never overwritten)

Note: `SOUL.md` and `TOOLS.md` in each group are overwritten on every agent startup from the global templates. Do not make per-group edits to those files — edit the global versions instead.

### Global Templates

To customize behavior across all groups:

1. Edit `groups/global/AGENTS.md`
2. Edit `groups/global/SOUL.md`
3. Edit `groups/global/TOOLS.md`

These are synced to each group on agent startup.

## Benefits

1. **Continuity** - Daily logs provide session-to-session context
2. **Structure** - Clear separation of concerns (identity, safety, memory, instructions)
3. **Scalability** - Template system works for single or multiple groups
4. **Git-friendly** - All files are markdown and can be versioned
5. **Maintainability** - Global templates (`SOUL.md`, `TOOLS.md`) stay consistent across groups via automatic sync

## Future Enhancements

Possible improvements:
- Automatic memory log summarization (weekly/monthly summaries)
- Memory search across historical logs
- MCP tool for appending to daily memory
- Memory analytics and insights
- Template validation and linting
