# Tools - Environment & Skills Reference

Environment-specific notes and tips for using AgentForge's tools and skills.

## Environment

- **OS**: Linux (Ubuntu/Debian)
- **Shell**: bash
- **Node.js**: Available (check version with `node --version`)
- **Python**: Available (check version with `python3 --version`)
- **Git**: Available for version control

## Workspace Structure

```
/workspace/group/           # Your isolated workspace
  ├── CLAUDE.md            # Group-specific instructions (loaded by Claude Code)
  ├── AGENTS.md            # Safety & operational guidelines
  ├── SOUL.md              # Identity & behavioral boundaries
  ├── TOOLS.md             # This file
  ├── USER.md              # User preferences
  ├── memory.md            # Long-term facts
  └── memory/              # Daily logs
      └── YYYY-MM-DD.md

/workspace/global/          # Shared resources
  ├── CLAUDE.md            # Global instructions
  ├── AGENTS.md            # Global safety defaults
  ├── SOUL.md              # Shared identity
  └── TOOLS.md             # Shared tool notes

$WORKSPACE_IPC/             # IPC directory
  ├── input/               # Incoming tasks
  ├── messages/            # Outgoing messages
  └── tasks/               # Scheduled tasks
```

## Available Tools (via MCP)

AgentForge provides tools through the Model Context Protocol (MCP):

### Core Tools

- `mcp__agentforge__send_message` - Send messages to chat while still processing
- `mcp__agentforge__schedule_task` - Schedule future or recurring tasks
- `mcp__agentforge__list_tasks` - List scheduled tasks
- `mcp__agentforge__cancel_task` - Cancel a scheduled task
- `mcp__agentforge__get_groups` - List all registered groups
- `mcp__agentforge__switch_group` - Switch to a different group context

### Web Browsing

- `agent-browser` - Interactive web browser for scraping and automation
  - Open pages, click elements, fill forms
  - Take screenshots, extract data
  - Useful for web research and automation tasks

## Skills

Skills are loaded from `/workspace/group/.claude/skills/`:

- Check available skills with `/help` or by reading `.claude/skills/` directory
- Skills are synced from `agentforge/skills/` to each group's session directory
- Add new skills by creating subdirectories in `agentforge/skills/`

## Common Patterns

### Scheduling a Daily Task

```typescript
import fs from 'fs';
import path from 'path';

const ipcDir = process.env.WORKSPACE_IPC!;
const taskFile = path.join(ipcDir, 'input', `task-${Date.now()}.json`);

fs.writeFileSync(
  taskFile,
  JSON.stringify({
    type: 'schedule_task',
    prompt: 'Send me a morning summary',
    schedule_type: 'daily',
    schedule_value: '08:00',
    schedule_timezone: 'America/New_York',
  }),
);
```

### Sending an Immediate Message

```typescript
// While you're still working, send an acknowledgment
await mcp__agentforge__send_message({
  message: 'Got it! Working on that now...',
});
```

### Reading Daily Memory

```typescript
import fs from 'fs';
import path from 'path';

const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const memoryFile = path.join('/workspace/group/memory', `${today}.md`);

if (fs.existsSync(memoryFile)) {
  const todaysMemory = fs.readFileSync(memoryFile, 'utf-8');
  // Process today's context...
}
```

### Updating Long-term Memory

```typescript
import fs from 'fs';

// Append to memory.md
const memoryPath = '/workspace/group/memory.md';
const newFact =
  '\n\n## User Preference\n\nPrefers concise summaries over detailed reports.\n';

fs.appendFileSync(memoryPath, newFact);
```

## File Path Guidelines

Always use absolute paths or workspace-relative paths:

- ✅ `/workspace/group/myfile.txt`
- ✅ `./myfile.txt` (relative to CWD)
- ✅ `path.join(process.env.WORKSPACE_GROUP!, 'myfile.txt')`
- ❌ `~/myfile.txt` (home directory may not be accessible)

## Debugging Tips

- Check service logs: `sudo journalctl -u agentforge.service -f`
- Verify environment variables: `echo $WORKSPACE_GROUP`
- Check IPC directory: `ls -la $WORKSPACE_IPC/input`
- Review group's CLAUDE.md for specific instructions
- Check daily memory for recent context

## Performance Considerations

- Avoid reading large files without limits (use `head`, `tail`, or line ranges)
- Clean up temporary files after use
- Use streaming for large data operations
- Set reasonable timeouts for long-running commands
- Monitor memory usage (check with `free -h`)

## Security Notes

- Never expose secrets in chat messages or logs
- Validate user inputs before shell execution
- Use parameterized database queries
- Check file permissions before operations
- Sanitize outputs to prevent injection attacks
