# Global Configuration

This file is loaded for all groups and contains shared instructions and configurations.

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

## Customization

Users can customize behavior by:
1. Editing this file (global instructions)
2. Editing group-specific `CLAUDE.md` files
3. Setting environment variables
4. Configuring trigger patterns per group

## Troubleshooting

If you encounter issues:
- Check logs: `sudo journalctl -u agentforge.service -f`
- Verify environment variables are set
- Ensure database is accessible
- Check IPC directory permissions

For detailed troubleshooting, see `/docs/TROUBLESHOOTING.md` in the repository.
