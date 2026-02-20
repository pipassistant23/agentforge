# Channel Integration Review
**Reviewer:** Avery Johnson, Channel Integration Lead
**Date:** 2026-02-19
**Files Reviewed:**
- `src/channels/telegram.ts`
- `src/channels/email.ts`
- `src/types.ts` (Channel interface)
- `src/router.ts` (formatOutbound, findChannel)
- `src/index.ts` (channel orchestration, setTyping call sites)
- `src/config.ts` (Telegram/email config)

---

## Executive Summary

The channel layer is functional and covers the primary use cases — Telegram message handling, bot pool routing for Agent Swarms, and Gmail polling via IMAP. The grammy library choice is sound, the Channel interface is clean, and the bot pool's stable sender-to-bot assignment is a clever approach for giving Agent Swarm members persistent identities. However, several issues range from correctness bugs to reliability gaps that will cause real problems under load or in edge cases.

The most pressing concerns are: the Telegram message splitter that cuts mid-word (corrupting multi-part responses), a typing indicator lifecycle that leaves the UI in a stuck "typing..." state on error paths through index.ts, the email channel's custom MIME parser which is brittle against real-world email formatting, and the `senderBotMap` being purely in-memory so bot assignments reset silently on every process restart.

Seven issues are rated HIGH or above. Immediate action on the message-splitting and typing-indicator bugs would improve the user-facing experience with no architectural risk.

---

## Strengths

**Clean Channel interface abstraction.** The `Channel` interface in `src/types.ts` is minimal and well-designed. Making `setTyping` optional and using `prefixAssistantName` to handle the formatting difference between Telegram bots (which have their own display name) and email (which needs a prefix) are good decisions that keep channel-specific logic out of the orchestrator.

**grammy is the right library.** grammy is the maintained, TypeScript-first successor to telegraf. Using `Api` instances for pool bots (send-only, no polling overhead) rather than full `Bot` instances is correct and efficient. The module-level pool (`poolApis`, `senderBotMap`) keeps pool state outside the class where it belongs since bots outlive individual group sessions.

**Stable sender-to-bot assignment in the pool.** The round-robin with a `senderBotMap` keyed on `${groupFolder}:${sender}` gives each Agent Swarm member a consistent bot identity across messages in a session. This is the right model — Telegram users would see confusing name changes if bots were assigned dynamically per-message.

**Defensive error handling in bot.catch.** The global grammy error handler at `this.bot.catch(...)` prevents uncaught exceptions from crashing the process for transient Telegram API errors.

**Non-text message awareness.** Storing non-text messages as typed placeholders (`[Photo]`, `[Voice message]`, `[Document: filename]`, etc.) means the agent has awareness that media was sent rather than seeing a gap in the conversation. Including captions when present is a thoughtful detail.

**Email channel's non-blocking startup.** Running the first IMAP poll in the background via `.catch()` instead of awaiting it is a correct choice — IMAP latency should not block the startup sequence and prevent the message loop from starting.

**Subject-based fallback for email trigger.** Supporting both label-based and subject-prefix-based filtering with a graceful fallback to INBOX is good for users whose Gmail setup doesn't have the label configured yet.

---

## Issues Found

### [HIGH] Message splitting cuts mid-word, producing corrupted multi-part messages

**Location:** `src/channels/telegram.ts` lines 208-214, and `sendPoolMessage` lines 319-325

The current splitter:
```typescript
for (let i = 0; i < text.length; i += MAX_LENGTH) {
  await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
}
```

This slices at exactly 4096 characters regardless of word or sentence boundaries. A word that straddles the boundary is split across two messages: `"...the confi"` / `"guration is..."`. This makes long agent responses (code blocks, structured lists) read as garbled text. The same bug exists identically in `sendPoolMessage`, so both paths need fixing.

The fix is straightforward: scan backwards from the boundary for the last whitespace character and split there. If no whitespace exists within a reasonable window (e.g., the last 200 characters), fall back to the hard cut rather than looping infinitely.

---

### [HIGH] Typing indicator left active on error path in index.ts

**Location:** `src/index.ts` lines 250, 286, 491

`setTyping(jid, true)` is called before agent processing starts. The `Channel` interface accepts a boolean `isTyping` argument, and `TelegramChannel.setTyping` only does anything when `isTyping` is `true`:

```typescript
async setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!this.bot || !isTyping) return;  // does nothing on false
  ...
  await this.bot.api.sendChatAction(numericId, 'typing');
}
```

Telegram's `sendChatAction` with `'typing'` has a 5-second natural expiry, so in the normal fast-path the indicator disappears on its own. However, the interface contract implies that `setTyping(jid, false)` should cancel typing — which today it silently does nothing. There is no way to cancel the indicator early; the implementation just waits for it to time out.

More critically, in `startMessageLoop` at line 491:
```typescript
channel?.setTyping?.(chatJid, true);
```
This is called when messages are piped to an active process, but there is no corresponding `setTyping(false)` after that path completes. The 5-second Telegram timeout saves the UX from being permanently broken, but on long agent runs the typing indicator will have long since timed out and the user sees no visual feedback even though the agent is still running. Meanwhile `processGroupMessages` calls `setTyping(false)` at line 286, which silently no-ops.

The proper fix for Telegram is to call `sendChatAction` on a repeating interval (every 4 seconds) while processing is active, and stop when done. This is the standard approach for long-running responses. The `setTyping(false)` no-op should at minimum be logged at debug level to avoid future confusion.

---

### [HIGH] Bot pool `senderBotMap` is in-memory only — assignments reset on restart

**Location:** `src/channels/telegram.ts` lines 20-22

```typescript
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
```

On every process restart (including routine deploys via `systemctl restart agentforge.service`), all sender-to-bot mappings are lost. Pool bots get reassigned round-robin from index 0. If the pool has, say, three bots named "Researcher", "Writer", "Planner", after a restart a sender previously mapped to bot 0 ("Researcher") will again map to bot 0 — but another sender previously on bot 1 may also end up on bot 0 if the total senders mapped before the restart was less than the pool size. More problematically, `setMyName` is called again on assignment, triggering the 2-second propagation delay for every first message after a restart.

The deeper issue: Telegram's `setMyName` renames the bot globally (not per-chat). If two concurrent groups both trigger bot pool messages simultaneously, they race to rename the same bot. Bot 0 might briefly display the wrong name.

This assignment map should be persisted to SQLite (or at minimum the group-level IPC snapshot) so restarts don't corrupt assignments, and the global rename race needs to be acknowledged.

---

### [MEDIUM] `(ctx.chat as any).title` type assertion should use grammy's type narrowing

**Location:** `src/channels/telegram.ts` lines 46-47 and 78-79

```typescript
const chatName =
  chatType === 'private'
    ? ctx.from?.first_name || 'Private'
    : (ctx.chat as any).title || 'Unknown';
```

The `as any` cast is unnecessary. grammy ships complete TypeScript types for all chat variants. After checking `ctx.chat.type`, TypeScript narrows to the appropriate discriminated union member. The `title` property exists on `'group'`, `'supergroup'`, and `'channel'` types. The correct approach is:

```typescript
const chatName =
  ctx.chat.type === 'private'
    ? ctx.from?.first_name || 'Private'
    : ('title' in ctx.chat ? ctx.chat.title : undefined) || 'Unknown';
```

Or simply register `'channel'` chats as handled types since `supergroup` and `group` both expose `.title` directly after the type guard. The `as any` suppresses TypeScript's protection and could mask future API changes.

---

### [MEDIUM] @mention translation has an offset correctness assumption

**Location:** `src/channels/telegram.ts` lines 87-95

```typescript
const mentionText = content
  .substring(entity.offset, entity.offset + entity.length)
  .toLowerCase();
```

Telegram message entity offsets are defined in **UTF-16 code units**, not bytes and not JavaScript's native string character positions. For messages that contain emoji or other characters outside the BMP (Basic Multilingual Plane) before the @mention, `entity.offset` in UTF-16 units will not equal the JavaScript string character index. `String.prototype.substring` operates on UTF-16 code units in JavaScript, so for most practical cases (ASCII text before the mention) this works correctly. However, a message like `"🎉 hey @botname check this out"` will misalign — the emoji is 2 UTF-16 code units, and the substring extraction will be off by one character. The mention won't be recognized, and the bot won't respond to a valid @mention.

The safe approach is to convert the content to an array of UTF-16 code units, slice by offset/length, then reconstruct — or normalize the content to ensure offsets align before matching.

---

### [MEDIUM] Email channel uses a custom MIME parser that will fail on common real-world emails

**Location:** `src/channels/email.ts` lines 300-373 (`extractPlainText`)

The `extractPlainText` function is a hand-rolled line-by-line MIME parser. It handles single-part and simple multipart emails, but will fail or return empty strings in these common cases:

1. **Folded headers** — RFC 2822 allows headers to span multiple lines by starting continuation lines with whitespace. The boundary detection only checks the first line containing `boundary=`, so a folded `Content-Type:` header across two lines will not be detected.

2. **Nested multipart** — `multipart/mixed` containing `multipart/alternative` (standard for rich HTML emails with plain-text fallback) will not find the inner `text/plain` part because the parser only handles one level of boundary nesting.

3. **Base64 or QP encoded bodies** — Many email clients encode `text/plain` parts as `Content-Transfer-Encoding: base64` or `quoted-printable`. The parser reads raw source bytes, so base64-encoded body text will be delivered to the agent as a wall of base64 characters.

4. **Non-Latin boundaries** — Boundary strings can include characters that the regex `/boundary="?([^";\s]+)"?/i` may partially match incorrectly if there are adjacent parameters.

The agent will receive garbled or empty content for a meaningful percentage of real Gmail messages. The `mailparser` npm package (maintained, widely used) handles all of these correctly and would replace 70 lines of fragile parsing with a few lines of well-tested code.

---

### [MEDIUM] Email channel: `pendingReplies` map grows unbounded

**Location:** `src/channels/email.ts` line 43

```typescript
const pendingReplies = new Map<string, PendingReply>();
```

Every inbound email sets a new entry in `pendingReplies` keyed by `email:{senderAddress}`. There is no eviction — the map grows indefinitely for the lifetime of the process. In a personal assistant context with low email volume this is not an immediate problem, but it leaks memory and prevents garbage collection of `PendingReply` objects. Since the reply context is only the most recent email's headers for a given sender, a simple TTL or a bounded LRU (keep last N senders, or evict entries older than 24h) would address this.

---

### [MEDIUM] `sendMessage` has no retry logic for transient Telegram API errors

**Location:** `src/channels/telegram.ts` lines 217-219

```typescript
} catch (err) {
  logger.error({ jid, err }, 'Failed to send Telegram message');
}
```

The catch block logs and silently discards the error. Telegram's API returns `429 Too Many Requests` with a `retry_after` field for rate-limit errors. It also returns transient 5xx errors. These are retryable by design — Telegram's API documentation explicitly states that clients should respect `retry_after` and retry. Silently dropping the message means the user receives no response, and the orchestrator's cursor has already advanced past the messages that triggered this response, so there is no automatic retry. The response is permanently lost.

At minimum, the error should propagate so the orchestrator can decide whether to retry. Ideally, `sendMessage` should implement one or two retries with exponential backoff for 429 and 5xx, respecting the `retry_after` value from the Telegram error response.

---

### [LOW] `connect()` returns a Promise that only resolves when polling starts — no timeout guard

**Location:** `src/channels/telegram.ts` lines 178-192

```typescript
return new Promise<void>((resolve) => {
  this.bot!.start({
    onStart: (botInfo) => {
      ...
      resolve();
    },
  });
});
```

If the Telegram API is unreachable at startup (network issue, wrong token), `bot.start()` will retry indefinitely via grammy's built-in retry logic. The `connect()` Promise never resolves or rejects. The `main()` function in `index.ts` awaits `telegram.connect()` and will hang indefinitely, never starting the message loop. There is no timeout. The systemd service will appear "running" (process is alive) but is completely non-functional.

A startup timeout (e.g., 30 seconds) with a rejection and appropriate error logging would let the service fail fast and let systemd restart it, rather than hanging silently.

---

### [LOW] `isConnected()` checks `this.bot !== null` but not actual polling state

**Location:** `src/channels/telegram.ts` lines 222-224

```typescript
isConnected(): boolean {
  return this.bot !== null;
}
```

`this.bot` is set to `new Bot(token)` before `bot.start()` is called. So `isConnected()` returns `true` from the moment the constructor is invoked, even before the first `getUpdates` poll succeeds and before `onStart` fires. This is a minor API contract violation — "connected" should mean the channel is receiving updates. grammy exposes `bot.isRunning()` which reflects actual polling state and would be the correct check.

---

### [LOW] `getAvailableGroups()` in index.ts still filters for `@g.us` JIDs (WhatsApp artifact)

**Location:** `src/index.ts` lines 155-166

```typescript
.filter(
  (c) =>
    c.jid !== '__group_sync__' &&
    (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')),
)
```

The `@g.us` suffix is a WhatsApp JID format. AgentForge no longer has WhatsApp support (per the README and CLAUDE.md). This filter silently excludes email JIDs (`email:...`) from the available groups list shown to the agent's main group, meaning the agent cannot discover or manage email-registered senders. This is a leftover from the WhatsApp era and should be updated to include all non-internal JID formats.

---

### [LOW] Pool bot rename blocks message delivery for 2 seconds on every new sender

**Location:** `src/channels/telegram.ts` lines 296-302

```typescript
await poolApis[idx].setMyName(sender);
await new Promise((r) => setTimeout(r, NAME_PROPAGATION_DELAY));
```

The first message from any new Agent Swarm member is delayed by `NAME_PROPAGATION_DELAY` (default 2 seconds, configurable). This blocks the entire `sendPoolMessage` call. For a swarm with many agents, the first message from each is serially delayed. The delay is empirical ("wait for Telegram to propagate") but Telegram does not guarantee any specific propagation time — 2 seconds may be too short in some regions and too long in others. This is inherently a best-effort UX hack and should be documented as such. Consider whether the rename can be fire-and-forget with the message sent immediately after (accepting that the first message may arrive under the old bot name), which eliminates the blocking delay entirely.

---

## Recommendations

**1. Fix the message splitter (HIGH).** Replace the hard-slice loop with a word-boundary-aware split. Shared logic should be extracted into a module-level helper used by both `TelegramChannel.sendMessage` and `sendPoolMessage` to avoid the current duplication.

```typescript
function splitAtWordBoundary(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = maxLength;
    const lastSpace = remaining.lastIndexOf(' ', maxLength);
    if (lastSpace > maxLength - 200) splitAt = lastSpace;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
```

**2. Implement repeating typing indicator (HIGH).** Replace the one-shot `sendChatAction` with a repeating interval that fires every 4 seconds while the agent is processing:

```typescript
async setTypingActive(jid: string): Promise<() => void> {
  const numericId = jid.replace(/^tg:/, '');
  const send = () => this.bot?.api.sendChatAction(numericId, 'typing').catch(() => {});
  send();
  const timer = setInterval(send, 4000);
  return () => clearInterval(timer);
}
```

The orchestrator would call the returned cancel function when the agent completes or errors.

**3. Persist `senderBotMap` to SQLite (HIGH).** Add a `bot_pool_assignments` table (columns: `group_folder TEXT`, `sender TEXT`, `pool_index INTEGER`, PRIMARY KEY on `(group_folder, sender)`). Load into `senderBotMap` at `initBotPool` startup and write on every new assignment. This survives service restarts and gives predictable bot identities.

**4. Replace the MIME parser with `mailparser` (MEDIUM).** The `mailparser` package is the de-facto standard for parsing raw email in Node.js. It handles folded headers, nested multipart, all standard transfer encodings, and character sets. The `pollInbox` method already has the raw `msg.source` buffer — passing it to `mailparser`'s `simpleParser` is a near-drop-in replacement that eliminates the fragile custom parser.

**5. Bound or TTL the `pendingReplies` map (MEDIUM).** Add a timestamp to each `PendingReply` and evict entries older than 48 hours in `pollInbox`. Alternatively, limit the map to the last 100 senders.

**6. Add retry with backoff to `sendMessage` (MEDIUM).** Catch Telegram `429` errors specifically, extract `retry_after` from the grammy error (`error.error_code === 429 && error.parameters?.retry_after`), and wait that duration before retrying. Add one retry for 5xx errors with a 1-second delay.

**7. Fix the `@mention` UTF-16 offset handling (MEDIUM).** Replace `content.substring(entity.offset, entity.offset + entity.length)` with a proper UTF-16-aware slice, or use grammy's built-in entity helper (`ctx.entities('mention')`) which handles this correctly.

**8. Fix the `(ctx.chat as any).title` type assertion (MEDIUM).** Use grammy's type narrowing. The `'group'` and `'supergroup'` chat types in grammy's type definitions both expose `.title` directly after the type check on `ctx.chat.type`. Use a `'title' in ctx.chat` guard for the `'channel'` case.

**9. Add a startup timeout to `connect()` (LOW).** Wrap `bot.start()` in a race against a 30-second timeout that rejects with a clear error. This ensures the service fails fast and restarts via systemd instead of hanging indefinitely when the Telegram API is unreachable.

**10. Fix `isConnected()` to use `bot.isRunning()` (LOW).** Replace `this.bot !== null` with `this.bot?.isRunning() ?? false` for an accurate connection state.

**11. Update `getAvailableGroups()` JID filter (LOW).** Remove the `@g.us` whitelist and replace with a blocklist of internal markers (`__group_sync__`, etc.). This ensures email JIDs and any future channel JIDs are visible to the main group agent.

---

## Ideas & Proposals

### [IDEA] Webhook mode for Telegram

Long polling via `bot.start()` works well for single-instance deployments, but webhooks would allow the process to sleep between messages rather than holding a persistent HTTPS connection. grammy supports webhooks with a few lines of configuration. For a systemd service on a machine with a public IP or ngrok tunnel, this would reduce idle network activity and give faster message delivery. The `Channel.connect()` contract already abstracts the connection mechanism — adding a `TELEGRAM_WEBHOOK_URL` env var and conditional `bot.start()` vs. `bot.api.setWebhook()` would be a clean addition.

### [IDEA] Voice message transcription

The `[Voice message]` placeholder is a missed opportunity. Telegram voice messages include a `file_id` that can be downloaded via `getFile` + CDN URL. The audio could then be sent to Whisper (via OpenAI API or a local whisper.cpp instance) for transcription. The transcription would replace the `[Voice message]` placeholder with `[Voice: "what the user said"]`, giving the agent full conversational context. The infrastructure is already in place — `storeNonText` is the right injection point.

### [IDEA] Inline keyboard support for agent-driven interactions

The agent currently communicates entirely via text. Adding a thin IPC message type (e.g., `{ action: 'send_keyboard', chatJid, text, buttons: string[][] }`) would allow the agent to send Telegram inline keyboards. grammy's `InlineKeyboard` builder makes this straightforward on the channel side. This would unlock rich interactions: confirmation prompts, quick-reply options, paginated lists. The `sendMessage` signature would need to be extended to accept optional keyboard markup, or a new `sendWithKeyboard` method added to the Channel interface.

### [IDEA] Message reactions for acknowledgment

Telegram's `setMessageReaction` API (available in grammy via `ctx.react()`) can acknowledge a message receipt with a thumbs-up or custom emoji before the agent finishes processing. This gives users immediate visual feedback that their message was seen, which is especially valuable when agent processing takes 10-30 seconds. The reaction would be sent in the `storeNonText`/`onMessage` handler path, before any agent invocation.

### [IDEA] Consolidate `sendMessage` duplication between `TelegramChannel` and `sendPoolMessage`

Both `TelegramChannel.sendMessage` and `sendPoolMessage` contain identical chunking logic. This should be extracted into a shared utility:

```typescript
async function sendInChunks(api: Api, chatId: string, text: string): Promise<void>
```

Called from both paths. Any future improvement (word-boundary splitting, retry logic, parse_mode support) then only needs to be made in one place.

### [IDEA] IMAP IDLE instead of polling for email

The current email channel polls IMAP every 60 seconds. IMAP IDLE (RFC 2177) allows the server to push a notification when new mail arrives, eliminating the delay between receipt and processing. `imapflow` supports IDLE via its `idle()` method. This would reduce email response latency from up to 60 seconds to near-instant. The poll-based fallback could remain as a reliability net for connections that don't support IDLE.

### [IDEA] Per-channel rate limit tracking

Telegram's Bot API has per-bot rate limits (30 messages/second globally, 1 message/second per chat). With multiple groups active and agent swarms posting, it is easy to hit these limits silently. A lightweight token-bucket rate limiter shared across all send paths (both `TelegramChannel.sendMessage` and `sendPoolMessage`) would prevent 429 errors proactively rather than handling them reactively. The `bottleneck` npm package provides a production-ready implementation in a few lines.
