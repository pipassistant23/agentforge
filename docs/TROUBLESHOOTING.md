# AgentForge Troubleshooting Guide

This guide covers common issues, how to diagnose them, and solutions.

## Table of Contents

- [Service Won't Start](#service-wont-start)
- [Agent Failures](#agent-failures)
- [IPC Issues](#ipc-issues)
- [Memory Problems](#memory-problems)
- [Message Routing](#message-routing)
- [Database Issues](#database-issues)
- [Debug Techniques](#debug-techniques)

---

## Service Won't Start

### "TELEGRAM_BOT_TOKEN is required"

**Symptom:** Service exits immediately with this error.

**Cause:** The Telegram bot token is not configured.

**Solution:**
```bash
# Add to .env
TELEGRAM_BOT_TOKEN=<your_bot_token>

# Restart service
sudo systemctl restart agentforge.service
```

To get a bot token, see [INSTALLATION.md](INSTALLATION.md).

### Service starts but crashes shortly after

**Symptom:** `systemctl status agentforge.service` shows it exited with code 1.

**Diagnosis:**
```bash
# Check recent logs
sudo journalctl -u agentforge.service -n 50

# Or with timestamps
sudo journalctl -u agentforge.service --no-pager -n 100 | tail -30
```

**Common causes:**

1. **Database corruption:**
   ```bash
   # Check SQLite database integrity
   sqlite3 /path/to/store/agentforge.db ".tables"

   # If corrupted, back it up and delete
   rm /path/to/store/agentforge.db
   # Service will recreate on next start
   ```

2. **Missing directories:**
   ```bash
   # Ensure directories exist and are writable
   mkdir -p /var/agentforge/store /var/agentforge/groups /var/agentforge/data
   chown agentforge:agentforge /var/agentforge/*
   chmod 755 /var/agentforge/*
   ```

3. **Process already running:**
   ```bash
   # Check for zombie processes
   ps aux | grep agentforge

   # Kill any stray processes
   pkill -f "node dist/index.js"

   # Then restart
   sudo systemctl restart agentforge.service
   ```

### "No such file or directory: agent-runner/dist/index.js"

**Cause:** Agent runner source was not built.

**Solution:**
```bash
# Build the main project
npm run build

# Make sure agent runner is built (in agent-runner-src/)
cd agent-runner-src
npm run build
cd ..

# Restart service
sudo systemctl restart agentforge.service
```

### Port or permission denied errors

**Symptom:** `listen EADDRINUSE` or `permission denied`

**Cause:** Another process is using the port, or the service doesn't have permissions.

**Solution:**
```bash
# Check if another bot is running
systemctl status agentforge.service
ps aux | grep agentforge

# Verify file permissions
ls -la /var/agentforge/
ls -la store/agentforge.db

# If needed, fix permissions
sudo chown agentforge:agentforge /var/agentforge -R
sudo chmod 755 /var/agentforge -R
```

---

## Agent Failures

### Agent timeout errors

**Symptom:** Logs show "Agent timed out after 1800000ms"

**Causes:**
1. Agent is genuinely slow (working on complex task)
2. Agent is stuck in a loop
3. Agent crashed silently

**Solution:**

1. **Increase timeout for specific groups:**
   ```typescript
   // In IPC task registration or direct update
   {
     type: 'register_group',
     agentConfig: { timeout: 300000 } // 5 minutes
   }
   ```

2. **Check agent logs:**
   ```bash
   # Logs are stored per-group
   tail -f groups/main/logs/agent-*.log

   # Look for errors in the most recent log
   ls -lt groups/main/logs/ | head -5
   cat groups/main/logs/agent-2024-01-15T12-34-56.log
   ```

3. **Check available memory:**
   ```bash
   free -h

   # If memory is low, reduce MAX_CONCURRENT_PROCESSES
   # Edit .env: MAX_CONCURRENT_PROCESSES=2
   ```

### "Agent process exited with code 1"

**Symptom:** Agent crashes immediately or during execution.

**Diagnosis:**
```bash
# Check the agent process log
cat groups/main/logs/agent-*.log | grep -A 20 "Stderr"

# The error message should be in the stderr section
```

**Common causes:**

1. **Missing dependencies in agent-runner:**
   ```bash
   cd agent-runner-src
   npm install
   npm run build
   cd ..
   npm run build
   sudo systemctl restart agentforge.service
   ```

2. **Agent file is corrupted:**
   ```bash
   # Rebuild
   npm run build

   # Verify it exists and is executable
   ls -la agent-runner-src/dist/index.js
   ```

3. **Node version mismatch:**
   ```bash
   # Check required version
   grep "engines" package.json

   # Check installed version
   node --version

   # If mismatch, update Node.js
   ```

### Agent doesn't respond to messages

**Symptom:** Messages are stored but agent never processes them.

**Diagnosis:**
```bash
# Check if messages are in the database
sqlite3 store/agentforge.db "SELECT COUNT(*) FROM messages;"

# Check if group is registered
sqlite3 store/agentforge.db "SELECT * FROM registered_groups;"

# Check router state (last processed timestamp)
sqlite3 store/agentforge.db "SELECT * FROM router_state;"
```

**Solutions:**

1. **Group not registered:**
   - Send `/chatid` to the bot to get the chat ID
   - Use the main group's agent to register it
   - See [INSTALLATION.md](INSTALLATION.md) for details

2. **Trigger pattern not matching:**
   ```bash
   # Check configured trigger
   echo $TRIGGER_PATTERN
   # Should be something like: ^@Andy\b

   # Messages must start with: @Andy (at-mention)
   # Or be in the main group (no trigger required)
   ```

3. **Agent process never started:**
   ```bash
   # Check if processes are registered in queue
   # Enable debug logging and watch
   LOG_LEVEL=debug sudo journalctl -u agentforge.service -f

   # Look for "Processing messages" entries
   ```

---

## IPC Issues

### IPC messages not being processed

**Symptom:** Agent writes IPC files but messages don't arrive.

**Diagnosis:**
```bash
# Check if IPC files exist
ls -la data/ipc/*/messages/
ls -la data/ipc/*/tasks/

# Check IPC watcher logs
sudo journalctl -u agentforge.service | grep "IPC"
```

**Common causes:**

1. **IPC directory doesn't exist:**
   Agent assumes `WORKSPACE_IPC` directory exists:
   ```bash
   # Check
   echo $WORKSPACE_IPC
   ls -la $WORKSPACE_IPC

   # Fix
   mkdir -p $WORKSPACE_IPC/messages
   mkdir -p $WORKSPACE_IPC/tasks
   ```

2. **Files have parse errors:**
   ```bash
   # Check error directory
   ls -la data/ipc/errors/

   # Look at what failed
   cat data/ipc/errors/main-*.json

   # Fix the JSON and move back to messages/
   mv data/ipc/errors/main-msg.json data/ipc/main/messages/msg.json
   ```

3. **Authorization denied:**
   ```bash
   # Check logs for "Unauthorized"
   sudo journalctl -u agentforge.service | grep -i "unauthorized"

   # Only main group can register new groups
   # Only own group can send to own group (except main)
   ```

4. **IPC poll interval too slow:**
   ```bash
   # Check configuration
   echo $IPC_POLL_INTERVAL  # Should be 1000 or less

   # If set to value > 5000, files may appear stale
   # Update .env: IPC_POLL_INTERVAL=500
   sudo systemctl restart agentforge.service
   ```

### Task files create errors

**Symptom:** Written task files move to error directory instead of executing.

**Diagnosis:**
```bash
# Check error log
cat data/ipc/errors/main-task-*.json | jq .

# Look for parse errors in logs
sudo journalctl -u agentforge.service | grep "task"
```

**Common issues:**

1. **Invalid cron expression:**
   ```bash
   # Valid cron: "0 9 * * *" (daily at 9 AM)
   # Invalid cron: "every morning"

   # Test cron syntax
   npm test -- src/ipc.test.ts
   ```

2. **Invalid JID format:**
   ```bash
   # Valid: "tg:123456789" or "wa:123456789"
   # Invalid: "telegram:123456789" or just "123456789"
   ```

3. **targetJid not registered:**
   ```bash
   # First register the group
   sqlite3 store/agentforge.db "SELECT jid FROM registered_groups;"
   ```

---

## Memory Problems

### Process uses excessive memory

**Symptom:** `systemctl status` or `top` shows high memory usage.

**Diagnosis:**
```bash
# Check memory per process
ps aux | grep agentforge | grep -v grep

# Use top for real-time view
top -p $(pgrep -f "node dist/index.js" | tr '\n' ',')

# Check if it's growing (memory leak)
watch -n 5 'ps aux | grep "node dist"'
```

**Solutions:**

1. **Reduce concurrent processes:**
   ```bash
   # Edit .env
   MAX_CONCURRENT_PROCESSES=2  # Was 5

   # Restart
   sudo systemctl restart agentforge.service
   ```

2. **Clear old logs:**
   ```bash
   # Logs accumulate in groups/*/logs/
   find groups -name "agent-*.log" -mtime +30 -delete
   ```

3. **Optimize database:**
   ```bash
   # Clean up old messages (keep last 1000)
   sqlite3 store/agentforge.db "DELETE FROM messages WHERE timestamp < (SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 1 OFFSET 1000);"

   # Vacuum to reclaim space
   sqlite3 store/agentforge.db "VACUUM;"
   ```

4. **Check for agent process leaks:**
   ```bash
   # Processes should be cleaned up after task completes
   ps aux | grep node

   # Kill any stray agents
   pkill -f "agent-runner" || true

   # If it happens frequently, there's a bug
   # Report with logs (see Debug Techniques)
   ```

---

## Message Routing

### Messages not reaching agent

**Symptom:** Messages appear in chat but agent never responds.

**Diagnosis:**

1. **Check message storage:**
   ```bash
   sqlite3 store/agentforge.db \
     "SELECT sender_name, content, timestamp FROM messages WHERE chat_jid='tg:123456789' ORDER BY timestamp DESC LIMIT 5;"
   ```

2. **Check trigger pattern:**
   ```bash
   # Messages to non-main groups need trigger
   # Trigger pattern: ^@{ASSISTANT_NAME}\b (case-insensitive)

   # Message must start with @Assistant (or whatever name is set)
   # Examples:
   # ✓ "@Assistant what is 2+2?"
   # ✓ "@assistant help me"
   # ✗ "hey @Assistant"  (doesn't start with @)
   ✗ "@OtherBot message"  (wrong name)
   ```

3. **Check if group is registered:**
   ```bash
   sqlite3 store/agentforge.db \
     "SELECT jid, name, folder FROM registered_groups WHERE jid='tg:123456789';"
   ```

### Messages sent to wrong group

**Symptom:** Message meant for Group A appears in Group B.

**Cause:** JID mismatch or routing error.

**Diagnosis:**
```bash
# Get the correct JID for a chat
# Send /chatid command to bot in the chat
# Bot responds with: Chat ID: tg:123456789

# Verify in database
sqlite3 store/agentforge.db \
  "SELECT jid, name FROM chats ORDER BY last_message_time DESC LIMIT 10;"
```

### Typing indicator not showing

**Symptom:** Agent responds but no typing indicator appears.

**Note:** Typing indicators are optional. Only some channels support them.

**Solution:**
```bash
# Telegram supports typing indicator
# If it's not showing, check channel implementation

# In code: channel.setTyping() is async, may fail silently
# Enable debug logging to see failures
LOG_LEVEL=debug sudo journalctl -u agentforge.service -f
```

---

## Database Issues

### SQLite database corruption

**Symptom:** Errors about "database disk image malformed"

**Solution:**
```bash
# Backup current database
cp store/agentforge.db store/agentforge.db.backup

# Verify corruption
sqlite3 store/agentforge.db "PRAGMA integrity_check;"

# If corrupted, delete and restart
rm store/agentforge.db

# Service will recreate on next start
sudo systemctl restart agentforge.service

# Messages will be lost, but the system will recover
```

### Database locked / slow operations

**Symptom:** Service hangs or logs show "database is locked"

**Cause:** SQLite is synchronous; long operations block everything.

**Solutions:**

1. **Reduce polling frequency:**
   ```bash
   # Increase intervals so DB isn't hammered
   POLL_INTERVAL=5000        # 5 seconds
   SCHEDULER_POLL_INTERVAL=120000  # 2 minutes
   IPC_POLL_INTERVAL=2000    # 2 seconds

   sudo systemctl restart agentforge.service
   ```

2. **Add database indexes:**
   ```bash
   # If messages table is huge, index by timestamp
   sqlite3 store/agentforge.db "CREATE INDEX IF NOT EXISTS idx_chat_time ON messages(chat_jid, timestamp);"
   ```

3. **Migrate to better database:**
   Not currently supported, but you can contribute support for PostgreSQL.

---

## Debug Techniques

### Enable debug logging

```bash
# Show detailed logs
LOG_LEVEL=debug npm start

# Or via systemd
sudo systemctl stop agentforge.service
LOG_LEVEL=debug /home/dustin/agentforge/dist/index.js

# Or even more verbose
LOG_LEVEL=trace npm start
```

Debug output includes:
- Message routing decisions
- IPC file processing
- Channel events
- Database operations
- Agent process lifecycle

### Follow live logs

```bash
# In real-time
sudo journalctl -u agentforge.service -f

# With timestamp and process info
sudo journalctl -u agentforge.service -f --output short-iso

# Last 100 lines
sudo journalctl -u agentforge.service -n 100 --no-pager
```

### Check agent process logs

```bash
# Logs are per-group
ls -la groups/main/logs/

# View most recent
cat groups/main/logs/$(ls -t groups/main/logs/ | head -1)

# Search for errors
grep -i "error\|exception" groups/main/logs/agent-*.log
```

### Inspect database directly

```bash
# List all tables
sqlite3 store/agentforge.db ".schema"

# Check registered groups
sqlite3 store/agentforge.db "SELECT * FROM registered_groups;"

# Check active tasks
sqlite3 store/agentforge.db "SELECT id, group_folder, next_run, status FROM scheduled_tasks WHERE status='active';"

# Count messages
sqlite3 store/agentforge.db "SELECT chat_jid, COUNT(*) FROM messages GROUP BY chat_jid;"

# Check router state
sqlite3 store/agentforge.db "SELECT * FROM router_state;"
```

### Monitor resource usage

```bash
# Real-time process monitor
top -p $(pgrep -f "node dist/index.js")

# One-time snapshot
ps aux | grep agentforge

# Memory usage over time
watch -n 5 'ps aux | grep "node dist"'

# Disk space for data directories
du -sh groups/ data/ store/
```

### Test message formatting

```bash
# Create test messages
cat > test-messages.json << 'EOF'
[
  {
    "id": "1",
    "chat_jid": "tg:123",
    "sender": "user1",
    "sender_name": "Alice",
    "content": "Hello",
    "timestamp": "2024-01-01T12:00:00Z"
  }
]
EOF

# Test formatting via TypeScript
npm run typecheck

# Or write a quick test
npx tsx -e 'import { formatMessages } from "./src/router.js"; console.log(formatMessages(JSON.parse(require("fs").readFileSync("test-messages.json"))))'
```

### Test IPC file processing

```bash
# Create test task file
mkdir -p data/ipc/main/tasks
cat > data/ipc/main/tasks/test-task.json << 'EOF'
{
  "type": "schedule_task",
  "prompt": "Say hello",
  "targetJid": "tg:123456789",
  "schedule_type": "once",
  "schedule_value": "2024-12-31T23:59:59Z"
}
EOF

# Service will process it in next IPC poll cycle
# Watch logs
sudo journalctl -u agentforge.service -f | grep "task"
```

### Rebuild and test

```bash
# Clean build
rm -rf dist
npm run build

# Check for TypeScript errors
npm run typecheck

# Run tests
npm test

# Start in debug mode
LOG_LEVEL=debug npm start
```

---

## Getting Help

If you're stuck:

1. **Check these docs:**
   - [INSTALLATION.md](INSTALLATION.md) - Setup and configuration
   - [ARCHITECTURE.md](ARCHITECTURE.md) - System design
   - [API.md](API.md) - Code reference

2. **Collect debug information:**
   ```bash
   # Gather system info
   systemctl status agentforge.service > debug.txt
   sudo journalctl -u agentforge.service -n 100 >> debug.txt
   npm list >> debug.txt
   node --version >> debug.txt

   # Share debug.txt when asking for help
   ```

3. **Check agent logs:**
   ```bash
   # Provide the most recent agent log
   ls -t groups/main/logs/ | head -1 | xargs -I {} cat groups/main/logs/{}
   ```

4. **Test in isolation:**
   - Try with a simple test message
   - Check if it's a one-group problem or system-wide
   - Verify after any configuration change
