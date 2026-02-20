/**
 * Unix Socket Channel for AgentForge
 *
 * Provides a local socket interface for external clients (TUI, web, etc.)
 * to communicate with the always-running AgentForge service.
 *
 * Protocol: newline-delimited JSON (NDJSON)
 *
 * Client → Server:
 *   { "type": "message", "text": "hello" }\n
 *   { "type": "ping" }\n
 *   { "type": "status" }\n
 *
 * Server → Client:
 *   { "type": "history", "messages": [...] }\n
 *   { "type": "chunk", "text": "..." }\n       ← streaming partial response
 *   { "type": "response_end" }\n               ← end of streaming response
 *   { "type": "response", "text": "..." }\n    ← non-streaming message
 *   { "type": "typing", "active": true }\n
 *   { "type": "pong" }\n
 *   { "type": "error", "message": "..." }\n
 *   { "type": "status", "connections": N, "uptime": N }\n
 *
 * JID format: socket:{uuid}
 * Each connection auto-registers with the main group folder.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';

import { SOCKET_PATH } from '../config.js';
import { getRecentSocketHistory } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface SocketChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  groupFolder: string;
  assistantName: string;
}

interface SocketConnection {
  jid: string;
  socket: net.Socket;
  buffer: string;
}

export class SocketChannel implements Channel {
  name = 'socket';
  prefixAssistantName = false;

  private opts: SocketChannelOpts;
  private server: net.Server | null = null;
  private connections = new Map<string, SocketConnection>(); // jid → connection
  private typingJids = new Set<string>();
  private listening = false;

  constructor(opts: SocketChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Remove stale socket file so restart doesn't fail with EADDRINUSE
    if (fs.existsSync(SOCKET_PATH)) {
      try {
        fs.unlinkSync(SOCKET_PATH);
        logger.debug({ path: SOCKET_PATH }, 'Removed stale socket file');
      } catch (err) {
        logger.warn(
          { err, path: SOCKET_PATH },
          'Failed to remove stale socket file',
        );
      }
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err) => {
      logger.error({ err }, 'Socket server error');
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(SOCKET_PATH, () => {
        this.listening = true;
        logger.info({ path: SOCKET_PATH }, 'Unix socket channel listening');
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  private handleConnection(socket: net.Socket): void {
    const uuid = crypto.randomUUID();
    const jid = `socket:${uuid}`;
    const conn: SocketConnection = { jid, socket, buffer: '' };
    this.connections.set(jid, conn);

    logger.info({ jid }, 'Socket client connected');

    // Auto-register with the main group folder so this connection shares
    // memory and context with the rest of AgentForge.
    const timestamp = new Date().toISOString();
    const groups = this.opts.registeredGroups();
    if (!groups[jid]) {
      this.opts.registerGroup(jid, {
        name: `Socket client ${uuid.slice(0, 8)}`,
        folder: this.opts.groupFolder,
        trigger: '',
        added_at: timestamp,
        requiresTrigger: false,
      });
      logger.debug(
        { jid, groupFolder: this.opts.groupFolder },
        'Auto-registered socket connection',
      );
    }

    this.opts.onChatMetadata(jid, timestamp);

    // Send recent history so the client can show conversation context
    const history = getRecentSocketHistory(30);
    if (history.length > 0) {
      this.writeToSocket(socket, {
        type: 'history',
        messages: history.map((m) => ({
          role: m.is_from_me ? 'assistant' : 'user',
          content: m.content,
          timestamp: m.timestamp,
        })),
      });
    }

    socket.on('data', (chunk: Buffer) => {
      conn.buffer += chunk.toString('utf8');
      this.processBuffer(conn);
    });

    socket.on('end', () => {
      logger.info({ jid }, 'Socket client disconnected');
      this.typingJids.delete(jid);
      this.connections.delete(jid);
    });

    socket.on('error', (err) => {
      logger.debug({ jid, err }, 'Socket client error');
      this.typingJids.delete(jid);
      this.connections.delete(jid);
    });
  }

  private processBuffer(conn: SocketConnection): void {
    // Split on newlines, keeping partial last line in buffer
    const lines = conn.buffer.split('\n');
    // Last element is either empty (complete line) or a partial line
    conn.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(conn, trimmed);
    }
  }

  private handleLine(conn: SocketConnection, line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.writeToSocket(conn.socket, {
        type: 'error',
        message: 'Invalid JSON',
      });
      return;
    }

    const type = msg['type'];

    if (type === 'ping') {
      this.writeToSocket(conn.socket, { type: 'pong' });
      return;
    }

    if (type === 'message') {
      const text = typeof msg['text'] === 'string' ? msg['text'] : '';
      if (!text) {
        this.writeToSocket(conn.socket, {
          type: 'error',
          message: 'Missing text field',
        });
        return;
      }

      const timestamp = new Date().toISOString();
      const newMsg = {
        id: crypto.randomUUID(),
        chat_jid: conn.jid,
        sender: conn.jid,
        sender_name: 'User',
        content: text,
        timestamp,
        is_from_me: false,
      };

      this.opts.onChatMetadata(conn.jid, timestamp);
      this.opts.onMessage(conn.jid, newMsg);

      logger.info(
        { jid: conn.jid, length: text.length },
        'Socket message received',
      );
      return;
    }

    if (type === 'status') {
      this.writeToSocket(conn.socket, {
        type: 'status',
        connections: this.connections.size,
        uptime: Math.floor(process.uptime()),
      });
      return;
    }

    this.writeToSocket(conn.socket, {
      type: 'error',
      message: `Unknown message type: ${type}`,
    });
  }

  private writeToSocket(
    socket: net.Socket,
    data: Record<string, unknown>,
  ): void {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(data) + '\n');
    } catch (err) {
      logger.debug({ err }, 'Failed to write to socket client');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conn = this.connections.get(jid);
    if (!conn) {
      logger.warn({ jid }, 'No socket connection found for JID');
      return;
    }
    // During active typing, send as streaming chunk; otherwise discrete response
    const msgType = this.typingJids.has(jid) ? 'chunk' : 'response';
    this.writeToSocket(conn.socket, { type: msgType, text });
    logger.info({ jid, length: text.length }, `Socket ${msgType} sent`);
  }

  async setTyping(
    jid: string,
    active: boolean,
    stats?: {
      tokensIn?: number;
      tokensOut?: number;
      model?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    const conn = this.connections.get(jid);
    if (!conn) return;
    if (active) {
      this.typingJids.add(jid);
      this.writeToSocket(conn.socket, { type: 'typing', active: true });
    } else {
      this.typingJids.delete(jid);
      // Signal end of streaming response, including token stats if available
      this.writeToSocket(conn.socket, {
        type: 'response_end',
        ...(stats?.tokensIn !== undefined && { tokensIn: stats.tokensIn }),
        ...(stats?.tokensOut !== undefined && { tokensOut: stats.tokensOut }),
        ...(stats?.model && { model: stats.model }),
        ...(stats?.durationMs !== undefined && {
          durationMs: stats.durationMs,
        }),
      });
      this.writeToSocket(conn.socket, { type: 'typing', active: false });
    }
  }

  isConnected(): boolean {
    return this.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('socket:');
  }

  async disconnect(): Promise<void> {
    // Close all active connections
    for (const conn of this.connections.values()) {
      try {
        conn.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    this.typingJids.clear();

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.listening = false;

    // Clean up socket file
    if (fs.existsSync(SOCKET_PATH)) {
      try {
        fs.unlinkSync(SOCKET_PATH);
      } catch {
        /* ignore */
      }
    }

    logger.info('Socket channel disconnected');
  }
}
