# AgentForge Development Guide

This guide explains how to set up your development environment, build the project, write tests, and contribute code.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Build Process](#build-process)
- [Testing](#testing)
- [Code Style](#code-style)
- [Common Development Tasks](#common-development-tasks)
- [Debugging](#debugging)
- [Contributing](#contributing)

---

## Development Setup

### Prerequisites

- **Node.js 20+**

  ```bash
  node --version  # Should be v20 or higher
  ```

- **npm 10+**

  ```bash
  npm --version
  ```

- **Git**
  ```bash
  git --version
  ```

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/agentforge.git
cd agentforge

# Install dependencies
npm install

# Verify setup
npm run typecheck
npm test
```

### Environment Setup

Create a `.env` file for local development (see [INSTALLATION.md](INSTALLATION.md) for details):

```bash
# Required: Telegram bot token
TELEGRAM_BOT_TOKEN=<your_test_bot_token>

# Development settings
LOG_LEVEL=debug
NODE_ENV=development

# Optional: customize paths
STORE_DIR=./store
GROUPS_DIR=./groups
DATA_DIR=./data
```

---

## Project Structure

```
agentforge/
├── src/
│   ├── index.ts              # Main orchestrator
│   ├── types.ts              # Type definitions
│   ├── config.ts             # Configuration
│   ├── db.ts                 # Database operations
│   ├── router.ts             # Message routing & formatting
│   ├── logger.ts             # Logging setup
│   ├── ipc.ts                # Agent IPC communication
│   ├── bare-metal-runner.ts  # Agent process execution
│   ├── task-scheduler.ts     # Scheduled task runner
│   ├── group-queue.ts        # Per-group message queue
│   ├── channels/
│   │   └── telegram.ts       # Telegram channel implementation
│   ├── *.test.ts             # Test files
│   └── env.ts                # Env file reader
├── agent-runner-src/
│   ├── src/
│   │   └── index.ts          # Agent entry point
│   ├── package.json
│   └── tsconfig.json
├── groups/
│   ├── main/                 # Main group workspace
│   │   ├── AGENTS.md         # Group-specific agent instructions
│   │   ├── SOUL.md           # Identity and behavioral boundaries (synced)
│   │   ├── TOOLS.md          # Tool reference (synced)
│   │   ├── USER.md           # User preferences
│   │   └── memory.md         # Long-term memory
│   └── global/
│       ├── AGENTS.md         # Global agent instructions template
│       ├── SOUL.md           # Shared identity template
│       └── TOOLS.md          # Shared tool reference template
├── dist/                     # Compiled JavaScript (generated)
├── store/                    # SQLite database (generated)
├── data/                     # IPC and runtime data (generated)
├── package.json
├── tsconfig.json
└── docs/
    ├── API.md                # API reference
    ├── ARCHITECTURE.md       # System architecture
    ├── DEVELOPMENT.md        # This file
    ├── INSTALLATION.md       # Setup instructions
    ├── TROUBLESHOOTING.md    # Common issues
    ├── VERSIONING.md         # Version scheme
    └── RELEASE_PROCESS.md    # Release procedures
```

### Key Files

| File                       | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `src/index.ts`             | Main loop, state management, group processing     |
| `src/router.ts`            | Message formatting, XML escaping, channel routing |
| `src/types.ts`             | TypeScript interfaces for all major types         |
| `src/config.ts`            | Environment configuration (read-only)             |
| `src/db.ts`                | SQLite operations, schema, migrations             |
| `src/bare-metal-runner.ts` | Spawning agent processes, I/O handling            |
| `src/ipc.ts`               | Processing agent IPC requests (messages, tasks)   |
| `src/task-scheduler.ts`    | Cron/interval task execution                      |
| `src/channels/telegram.ts` | Telegram bot implementation                       |

---

## Build Process

### Development Build

Build TypeScript to JavaScript:

```bash
npm run build
```

Output goes to `dist/` directory.

### Watch Mode (For development)

```bash
# Uses tsx for fast TypeScript execution (no build step)
npm run dev
```

This runs `src/index.ts` directly without compiling. Useful for rapid iteration.

### Type Checking

```bash
# Check for TypeScript errors without building
npm run typecheck
```

Should be part of your pre-commit checks.

### Code Formatting

```bash
# Format all TypeScript files
npm run format

# Check formatting (without modifying)
npm run format:check
```

AgentForge uses **Prettier** with default settings. Run `format` before committing.

### Full Release Checklist

```bash
# Run this before pushing to main
npm run release:check
```

This runs:

- Type checking
- Formatting check
- Full test suite

---

## Testing

AgentForge uses **Vitest** for testing. Tests are colocated with source files (`*.test.ts`).

### Running Tests

```bash
# Run all tests once
npm test

# Watch mode (re-run on changes)
npm run test:watch

# Run specific test file
npm test src/routing.test.ts

# Run with coverage
npm test -- --coverage
```

### Writing Tests

Tests use Vitest and follow AAA (Arrange-Act-Assert) pattern:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('formatMessages', () => {
  it('converts messages to XML format', () => {
    // Arrange
    const messages = [
      {
        id: '1',
        chat_jid: 'tg:123',
        sender: 'user1',
        sender_name: 'Alice',
        content: 'Hello',
        timestamp: '2024-01-01T12:00:00Z',
      },
    ];

    // Act
    const result = formatMessages(messages);

    // Assert
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('Hello</message>');
  });
});
```

### Test Database

For tests that need a database, use the test database helper:

```typescript
import { _initTestDatabase } from './db.js';

beforeEach(() => {
  _initTestDatabase(); // Creates fresh in-memory SQLite DB
});
```

### Mocking

For unit tests that need to mock dependencies:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('runAgent', () => {
  it('calls onOutput callback', async () => {
    const onOutput = vi.fn();

    // Your test code that calls runAgent with onOutput

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });
});
```

### Integration Tests

For end-to-end testing:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Full message flow', () => {
  beforeEach(async () => {
    // Setup: initialize database, register groups, start processes
  });

  afterEach(async () => {
    // Cleanup: stop processes, clear state
  });

  it('processes message from input to output', async () => {
    // Simulate full flow: store message -> process -> verify output
  });
});
```

### Test Coverage

```bash
# Generate coverage report
npm test -- --coverage

# Coverage is written to coverage/
# Open coverage/index.html in browser
```

Current coverage goals:

- Core routing/message handling: 90%+
- IPC authorization: 95%+
- Edge cases: 80%+
- Integration: Best effort

---

## Code Style

### TypeScript

- **Target:** ES2020 (Node 20 compatible)
- **Module:** ESM (import/export)
- **Strict mode:** Yes (all strictness flags enabled)

Configuration in `tsconfig.json`.

### Naming Conventions

- **Classes:** PascalCase (`TelegramChannel`)
- **Functions:** camelCase (`formatMessages`)
- **Constants:** UPPER_CASE (`AGENT_TIMEOUT`)
- **Types/Interfaces:** PascalCase (`RegisteredGroup`)
- **Private functions:** Prefix with `_` (`_initTestDatabase`)

### Imports

Use named imports, keep imports organized:

```typescript
// Standard library
import fs from 'fs';
import path from 'path';

// Dependencies
import { Bot } from 'grammy';

// Local imports (relative)
import { config } from './config.js';
import { Channel } from './types.js';
```

### Error Handling

Use descriptive error messages with context:

```typescript
// Good
logger.error({ chatJid, group: group.name, err }, 'Failed to process message');

// Avoid
console.error('Error');
```

### Logging

Use the centralized logger with structured data:

```typescript
import { logger } from './logger.js';

// Info: important state changes
logger.info({ groupCount: 5 }, 'Groups loaded');

// Warn: suspicious but not breaking
logger.warn({ jid: 'unknown' }, 'No channel for JID');

// Error: failures that should be fixed
logger.error({ err: e }, 'Database error');

// Debug: detailed diagnostic info
logger.debug({ messages: 10 }, 'Processing batch');
```

Pino logging format (structured JSON):

```json
{
  "level": 30,
  "time": "2024-01-15T12:34:56.789Z",
  "groupCount": 5,
  "msg": "Groups loaded"
}
```

### Comments

Use comments for "why", not "what":

```typescript
// Good: explains the decision
// Reset cursor on streaming output so we don't re-process these messages
// if the orchestrator crashes between advancing lastTimestamp and sending.
lastAgentTimestamp[chatJid] =
  messedMessages[missedMessages.length - 1].timestamp;

// Avoid: just repeats code
// Set the timestamp
lastTimestamp = newMessage.timestamp;
```

### File Organization

Keep files focused on one responsibility:

- `index.ts` - Orchestrator loop and state
- `router.ts` - Message formatting and routing
- `bare-metal-runner.ts` - Process execution only
- `ipc.ts` - IPC file processing only
- `db.ts` - Database operations only

Cross-file functions should be documented at the top of the file.

---

## Common Development Tasks

### Adding a New Environment Variable

1. Define in `src/config.ts`:

   ```typescript
   export const MY_SETTING = parseInt(process.env.MY_SETTING || '5000', 10);
   ```

2. Document in `docs/API.md` under Configuration

3. Use via import:
   ```typescript
   import { MY_SETTING } from './config.js';
   ```

### Adding a New Channel

1. Create `src/channels/mychannel.ts` implementing `Channel` interface:

   ```typescript
   export class MyChannel implements Channel {
     name = 'mychannel';
     // ... implement required methods
   }
   ```

2. Instantiate in `src/index.ts`:

   ```typescript
   const mychannel = new MyChannel(config);
   channels.push(mychannel);
   await mychannel.connect();
   ```

3. Add tests in `src/channels/mychannel.test.ts`

4. Document in `docs/API.md` under "Extension Points"

### Adding a New IPC Task Type

1. Add case in `src/ipc.ts` `processTaskIpc()`:

   ```typescript
   case 'my_task_type':
     // Validate and process
     break;
   ```

2. Add authorization check if needed

3. Add tests in `src/ipc-auth.test.ts`

4. Document in `docs/API.md` under "IPC Task API"

### Modifying Database Schema

1. Add migration in `src/db.ts` `createSchema()`:

   ```typescript
   try {
     database.exec(`ALTER TABLE messages ADD COLUMN new_col TEXT DEFAULT ''`);
   } catch {
     /* column already exists */
   }
   ```

2. Add to test database creation

3. Handle backfill if needed

### Making a Breaking Change

1. Bump version in `package.json` (major version)

2. Update migration code in `src/db.ts`

3. Document in `CHANGELOG.md`

4. Create a release PR with justification

---

## Debugging

### VS Code Debugging

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "AgentForge",
      "program": "${workspaceFolder}/dist/index.js",
      "preLaunchTask": "npm: build",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "env": {
        "LOG_LEVEL": "debug",
        "TELEGRAM_BOT_TOKEN": "${env:TELEGRAM_BOT_TOKEN}"
      }
    }
  ]
}
```

Then press F5 to start debugging.

### Node Inspector

```bash
# Start with inspector
node --inspect dist/index.js

# Open chrome://inspect in Chrome
# Connect to the running process
```

### Debug Print Statements

```typescript
// Structured debug output
logger.debug({ data: myVar, type: typeof myVar }, 'Checkpoint A');

// Won't show unless LOG_LEVEL=debug
```

### Database Inspection During Tests

```typescript
it('stores message correctly', async () => {
  storeMessage(msg);

  // Inspect database
  const stored = db.prepare('SELECT * FROM messages').all();
  console.log(stored); // Won't print unless test fails
  expect(stored).toHaveLength(1);
});
```

---

## Contributing

### Before You Start

1. Check [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines
2. Fork the repository
3. Create a feature branch: `git checkout -b feature/my-feature`
4. Set up development environment (see above)

### Making Changes

1. **Make one logical change per commit**

   ```bash
   git add src/my-file.ts
   git commit -m "feat: add new feature"
   ```

2. **Keep commits focused and descriptive**
   - Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
   - Reference issues: "Fixes #123"
   - Examples:
     - `feat: add support for scheduled tasks`
     - `fix: prevent message duplication on crash`
     - `docs: clarify authorization in IPC`
     - `test: add test for formatMessages XML escaping`
     - `refactor: extract message validation to separate function`

3. **Ensure tests pass**

   ```bash
   npm test
   npm run typecheck
   npm run format:check
   ```

4. **Test manually if it affects runtime behavior**
   ```bash
   npm run build
   npm start
   # Send test messages to bot
   ```

### Submitting a Pull Request

1. **Push your branch**

   ```bash
   git push origin feature/my-feature
   ```

2. **Create a PR on GitHub**
   - Title: Brief description (will be in changelog)
   - Description: What changed and why
   - Reference issues: "Fixes #123"

3. **Address review feedback**

   ```bash
   # Make changes
   git add .
   git commit -m "Address review feedback"
   git push
   ```

4. **Merge once approved**
   - Use "Squash and merge" for single commits
   - Use "Create a merge commit" for feature branches

### Release Process

Only maintainers can release. See [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

### What Gets Reviewed

Code reviews check:

- **Correctness:** Does it work as intended?
- **Testing:** Are tests present and comprehensive?
- **Performance:** Will it slow down the system?
- **Security:** Are there authorization/injection risks?
- **Clarity:** Is the code understandable?
- **Style:** Does it follow project conventions?

### Common Review Feedback

**"Add tests"**

- Write unit tests for new functions
- Write integration tests for multi-component changes

**"Add logging"**

- Include `logger.debug()` for diagnostic info
- Use `logger.warn()` for suspicious conditions
- Use `logger.error()` for failures

**"Document this"**

- Add JSDoc comments for exported functions
- Update API docs if public API changes
- Add examples in docstrings

**"Extract to separate function"**

- If a function is getting long (>50 lines)
- If logic is repeated in multiple places
- If the function does multiple things

---

## Development Workflow Example

```bash
# 1. Create feature branch
git checkout -b fix/agent-timeout

# 2. Make changes
vim src/bare-metal-runner.ts

# 3. Write tests
vim src/bare-metal-runner.test.ts

# 4. Run tests
npm test

# 5. Format code
npm run format

# 6. Check everything
npm run release:check

# 7. Commit
git add src/
git commit -m "fix: increase agent timeout grace period for slow tasks"

# 8. Push
git push origin fix/agent-timeout

# 9. Create PR on GitHub
# - Fill in PR template
# - Wait for reviews
# - Address feedback
# - Merge

# 10. Delete branch
git branch -d fix/agent-timeout
```

---

## Performance Optimization Tips

### Profiling

```bash
# Start with profiler
node --prof dist/index.js

# Analyze results
node --prof-process isolate-*.log > profile.txt
less profile.txt
```

### Database Performance

- Add indexes for frequently queried columns:

  ```typescript
  database
    .prepare(`CREATE INDEX IF NOT EXISTS idx_chat_jid ON messages(chat_jid)`)
    .run();
  ```

- Use prepared statements (better-sqlite3 does this automatically)

- Batch operations when possible

### Memory Usage

- Monitor with `top` or `ps`
- Message history can grow large—implement cleanup
- Agent processes exit after IDLE_TIMEOUT (good for memory)

### CPU Usage

- Increase POLL_INTERVAL if CPU is high (trades latency for CPU)
- Use debug logging only when needed (verbose output is slow)
- Profile hot paths with `--prof`

---

## Troubleshooting Development Issues

### Build fails with TypeScript errors

```bash
npm run typecheck  # See detailed errors
npm run format     # Some errors are formatting
```

### Tests fail

```bash
# Run specific test with more output
npm test -- src/my.test.ts --reporter=verbose

# Check test database is initialized
grep "_initTestDatabase" src/my.test.ts
```

### Can't connect to Telegram

```bash
# Verify token is correct
echo $TELEGRAM_BOT_TOKEN

# Check rate limiting (Telegram limits API calls)
# Wait a few seconds and try again
```

### Port in use

```bash
# Kill previous process
pkill -f "node dist/index.js"

# Then start again
npm start
```

---

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Vitest Documentation](https://vitest.dev/)
- [Pino Logger](https://getpino.io/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Node.js Best Practices](https://nodejs.org/en/docs/guides/)
