---
name: add-voice-transcription
description: Add voice message transcription to AgentForge using OpenAI's Whisper API. Automatically transcribes Telegram voice notes so the agent can read and respond to the content.
---

# Add Voice Message Transcription

This skill adds automatic voice message transcription using OpenAI's Whisper API. When users send voice notes in Telegram, they'll be transcribed before being stored — so the agent sees `[Voice: what they actually said]` instead of just `[Voice message]`.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool.

## Prerequisites

**Use AskUserQuestion** to present this:

> You'll need an OpenAI API key for Whisper transcription.
>
> Get one at: https://platform.openai.com/api-keys
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)
>
> Once you have your API key, we'll add it to your `.env` file.

Wait for user to confirm they have an API key before continuing.

---

## How It Works

Voice messages flow through the Telegram channel (`src/channels/telegram.ts`), which currently stores them as `[Voice message]` placeholders. This skill modifies that handler to:

1. Download the OGG audio file from Telegram's servers using the Bot API
2. Send it to OpenAI's Whisper API for transcription
3. Store the result as `[Voice: <transcript>]` so the agent can read and respond to it

All transcription happens in the orchestrator process — the agent runner receives plain text.

---

## Implementation

### Step 1: Add OpenAI API Key

Read `.env` and add the key (or confirm it's already there under `OPENAI_API_KEY`):

```bash
# In .env
OPENAI_API_KEY=sk-proj-...
```

If using a custom provider (ANTHROPIC_AUTH_TOKEN style setup), add it separately — Whisper must use OpenAI's API directly.

### Step 2: Add OpenAI Dependency

Read `package.json` (root, not agent-runner-src) and add to dependencies:

```json
"openai": "^4.77.0"
```

Then install. The OpenAI SDK requires Zod v3 as a peer dep — always use `--legacy-peer-deps` to avoid conflicts:

```bash
npm install --legacy-peer-deps
```

### Step 3: Add Transcription Config to `src/config.ts`

Read `src/config.ts` and add:

```typescript
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const VOICE_TRANSCRIPTION_ENABLED = OPENAI_API_KEY !== '';
```

### Step 4: Update `src/channels/telegram.ts`

Read the full file first. Then make these changes:

**Add import at the top:**

```typescript
import { OPENAI_API_KEY, VOICE_TRANSCRIPTION_ENABLED } from '../config.js';
```

**Add a private `transcribeVoice` method to the `TelegramChannel` class:**

```typescript
private async transcribeVoice(fileId: string): Promise<string | null> {
  try {
    // Get the file path from Telegram
    const file = await this.bot!.api.getFile(fileId);
    if (!file.file_path) return null;

    // Download the audio from Telegram CDN
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download voice file: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Transcribe with Whisper
    const { default: OpenAI, toFile } = await import('openai');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const audioFile = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'text',
    });

    // SDK types response_format='text' as Transcription object but returns a plain string
    return (transcription as unknown as string).trim() || null;
  } catch (err) {
    logger.error({ err }, 'Voice transcription failed');
    return null;
  }
}
```

**Replace the existing `message:voice` handler:**

Find this line:
```typescript
this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
```

Replace with:
```typescript
this.bot.on('message:voice', async (ctx) => {
  if (!VOICE_TRANSCRIPTION_ENABLED) {
    storeNonText(ctx, '[Voice message]');
    return;
  }
  const transcript = await this.transcribeVoice(ctx.message.voice.file_id);
  storeNonText(ctx, transcript ? `[Voice: ${transcript}]` : '[Voice message]');
});
```

### Step 5: Build and Restart

```bash
npm run build
sudo systemctl restart agentforge.service
```

Verify:

```bash
sudo systemctl status agentforge.service
```

### Step 6: Test

Tell the user:

> Voice transcription is ready! Send a voice note to your registered Telegram chat.
>
> In the agent's context, voice messages will appear as:
> `[Voice: what you actually said]`
>
> The agent can now read and respond to voice messages just like text.

Watch the logs for transcription activity:

```bash
sudo journalctl -u agentforge.service -f | grep -i voice
```

---

## Configuration

### Disable Without Removing Code

Remove `OPENAI_API_KEY` from `.env` (or set it empty). `VOICE_TRANSCRIPTION_ENABLED` will be false and voice messages fall back to `[Voice message]` placeholders.

### Switch Providers (Future)

The architecture supports swapping Whisper out. Groq offers a free tier with Whisper-compatible API (`https://api.groq.com/openai/v1`) and is significantly faster:

1. Add `GROQ_API_KEY` to `.env`
2. Update `transcribeVoice()` to use `baseURL: 'https://api.groq.com/openai/v1'` and `model: 'whisper-large-v3-turbo'`

---

## Troubleshooting

### Voice messages not transcribed (show as `[Voice message]`)

Check `OPENAI_API_KEY` is set:

```bash
grep OPENAI_API_KEY .env
```

Check logs for transcription errors:

```bash
sudo journalctl -u agentforge.service --no-pager | grep -i "voice\|transcri" | tail -20
```

### "Invalid API key" or "Insufficient quota"

- Verify the key is valid at https://platform.openai.com/api-keys
- Check usage/billing at https://platform.openai.com/usage

### ES Module / import() errors

The `await import('openai')` dynamic import is used intentionally to avoid loading the SDK on startup when transcription is disabled. If you see module resolution errors, ensure `openai` is installed in the root `package.json` (not `agent-runner-src/package.json`).

### Zod peer dependency conflict

Always use `--legacy-peer-deps` when installing:

```bash
npm install --legacy-peer-deps
```

---

## Cost Management

- ~$0.006/minute, billed by the second
- Typical 30-second voice note: ~$0.003
- Monitor at: https://platform.openai.com/usage
- Set spending limits in your OpenAI account settings

---

## Removing Voice Transcription

1. Revert `src/channels/telegram.ts`:
   - Remove the `transcribeVoice` method
   - Restore: `this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));`
   - Remove the config import if no longer needed

2. Remove from `src/config.ts`:
   - Delete `OPENAI_API_KEY` and `VOICE_TRANSCRIPTION_ENABLED` exports

3. Uninstall:
   ```bash
   npm uninstall openai
   ```

4. Remove `OPENAI_API_KEY` from `.env`

5. Rebuild:
   ```bash
   npm run build
   sudo systemctl restart agentforge.service
   ```
