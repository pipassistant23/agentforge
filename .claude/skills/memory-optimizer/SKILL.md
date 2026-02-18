# Memory Optimizer Skill

Optimize context window usage and maintain the three-tier memory system.

## When to Use

- User mentions "memory bloat", "context window issues", "token usage"
- Want to optimize CLAUDE.md or memory structure
- Want automated memory maintenance
- Ask about memory best practices
- Setting up memory system for a new group

## What This Skill Does

1. **Audit context window** - Measure token cost of all injected files
2. **Provide optimization templates** - Optimized CLAUDE.md, memory structure
3. **Explain three-tier system** - Architecture, rationale, best practices
4. **Setup dream cycle** - Automated nightly memory consolidation
5. **Verify QMD integration** - Check semantic search is working

## Tools Provided

### Audit Script

Measure context window usage for a group:

```bash
scripts/audit-context.sh main
```

Shows:
- Tier 1 (always loaded) token cost
- Tier 2 (searchable) files inventory
- Tier 3 (on-demand) summary
- Warnings if CLAUDE.md exceeds 500 tokens

### Initialize Memory Tasks

Set up dream cycle and morning brief:

```bash
npx tsx scripts/init-memory-tasks.ts
```

Creates two scheduled tasks:
- **Dream cycle** (11:30 PM Eastern, silent): Nightly memory consolidation
- **Morning brief** (8:00 AM Eastern, announced): Conversational summary

### File Templates

Located in `groups/main/memory/`:

- `conventions.md` - Three-tier system rationale
- `admin-guide.md` - Group management procedures
- `messaging-guide.md` - Communication best practices
- `CLAUDE.md.new` - Optimized ~500 token template

## Architecture

### Three-Tier Memory System

**Tier 1: Always Injected (~500 tokens max)**
- `CLAUDE.md` - Orientation only
- Loaded on every agent run
- Keep lean: active focus + pointers to Tier 2

**Tier 2: Searchable On-Demand (zero cost until queried)**
- `memory/*.md` - Daily logs, topic files, briefs
- `conversations/` - Archived transcripts
- Indexed by QMD for semantic search
- Progressive disclosure pattern

**Tier 3: Explicit File Reads (on-demand)**
- Any file via Read tool
- Skills, documentation, reference material
- Only costs tokens when loaded

### QMD Integration

**Semantic search tools:**
- `mcp__qmd__qmd_search` - Fast BM25 keyword search
- `mcp__qmd__qmd_vector_search` - Semantic vector search
- `mcp__qmd__qmd_deep_search` - Hybrid search with query expansion and reranking
- `mcp__qmd__qmd_get` - Retrieve document by path

**Features:**
- BM25 + vector embeddings + LLM reranking
- Temporal decay (30-day half-life for dated memories)
- Fully local (~2GB models auto-downloaded)
- MCP integration for clean tool interface

### Dream Cycle

**Nightly consolidation (11:30 PM Eastern):**
1. Review today's daily log
2. Search transcripts for unsaved items
3. Connect patterns across recent days
4. Maintain CLAUDE.md token budget (move detail to topic files)
5. Move stale active focus to daily/topic files
6. Write brief to `memory/briefs/YYYY-MM-DD.md`

**Silent** - no message to user.

**Morning brief (8:00 AM Eastern):**
- Read last night's brief
- Check active focus in CLAUDE.md
- Deliver conversational summary to Telegram

**Announced** - sent to user.

## Usage Examples

### Optimize Existing Group

1. Audit current token usage:
   ```bash
   scripts/audit-context.sh main
   ```

2. If CLAUDE.md > 500 tokens, split it:
   - Keep orientation in CLAUDE.md
   - Move detail to `memory/<topic>.md`
   - Add pointers to topic files

3. Replace CLAUDE.md with optimized template:
   ```bash
   mv groups/main/CLAUDE.md groups/main/CLAUDE.md.old
   mv groups/main/CLAUDE.md.new groups/main/CLAUDE.md
   ```

4. Verify memory search works:
   - Use `mcp__qmd__qmd_search("topic")` to query memory
   - Check QMD indexed the memory/ directory

### Set Up New Group

1. Create group directory:
   ```bash
   mkdir -p groups/{group-name}/memory/briefs
   ```

2. Copy optimized CLAUDE.md template:
   ```bash
   cp groups/main/CLAUDE.md.new groups/{group-name}/CLAUDE.md
   ```

3. Copy memory conventions:
   ```bash
   cp groups/main/memory/conventions.md groups/{group-name}/memory/
   ```

4. Run QMD initialization (automatic on first agent run)

5. Optional: Set up dream cycle for this group (modify init script)

### Enable Dream Cycle

1. Get your Telegram DM chat ID:
   - Send a message to your bot
   - Check logs or use Telegram API to get chat ID

2. Set environment variables in `.env`:
   ```bash
   MAIN_DM_CHAT_ID=123456789
   DREAM_CYCLE_TIMEZONE=America/New_York
   ```

3. Run initialization script:
   ```bash
   npx tsx scripts/init-memory-tasks.ts
   ```

4. Restart service:
   ```bash
   sudo systemctl restart agentforge.service
   ```

5. Verify tasks scheduled:
   - Use `mcp__nanoclaw__list_tasks` to see scheduled tasks
   - Check next run times

## Best Practices

### CLAUDE.md Guidelines

**Keep under 500 tokens:**
- Orientation bullets only
- Current focus (active projects)
- User preferences (compact)
- Pointers to detailed topic files

**Avoid:**
- Procedural details (move to memory/ files)
- Biographical information (create `memory/user-profile.md`)
- Project documentation (create `memory/projects/<name>.md`)
- API references (create `memory/apis/<name>.md`)

### Daily Log Guidelines

**Format:**
```markdown
# YYYY-MM-DD

## Session 1 (HH:MM AM/PM - HH:MM AM/PM)
- Bullet points summarizing work
- Decisions made
- Files created/modified

## Session 2 (...)
- ...
```

**Append throughout the day:**
- Each session summary added to today's log
- Pre-compression hook appends automatically
- Dream cycle consolidates at night

### Topic File Guidelines

**When to create:**
- Cluster of related information
- Repeated queries on same topic
- Biographical/contextual detail
- Reference material

**Structure:**
```markdown
# Topic Name

Brief introduction (2-3 sentences)

## Section 1
Detail here...

## Section 2
Detail here...

## See Also
- Related topic file 1
- Related topic file 2
```

### Search Strategy

**Progressive disclosure:**
1. Start with CLAUDE.md for orientation
2. Search memory/ for specific details
3. Read full files only when needed

**Query tips:**
- Use `qmd_search` for keyword matching (fast)
- Use `qmd_deep_search` for semantic queries (best quality)
- Use `qmd_get` to retrieve specific known files
- Include context in queries: "database optimization tips" vs just "database"

## Troubleshooting

### QMD Not Indexing Files

**Symptom:** `qmd_search` returns no results

**Fix:**
1. Check QMD initialized:
   ```bash
   ls /home/dustin/agentforge/data/qmd/main/qmd.db
   ```

2. Manually initialize if needed:
   ```bash
   npx tsx scripts/init-qmd-collections.ts main
   ```

3. Verify collections exist:
   ```bash
   node_modules/@tobilu/qmd/qmd collection list
   ```

### Dream Cycle Not Running

**Symptom:** No briefs in `memory/briefs/`

**Fix:**
1. Check task exists:
   - Use `mcp__nanoclaw__list_tasks`
   - Look for "dream-cycle" task

2. Check task status:
   - Should be "active", not "paused"
   - Check next_run timestamp

3. Check logs:
   ```bash
   sudo journalctl -u agentforge.service -f | grep dream-cycle
   ```

4. Verify MAIN_DM_CHAT_ID in .env

### Morning Brief Not Delivered

**Symptom:** Dream cycle runs but no morning message

**Fix:**
1. Check MAIN_DM_CHAT_ID is correct
2. Check "morning-brief" task is active
3. Verify brief file exists:
   ```bash
   ls -la groups/main/memory/briefs/
   ```

4. Check task logs for errors

### Context Window Still Large

**Symptom:** Audit shows >2k tokens after optimization

**Fix:**
1. Move more detail from CLAUDE.md to memory/ files
2. Check if global/CLAUDE.md is large (loaded for non-main groups)
3. Verify today's daily log isn't huge (split into sessions)
4. Consider disabling auto-load of yesterday's log (code change)

## References

- Three-tier system rationale: `groups/main/memory/conventions.md`
- QMD documentation: `node_modules/@tobilu/qmd/README.md`
- Agent Teams instructions: `groups/global/CLAUDE.md`
- Audit script source: `scripts/audit-context.sh`
- Init script source: `scripts/init-memory-tasks.ts`
