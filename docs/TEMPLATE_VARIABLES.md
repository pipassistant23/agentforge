# Template Variable Substitution

## Overview

AgentForge supports template variable substitution in `.md` files, making it easy to rebrand the application or customize agent behavior without editing multiple files.

## Syntax

Use double curly braces with no spaces:

```markdown
# {{ASSISTANT_NAME}}

You are {{ASSISTANT_NAME}}, a personal assistant.
```

**Strict matching rules:**
- `{{VARIABLE_NAME}}` ✅ Works
- `{{ VARIABLE_NAME }}` ❌ Spaces not supported
- `{{UNKNOWN_VAR}}` → Left as-is (not replaced)

## Supported Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `{{ASSISTANT_NAME}}` | Bot/assistant name | `Andy` | `AgentForge`, `Pip`, `Assistant` |

## Where It Works

Template substitution is applied to:

1. **Global CLAUDE.md** (`groups/global/CLAUDE.md`)
   - Loaded for all non-main groups
   - Processed before being passed to the agent

2. **Group CLAUDE.md** (`groups/{group}/CLAUDE.md`)
   - Loaded for each specific group
   - Processed before being passed to the agent

3. **Conversation Transcripts** (archived conversations)
   - `ASSISTANT_NAME` used in speaker labels
   - E.g., "User: Hello" → "AgentForge: Hi there!"

## How It Works

### Loading Process

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Agent runner starts                                       │
├─────────────────────────────────────────────────────────────┤
│ 2. Read global/CLAUDE.md from disk                          │
│    "You are {{ASSISTANT_NAME}}, a personal assistant..."    │
├─────────────────────────────────────────────────────────────┤
│ 3. Read group/CLAUDE.md from disk                           │
│    "You are {{ASSISTANT_NAME}}, a personal assistant..."    │
├─────────────────────────────────────────────────────────────┤
│ 4. Apply substituteVariables() to both                      │
│    {{ASSISTANT_NAME}} → process.env.ASSISTANT_NAME || 'Andy'│
├─────────────────────────────────────────────────────────────┤
│ 5. Combine and pass to Claude SDK                           │
│    "You are AgentForge, a personal assistant..."            │
└─────────────────────────────────────────────────────────────┘
```

### Code Flow

**Template Utility** (`agent-runner-src/src/template.ts`):
```typescript
export function substituteVariables(content: string): string {
  const vars = {
    ASSISTANT_NAME: process.env.ASSISTANT_NAME || 'Andy',
  };

  return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    return vars[varName as keyof typeof vars] ?? match;
  });
}
```

**Agent Runner** (`agent-runner-src/src/index.ts`):
```typescript
import { substituteVariables } from './template.js';

// Load global CLAUDE.md
if (fs.existsSync(globalClaudeMdPath)) {
  const rawContent = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  globalClaudeMd = substituteVariables(rawContent);
}

// Load group CLAUDE.md
if (fs.existsSync(groupClaudeMdPath)) {
  const rawContent = fs.readFileSync(groupClaudeMdPath, 'utf-8');
  groupClaudeMd = substituteVariables(rawContent);
}
```

## Rebranding Guide

### Quick Rebrand

Change one environment variable to rebrand the entire application:

**1. Edit `.env`:**
```bash
ASSISTANT_NAME=AgentForge
```

**2. Rebuild and restart:**
```bash
npm run build
cd agent-runner-src && npm run build
cd ..
sudo systemctl restart agentforge.service
```

**3. Verify:**
```bash
sudo journalctl -u agentforge.service -f
# Look for: "AgentForge running (trigger: @AgentForge)"
```

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| **Agent identity** | "You are Andy..." | "You are AgentForge..." |
| **Trigger pattern** | `@YourBot` | `@AgentForge` |
| **Transcripts** | "Andy: Hello" | "AgentForge: Hello" |
| **Code references** | Uses `ASSISTANT_NAME` | Uses `ASSISTANT_NAME` |

### What Doesn't Change

- Code files (`.ts`, `.js`) - Already use `ASSISTANT_NAME` variable
- Database structure
- File paths
- API keys or secrets
- Service configuration

## Examples

### Example 1: Corporate Rebrand

```bash
# .env
ASSISTANT_NAME=CompanyBot
```

Result: All groups see "You are CompanyBot, a personal assistant..."

### Example 2: Personal Customization

```bash
# .env
ASSISTANT_NAME=Jarvis
```

Result: Trigger becomes `@Jarvis`, identity becomes "Jarvis"

### Example 3: Multiple Instances

Deploy multiple bots with different names:

**Instance 1:**
```bash
ASSISTANT_NAME=DevBot
TELEGRAM_BOT_TOKEN=token1
```

**Instance 2:**
```bash
ASSISTANT_NAME=ProdBot
TELEGRAM_BOT_TOKEN=token2
```

## Edge Cases

### Unknown Variables

```markdown
{{UNKNOWN_VAR}} will remain unchanged
```

**Result:** `{{UNKNOWN_VAR}} will remain unchanged`

### Malformed Syntax

```markdown
{{ ASSISTANT_NAME }}  ← Spaces not matched
{{ASSISTANT_NAME      ← Missing closing brace
ASSISTANT_NAME}}      ← Missing opening braces
```

**Result:** All left as-is (not replaced)

### Escaped Braces

Not currently supported. To include literal `{{` in content:

**Workaround:** Use a different delimiter or unicode characters

### Case Sensitivity

Variable names are case-sensitive:

- `{{ASSISTANT_NAME}}` ✅ Works
- `{{assistant_name}}` ❌ Not replaced
- `{{AssistantName}}` ❌ Not replaced

## Testing

### Verify Template Processing

```bash
./scripts/verify-rebranding.sh
```

### Manual Test

```typescript
import { substituteVariables } from './agent-runner-src/dist/template.js';

process.env.ASSISTANT_NAME = 'TestBot';
const result = substituteVariables('Hello, I am {{ASSISTANT_NAME}}');
console.log(result); // "Hello, I am TestBot"
```

### Check Agent Identity

1. Set `ASSISTANT_NAME=TestBot` in `.env`
2. Restart service
3. Check logs: `sudo journalctl -u agentforge.service -f`
4. Look for: "AgentForge running (trigger: @TestBot)"

## Future Enhancements

Potential additions for future versions:

1. **More Variables:**
   ```markdown
   {{GROUP_NAME}} - Current group name
   {{GROUP_FOLDER}} - Current group folder
   {{IS_MAIN}} - Boolean for main group
   ```

2. **Conditional Templates:**
   ```markdown
   {{#if IS_MAIN}}
   You have admin privileges.
   {{/if}}
   ```

3. **Default Values:**
   ```markdown
   {{ASSISTANT_NAME:DefaultBot}}
   ```

4. **Escape Sequences:**
   ```markdown
   \{{LITERAL_BRACES}}
   ```

5. **Validation:**
   - Warn about undefined variables on startup
   - Suggest typo corrections

## Technical Details

### Performance

- **Processing:** Simple regex replacement, ~1ms per file
- **Caching:** No caching - files processed on each agent start
- **Memory:** Minimal overhead (adds ~100 bytes per variable)

### Security

- **No code injection:** Only predefined variables allowed
- **No file access:** Variables come from environment only
- **No user input:** Values set in `.env`, not from messages

### Backwards Compatibility

- **Default behavior:** Falls back to "Andy" if variable not set
- **Existing files:** Work as-is (no changes needed)
- **Gradual migration:** Can mix template and hardcoded values

## Troubleshooting

### Variables Not Substituting

**Symptom:** Agent still says "You are Andy" after changing `.env`

**Solution:**
1. Verify `.env` has `ASSISTANT_NAME=NewName` (no quotes)
2. Rebuild: `npm run build && cd agent-runner-src && npm run build`
3. Restart: `sudo systemctl restart agentforge.service`
4. Check build time: `ls -l agent-runner-src/dist/template.js`

### Syntax Not Working

**Symptom:** `{{ASSISTANT_NAME}}` appears literally in agent output

**Solution:**
1. Check for spaces: Use `{{VAR}}` not `{{ VAR }}`
2. Verify spelling: Must be exactly `ASSISTANT_NAME`
3. Check file: `grep '{{ASSISTANT_NAME}}' groups/global/CLAUDE.md`

### Wrong Name Appearing

**Symptom:** Agent uses old name after restart

**Solution:**
1. Check which `.env` is loaded: `systemctl cat agentforge.service | grep EnvironmentFile`
2. Verify file: `grep ASSISTANT_NAME /home/dustin/agentforge/.env`
3. Check process env: `sudo journalctl -u agentforge.service | grep "trigger:"`

## Best Practices

1. **Use templates for identity:**
   - ✅ `You are {{ASSISTANT_NAME}}`
   - ❌ `You are Andy` (hardcoded)

2. **Consistent naming:**
   - Use `{{ASSISTANT_NAME}}` everywhere the bot refers to itself
   - Don't mix template and hardcoded names

3. **Document custom variables:**
   - If adding new variables, update this file
   - Add them to `.env.example`

4. **Test after changes:**
   - Run `./scripts/verify-rebranding.sh`
   - Check logs after restart

5. **Keep it simple:**
   - Only add variables when needed
   - Avoid complex conditional logic
   - Prefer environment config over templates

## Related Files

- `agent-runner-src/src/template.ts` - Template substitution logic
- `agent-runner-src/src/index.ts` - CLAUDE.md loading
- `groups/global/CLAUDE.md` - Global agent instructions
- `groups/main/CLAUDE.md` - Main group instructions
- `.env.example` - Configuration template
- `src/config.ts` - Environment variable loading
- `scripts/verify-rebranding.sh` - Verification script
