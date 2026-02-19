/**
 * Gmail Channel for AgentForge
 *
 * Polls Gmail via IMAP for new emails matching a trigger label or subject prefix.
 * Sends responses via SMTP (nodemailer + app password).
 *
 * JID format: email:<sender@address.com>
 * Each sender gets their own conversation context.
 */
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';

import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface EmailChannelOpts {
  gmailUser: string;
  appPassword: string;
  triggerLabel?: string; // Gmail label to watch (default: 'AgentForge')
  triggerSubject?: string; // Subject prefix alternative to label
  pollIntervalMs?: number; // How often to check inbox (default: 60s)
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface PendingReply {
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
  threadId: string;
}

// Map from email JID → pending reply context (set when email comes in, used on send)
const pendingReplies = new Map<string, PendingReply>();

export class EmailChannel implements Channel {
  name = 'email';
  prefixAssistantName = true;

  private opts: EmailChannelOpts;
  private transporter: nodemailer.Transporter | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private processedIds = new Set<string>(); // Dedup across poll cycles

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Set up SMTP transporter
    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: this.opts.gmailUser,
        pass: this.opts.appPassword,
      },
    });

    // Verify SMTP connection
    await this.transporter.verify();
    logger.info({ user: this.opts.gmailUser }, 'Email channel SMTP connected');

    this.connected = true;
    const interval = this.opts.pollIntervalMs ?? 60_000;
    // Run first poll in background — don't await it so IMAP latency doesn't
    // block startup and prevent the message loop from starting.
    this.pollInbox().catch((err) =>
      logger.warn({ err }, 'Initial email poll failed'),
    );
    this.pollTimer = setInterval(() => {
      this.pollInbox().catch((err) =>
        logger.warn({ err }, 'Email poll failed'),
      );
    }, interval);
    logger.info({ intervalMs: interval }, 'Email channel polling started');
  }

  private async pollInbox(): Promise<void> {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.opts.gmailUser,
        pass: this.opts.appPassword,
      },
      logger: false,
      socketTimeout: 30_000, // 30s — prevents polls from hanging indefinitely
    });

    // Prevent socket-level errors (e.g. ETIMEOUT) from escaping as uncaught exceptions.
    // imapflow emits these as events on the underlying TLSSocket which bypass try/catch.
    client.on('error', (err: Error) => {
      logger.warn({ err }, 'IMAP connection error (handled)');
    });

    try {
      await client.connect();

      const label = this.opts.triggerLabel || 'AgentForge';
      const subjectPrefix = this.opts.triggerSubject;

      // Try to use a Gmail label if configured; fall back to INBOX with subject filter
      let mailbox = 'INBOX';
      if (label !== 'INBOX') {
        // Check if label exists; if not, fall back to INBOX
        try {
          const list = await client.list();
          const labelExists = list.some(
            (m) =>
              m.name.toLowerCase() === label.toLowerCase() ||
              m.path.toLowerCase() === label.toLowerCase(),
          );
          if (labelExists) {
            mailbox = label;
          } else if (!subjectPrefix) {
            logger.warn(
              { label },
              'Gmail label not found and no subjectPrefix set — watching INBOX for all emails',
            );
          }
        } catch {
          // If listing fails, just use INBOX
        }
      }

      await client.mailboxOpen(mailbox);

      // Search for unread messages
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        await client.logout();
        return;
      }

      for await (const msg of client.fetch(
        uids,
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
          source: true,
        },
        { uid: true },
      )) {
        const uid = msg.uid.toString();
        const messageId = msg.envelope?.messageId || uid;

        if (this.processedIds.has(messageId)) continue;
        this.processedIds.add(messageId);

        // Subject filter if using INBOX + prefix
        const subject = msg.envelope?.subject || '(no subject)';
        if (subjectPrefix && mailbox === 'INBOX') {
          if (!subject.toLowerCase().startsWith(subjectPrefix.toLowerCase())) {
            continue;
          }
        }

        const from = msg.envelope?.from?.[0];
        if (!from) continue;
        const senderEmail = from.address || '';
        const senderName = from.name || senderEmail;

        if (!senderEmail) continue;

        // Parse plain text body from source
        const source = msg.source?.toString() || '';
        const body = extractPlainText(source);

        const chatJid = `email:${senderEmail.toLowerCase()}`;
        const timestamp = (msg.envelope?.date || new Date()).toISOString();
        const references =
          msg.envelope?.inReplyTo || msg.envelope?.messageId || '';

        // Store reply context for when we send a response
        pendingReplies.set(chatJid, {
          to: senderEmail,
          subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
          inReplyTo: messageId,
          references: [references, messageId].filter(Boolean).join(' '),
          threadId: messageId,
        });

        // Auto-register sender as a group if not already registered
        const groups = this.opts.registeredGroups();
        if (!groups[chatJid]) {
          this.opts.registerGroup(chatJid, {
            name: senderName || senderEmail,
            folder: `email-${sanitizeFolder(senderEmail)}`,
            trigger: '',
            added_at: timestamp,
            requiresTrigger: false,
          });
          logger.info(
            { chatJid, senderEmail },
            'Auto-registered email sender as group',
          );
        }

        // Store chat metadata
        this.opts.onChatMetadata(chatJid, timestamp, senderName || senderEmail);

        // Deliver message to orchestrator
        this.opts.onMessage(chatJid, {
          id: crypto.randomUUID(),
          chat_jid: chatJid,
          sender: senderEmail,
          sender_name: senderName || senderEmail,
          content: `[Email from ${senderEmail}]\nSubject: ${subject}\n\n${body}`,
          timestamp,
          is_from_me: false,
        });

        // Mark as read
        try {
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], {
            uid: true,
          });
        } catch (err) {
          logger.debug({ err }, 'Could not mark email as read');
        }

        logger.info(
          { from: senderEmail, subject, chatJid },
          'Email received and stored',
        );
      }

      await client.logout();
    } catch (err) {
      logger.error({ err }, 'Email poll error');
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transporter) {
      logger.warn('Email transporter not initialized');
      return;
    }

    const reply = pendingReplies.get(jid);
    if (!reply) {
      logger.warn({ jid }, 'No pending reply context for email JID');
      return;
    }

    try {
      await this.transporter.sendMail({
        from: `Pip <${this.opts.gmailUser}>`,
        to: reply.to,
        subject: reply.subject,
        text,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });
      logger.info({ to: reply.to, subject: reply.subject }, 'Email reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send email reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.transporter = null;
    this.connected = false;
    logger.info('Email channel disconnected');
  }
}

/** Extract plain text from a raw email source (very minimal MIME parser). */
function extractPlainText(source: string): string {
  // Find Content-Type: text/plain boundary
  const lines = source.split('\n');
  let inBody = false;
  let inTextPart = false;
  let boundary = '';
  const bodyLines: string[] = [];

  // Check for multipart boundary in headers
  const contentTypeLine = lines.find(
    (l) =>
      l.toLowerCase().startsWith('content-type:') &&
      l.toLowerCase().includes('boundary='),
  );
  if (contentTypeLine) {
    const match = contentTypeLine.match(/boundary="?([^";\s]+)"?/i);
    if (match) boundary = match[1];
  }

  if (!boundary) {
    // Simple single-part email — skip headers, take body
    let headersDone = false;
    for (const line of lines) {
      if (!headersDone && line.trim() === '') {
        headersDone = true;
        continue;
      }
      if (headersDone) bodyLines.push(line);
    }
    return bodyLines.join('\n').trim().slice(0, 4000);
  }

  // Multipart: find text/plain section
  let currentPartIsText = false;
  let inPartHeaders = false;

  for (const line of lines) {
    const stripped = line.trim();

    if (stripped === `--${boundary}` || stripped === `--${boundary}--`) {
      inPartHeaders = true;
      currentPartIsText = false;
      inBody = false;
      continue;
    }

    if (inPartHeaders) {
      if (stripped === '') {
        inPartHeaders = false;
        inBody = currentPartIsText;
        continue;
      }
      if (stripped.toLowerCase().startsWith('content-type: text/plain')) {
        currentPartIsText = true;
        inTextPart = true;
      }
      continue;
    }

    if (inBody && inTextPart) {
      bodyLines.push(line);
    }
  }

  const result = bodyLines.join('\n').trim();
  // Strip quoted reply sections (lines starting with ">")
  const withoutQuotes = result
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n')
    .trim();

  return (withoutQuotes || result).slice(0, 4000);
}

/** Convert email address to a safe folder name. */
function sanitizeFolder(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
