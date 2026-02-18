import { ASSISTANT_NAME } from './config.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

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

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
