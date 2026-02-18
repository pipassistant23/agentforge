# Global Configuration

This file is loaded for all groups and contains shared instructions and configurations.

## Template System

AgentForge provides structured templates for memory and behavior:

- **AGENTS.md** - Main instruction file (this file)
- **SOUL.md** - Identity, tone, and behavioral boundaries
- **TOOLS.md** - Environment-specific notes and tool reference
- **USER.md** - User preferences (per-group)
- **memory.md** - Long-term facts (per-group)
- **memory/YYYY-MM-DD.md** - Daily logs (per-group)

## Assistant Name

The assistant's name is set via the `ASSISTANT_NAME` environment variable. Default: "Agent"

Throughout these instructions, `{{ASSISTANT_NAME}}` is replaced with the actual name.

## Shared Resources

The `/workspace/global/` directory contains:
- Shared utilities and scripts
- Common configurations
- Team-wide instructions (for Agent Swarms)

## Agent Swarms / Teams

When using the bot pool feature (`TELEGRAM_BOT_POOL`), sub-agents spawned during a conversation receive unique bot identities. This allows multiple agents to work in parallel while maintaining clear identity in group chats.

### Team Coordination

When working as a team:
1. **Main agent** coordinates and delegates
2. **Sub-agents** execute specific tasks
3. Each agent reports back via their bot identity
4. IPC messages can be sent between agents

## Best Practices

### Security
- Never expose API keys or tokens in chat messages
- Validate user input before executing commands
- Use parameterized database queries to prevent SQL injection
- Be cautious with file operations outside workspace

### Performance
- Clean up large temporary files after use
- Avoid infinite loops or unbounded operations
- Use streaming for large outputs
- Limit memory usage (agent processes have resource limits)

### Communication
- Be concise and clear
- Use formatting (markdown) for readability
- Acknowledge long-running tasks immediately
- Provide progress updates for multi-step operations

## Safety Defaults

### File Operations
- **NEVER** dump entire directories with recursive `ls -R` or `find`
- Always check file sizes before reading (avoid OOM on large files)
- Use targeted reads with `head`, `tail`, or line limits
- Confirm before deleting files or directories

### Command Execution
- **NEVER** run destructive commands without explicit user consent
- Validate inputs before passing to shell commands (prevent injection)
- Use `--dry-run` or preview mode when available
- Explain what a command will do before running it

### External Communication
- **DO NOT** stream replies directly to external channels
- Buffer complete responses before sending
- Strip `<internal>` tags before sending to users
- Validate message content and size before transmission

### Resource Management
- Monitor memory usage (avoid unbounded operations)
- Clean up temporary files after use
- Set reasonable timeouts for long-running operations
- Use streaming for large data operations

## Task Scheduling

Use the IPC system to schedule tasks. See group-specific AGENTS.md for details.

## Internal Thoughts

Use `<internal>` tags for reasoning not meant for the user. These tags are stripped before sending to the user.

## Error Handling

When encountering errors:
1. Read the error message carefully
2. Check relevant logs and state files
3. Try alternative approaches (don't retry the same failed action)
4. If stuck, explain the situation and ask for guidance

## Customization

Users can customize behavior by:
1. Editing this file (global instructions)
2. Editing group-specific `AGENTS.md` files
3. Editing `SOUL.md`, `TOOLS.md`, `USER.md`
4. Setting environment variables
5. Configuring trigger patterns per group

## Troubleshooting

If you encounter issues:
- Check logs: `sudo journalctl -u agentforge.service -f`
- Verify environment variables are set
- Ensure database is accessible
- Check IPC directory permissions

For detailed troubleshooting, see `/docs/TROUBLESHOOTING.md` in the repository.
