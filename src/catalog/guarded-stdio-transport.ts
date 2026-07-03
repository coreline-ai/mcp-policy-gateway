import { spawn, type ChildProcess } from "node:child_process";
import type { IOType } from "node:child_process";
import { Stream } from "node:stream";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface GuardedStdioServerParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: IOType | Stream | number;
}

export interface GuardedStdioTransportOptions {
  maxLineBytes?: number;
  onGuardError?: (error: Error) => void;
}

export const DEFAULT_STDIO_MAX_LINE_BYTES = 1024 * 1024;

export class GuardedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process?: ChildProcess;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closing = false;
  private closeNotified = false;

  constructor(
    private server: GuardedStdioServerParameters,
    private opts: GuardedStdioTransportOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.process) throw new Error("GuardedStdioClientTransport already started");
    const child = spawn(this.server.command, this.server.args ?? [], {
      env: this.server.env ?? {},
      cwd: this.server.cwd,
      stdio: ["pipe", "pipe", this.server.stderr ?? "inherit"],
      shell: false,
      windowsHide: process.platform === "win32",
    });
    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => this.append(chunk));
    child.stdout?.on("error", (error) => this.fail(error));
    child.stdin?.on("error", (error) => this.onerror?.(error));
    child.on("error", (error) => this.fail(error));
    child.on("close", () => {
      this.process = undefined;
      this.notifyClosed();
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin || this.closing) throw new Error("Not connected");
    const payload = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.process;
    if (!child) {
      this.notifyClosed();
      return;
    }
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      child.stdin?.end();
    } catch {
      /* best-effort close */
    }
    await Promise.race([closed, sleep(500)]);
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort close */
      }
      await Promise.race([closed, sleep(500)]);
    }
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort close */
      }
    }
    this.buffer = Buffer.alloc(0);
  }

  private append(chunk: Buffer): void {
    if (this.closing) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    const max = this.opts.maxLineBytes ?? DEFAULT_STDIO_MAX_LINE_BYTES;
    while (!this.closing) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        if (this.buffer.length > max) this.fail(new Error(`stdio JSON-RPC line exceeded ${max} bytes`));
        return;
      }
      if (newline > max) {
        this.fail(new Error(`stdio JSON-RPC line exceeded ${max} bytes`));
        return;
      }
      const line = this.buffer.toString("utf8", 0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.closing) return;
    this.opts.onGuardError?.(error);
    this.onerror?.(error);
    void this.close();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
