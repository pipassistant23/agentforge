# Migration to AGENTS.md

AgentForge has migrated from CLAUDE.md to AGENTS.md as the primary instruction file.

## Why?

- **AGENTS.md** is becoming the standard across AI coding tools (Cursor, Windsurf, etc.)
- Better separation of concerns with the template system
- Aligns with community conventions

## What Changed

### Before
- `groups/{name}/CLAUDE.md` - Primary instruction file

### After  
- `groups/{name}/AGENTS.md` - Primary instruction file
- `groups/{name}/SOUL.md` - Identity and behavioral boundaries (synced from global)
- `groups/{name}/TOOLS.md` - Environment reference (synced from global)
- `groups/{name}/USER.md` - User preferences (per-group)
- `groups/{name}/memory.md` - Long-term memory (per-group)
- `groups/{name}/memory/YYYY-MM-DD.md` - Daily logs (per-group)

## Code Changes

1. **agent-runner-src/src/index.ts**
   - Now loads `AGENTS.md` instead of `CLAUDE.md`
   - Variable substitution ({{ASSISTANT_NAME}}) still works

2. **src/bare-metal-runner.ts**
   - Syncs `SOUL.md` and `TOOLS.md` from global to each group
   - Does NOT sync `AGENTS.md` (it's group-specific)
   - Creates AGENTS.md with default content if missing

3. **src/memory-manager.ts** (new)
   - Utilities for daily log management
   - Functions to read/write memory files

## Backwards Compatibility

Old CLAUDE.md files can remain for documentation purposes, but they are no longer loaded by the agent runner.

## Migration Steps for Existing Groups

If you have existing groups with CLAUDE.md:

1. Copy content from `CLAUDE.md` to `AGENTS.md`
2. Optionally keep `CLAUDE.md` for reference or delete it
3. The agent will automatically use `AGENTS.md` on next run

## Benefits

- **Standardization** - Follows emerging conventions
- **Clarity** - AGENTS.md clearly indicates agent instructions
- **Compatibility** - Works with other AI tools that support AGENTS.md
- **Better organization** - Template system separates concerns
