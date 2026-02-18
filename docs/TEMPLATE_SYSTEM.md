# AgentForge Template System

Structured memory and behavior management for AgentForge agents.

## Migration Complete

AgentForge now uses **AGENTS.md** as the primary instruction file, following standard conventions used by other AI coding tools.

## Overview

The template system provides a multi-layered approach to agent context and memory:

| File | Purpose | Scope | Loaded At |
|------|---------|-------|-----------|
| `AGENTS.md` | Operational guidelines & safety defaults | Global or Group | Session start |
| `SOUL.md` | Identity, tone, behavioral boundaries | Global or Group | Session start |
| `TOOLS.md` | Environment & tools reference | Global or Group | Session start |
| `USER.md` | User preferences & context | Per-group | Session start |
| `memory.md` | Long-term facts & patterns | Per-group | Session start |
| `memory/YYYY-MM-DD.md` | Daily conversation logs | Per-group | Session start (today + yesterday) |

## File Hierarchy

```
groups/
├── global/
│   ├── CLAUDE.md          # Global instructions
│   ├── AGENTS.md          # Global safety defaults
│   ├── SOUL.md            # Shared identity
│   └── TOOLS.md           # Shared tool notes
│
└── main/  (or any group)
    ├── CLAUDE.md          # Group-specific capabilities
    ├── AGENTS.md          # (Copied from global/)
    ├── SOUL.md            # (Copied from global/)
    ├── TOOLS.md           # (Copied from global/)
    ├── USER.md            # User preferences for this group
    ├── memory.md          # Long-term facts for this group
    └── memory/
        ├── 2026-02-18.md  # Today's log
        ├── 2026-02-17.md  # Yesterday's log
        └── ...
```

## How It Works

### Session Startup

When an agent starts, it should read (in order):

1. `AGENTS.md` - Learn operational guidelines and safety defaults
2. `SOUL.md` - Understand identity and behavioral boundaries
3. `TOOLS.md` - Review available tools and environment
4. `USER.md` - Load user preferences and context
5. `memory.md` - Read long-term facts and patterns
6. `memory/YYYY-MM-DD.md` - Read today's log (if exists)
7. `memory/YYYY-MM-DD.md` - Read yesterday's log (if exists)

This is documented in the "Session Startup" section of `CLAUDE.md`.

### During Operation

- Append important context to today's log (`memory/YYYY-MM-DD.md`)
- Update `memory.md` when patterns are confirmed across multiple sessions
- Update `USER.md` when discovering new user preferences

### Automatic Management

The `setupGroupSession()` function in `bare-metal-runner.ts`:
- Syncs `AGENTS.md`, `SOUL.md`, `TOOLS.md` from `groups/global/` to each group
- Ensures `USER.md` and `memory.md` exist (creates with defaults if missing)
- Initializes today's memory log if it doesn't exist

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

### CLAUDE.md

Remains the primary instruction file for Claude Code:
- Group-specific capabilities and tools
- Instructions on what the agent can do
- Loaded by Claude Code's `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` feature

## Utilities

The `src/memory-manager.ts` module provides:

```typescript
import {
  getTodaysMemoryPath,
  getYesterdaysMemoryPath,
  initTodaysMemoryLog,
  appendToTodaysMemory,
  readTodaysMemory,
  readYesterdaysMemory,
  getMemoryContext,
  cleanupOldMemoryLogs,
} from './memory-manager.js';

// Initialize today's log
initTodaysMemoryLog('main');

// Append an entry
appendToTodaysMemory('main', 'User requested weather forecast feature');

// Read memory for session startup
const { today, yesterday } = getMemoryContext('main');

// Clean up old logs (keep last 30 days)
cleanupOldMemoryLogs('main', 30);
```

## Customization

### Per-Group Templates

To customize templates for a specific group:

1. Edit `groups/{groupFolder}/AGENTS.md` (will be overwritten on sync)
2. Edit `groups/{groupFolder}/USER.md` (persistent, never overwritten)
3. Edit `groups/{groupFolder}/memory.md` (persistent, never overwritten)

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
5. **Compatibility** - Works alongside existing CLAUDE.md system

## Migration from CLAUDE.md Only

The template system is additive:
- Existing `CLAUDE.md` files continue to work
- New template files provide additional structure
- No breaking changes to current functionality

Agents are encouraged to read all template files at session start, but falling back to just `CLAUDE.md` still works.

## Future Enhancements

Possible improvements:
- Automatic memory log summarization (weekly/monthly summaries)
- Memory search across historical logs
- MCP tool for appending to daily memory
- Memory analytics and insights
- Template validation and linting
