/**
 * MCP Stdio Transport
 *
 * Handles JSON-RPC 2.0 communication over stdin/stdout for MCP protocol.
 * Uses Content-Length framing as specified by the MCP stdio transport spec.
 */

import { captureException } from '../sentry';

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 Response
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// Standard JSON-RPC error codes
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type MessageHandler = (message: JsonRpcRequest | JsonRpcNotification) => Promise<void>;

/**
 * Stdio Transport for MCP
 *
 * Reads JSON-RPC messages from stdin using Content-Length framing
 * (as specified by the MCP stdio transport spec) and writes
 * Content-Length-framed responses to stdout.
 */
export class StdioTransport {
  private messageHandler: MessageHandler | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private messageQueue: string[] = [];
  private processing = false;

  /**
   * Start listening for messages on stdin
   */
  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.extractMessages();
    });

    process.stdin.on('end', () => {
      process.exit(0);
    });

    process.stdin.on('close', () => {
      process.exit(0);
    });
  }

  /**
   * Extract complete messages from the buffer.
   *
   * Supports both Content-Length framed messages (MCP standard)
   * and newline-delimited JSON (legacy/simple clients).
   */
  private extractMessages(): void {
    while (this.buffer.length > 0) {
      const bufStr = this.buffer.toString('utf-8');

      // Try Content-Length framing first
      const headerMatch = bufStr.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
      if (headerMatch) {
        const contentLength = parseInt(headerMatch[1]!, 10);
        const headerBytes = Buffer.byteLength(headerMatch[0], 'utf-8');
        const totalNeeded = headerBytes + contentLength;

        if (this.buffer.length < totalNeeded) {
          // Not enough data yet — wait for more
          return;
        }

        const jsonBuf = this.buffer.slice(headerBytes, totalNeeded);
        this.buffer = this.buffer.slice(totalNeeded);
        this.messageQueue.push(jsonBuf.toString('utf-8'));
        this.processQueue();
        continue;
      }

      // Fallback: newline-delimited JSON
      const newlineIdx = bufStr.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = bufStr.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(Buffer.byteLength(line + '\n', 'utf-8'));
        const trimmed = line.trim();
        if (trimmed) {
          this.messageQueue.push(trimmed);
          this.processQueue();
        }
        continue;
      }

      // No complete message yet
      return;
    }
  }

  /**
   * Process queued messages one at a time.
   * Ensures each message handler completes before the next starts,
   * preventing out-of-order responses when handlers are async.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift()!;
        await this.handleMessage(msg);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Stop listening
   */
  stop(): void {
    process.stdin.removeAllListeners();
  }

  /**
   * Send a response as newline-delimited JSON.
   *
   * Claude Code v2.1+ uses newline-delimited JSON (not Content-Length framing)
   * for the stdio MCP transport. Both input and output use `JSON\n` format.
   */
  send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(json + '\n');
  }

  /**
   * Send a notification (no id)
   */
  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    const json = JSON.stringify(notification);
    process.stdout.write(json + '\n');
  }

  /**
   * Send a success response
   */
  sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Send an error response
   */
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    });
  }

  /**
   * Handle an incoming JSON message string
   */
  private async handleMessage(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.sendError(null, ErrorCodes.ParseError, 'Parse error: invalid JSON');
      return;
    }

    // Validate basic JSON-RPC structure
    if (!this.isValidMessage(parsed)) {
      this.sendError(null, ErrorCodes.InvalidRequest, 'Invalid Request: not a valid JSON-RPC 2.0 message');
      return;
    }

    if (this.messageHandler) {
      try {
        await this.messageHandler(parsed as JsonRpcRequest | JsonRpcNotification);
      } catch (err) {
        captureException(err, { operation: 'mcp-message-handler' });
        const message = parsed as JsonRpcRequest;
        if ('id' in message) {
          this.sendError(
            message.id,
            ErrorCodes.InternalError,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  /**
   * Check if message is a valid JSON-RPC 2.0 message
   */
  private isValidMessage(msg: unknown): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj.jsonrpc !== '2.0') return false;
    if (typeof obj.method !== 'string') return false;
    return true;
  }
}
