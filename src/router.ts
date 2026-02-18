/**
 * Message formatting and channel routing helpers.
 *
 * Responsible for transforming raw message data into the XML format
 * the agent expects, and for formatting agent responses for delivery
 * back to users via the appropriate channel.
 */
import { ASSISTANT_NAME } from './config.js';
import { Channel, NewMessage } from './types.js';

/**
 * Escape special XML characters in a string.
 * Used to safely embed user-provided content inside XML message attributes and text nodes.
 *
 * @param s - Raw string that may contain XML-unsafe characters
 * @returns XML-safe string
 */
export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize a batch of messages into the XML format expected by the agent.
 *
 * Produces a `<messages>` block where each message carries sender name and
 * timestamp as attributes and the message content as the element body.
 * All user-controlled strings are XML-escaped to prevent injection.
 *
 * @param messages - Ordered list of messages to include in the prompt
 * @returns XML string ready to pass as the agent's prompt
 */
export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Remove `<internal>...</internal>` blocks from agent output.
 * Agents use these tags for self-directed reasoning that should not be
 * surfaced to end users.
 *
 * @param text - Raw agent output potentially containing internal blocks
 * @returns Cleaned text with internal blocks stripped and surrounding whitespace trimmed
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Format an agent response for delivery to a user via a channel.
 *
 * Strips internal reasoning blocks, then optionally prefixes the text with
 * the assistant name (e.g. "Andy: ...") based on the channel's configuration.
 *
 * Supports two call signatures for backwards compatibility:
 * - `formatOutbound(rawText)` - strips internal tags only, no prefix
 * - `formatOutbound(channel, rawText)` - strips tags and applies channel prefix rules
 *
 * @param channelOrText - Either the target Channel or the raw text (legacy form)
 * @param rawText - The agent's response text (only used in the two-arg form)
 * @returns Formatted string ready to send, or empty string if nothing remains after stripping
 */
export function formatOutbound(
  channelOrText: Channel | string,
  rawText?: string,
): string {
  // Backwards compatibility: if called with just text (string), strip internal tags only
  if (typeof channelOrText === 'string' && rawText === undefined) {
    const text = stripInternalTags(channelOrText);
    if (!text) return '';
    return text;
  }

  // New signature: formatOutbound(channel, rawText)
  const channel = channelOrText as Channel;
  const text = stripInternalTags(rawText!);
  if (!text) return '';

  // Prefix with assistant name if channel requires it (default: true for backwards compat)
  const shouldPrefix = channel.prefixAssistantName !== false;
  if (shouldPrefix) {
    return `${ASSISTANT_NAME}: ${text}`;
  }

  return text;
}

/**
 * Find the channel responsible for a given JID.
 *
 * Each channel owns a disjoint set of JIDs determined by prefix convention
 * (e.g. "tg:" for Telegram). Returns the first channel whose `ownsJid`
 * predicate matches, or undefined if no channel claims the JID.
 *
 * @param channels - All connected channels
 * @param jid - The chat JID to look up
 * @returns The owning Channel, or undefined
 */
export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
