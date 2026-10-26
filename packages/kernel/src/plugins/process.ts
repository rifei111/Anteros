/**
 * 插件子进程（规范 6 §9/§10）：独立进程、stdout/stderr 环形缓冲、密钥泄漏扫描。
 *
 * 内核绝不因插件崩溃而退出——这里只负责启动/停止/采集，崩溃策略在 host.ts。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomHex } from "../util/crypto.js";
import type { LogSink } from "../util/log.js";

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024; // 每路 1MB

/** 疑似密钥的兜底正则（与 util/log.ts 的脱敏规则互补）。 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly re: RegExp }> = [
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/ },
  { kind: "private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { kind: "password-assignment", re: /\bpassword\s*[=:]\s*\S{3,}/i },
  { kind: "token-assignment", re: /\btoken\s*[=:]\s*[A-Za-z0-9._~+/-]{8,}/i },
];

export interface PluginExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true = 宿主主动停止；false = 异常退出（需要退避重启）。 */
  expected: boolean;
  stdoutTail: string;
  stderrTail: string;
}

export interface PluginProcessOptions {
  pluginId: string;
  entryPath: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: LogSink;
  /** 宿主生成的握手 token（缺省时自动生成）。 */
  token?: string;
  /** 已知密钥值（env 注入的），出现即视为泄漏。 */
  knownSecrets?: readonly string[];
  maxBufferBytes?: number;
  onSecret?: (info: { stream: "stdout" | "stderr"; kind: string }) => void;
  onExit?: (info: PluginExitInfo) => void;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export class RingTextBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      const overflow = this.size - this.maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  tail(maxBytes = this.maxBytes): string {
    const joined = Buffer.concat(this.chunks);
    const slice = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined;
    return slice.toString("utf8");
  }

  get length(): number {
    return this.size;
  }
}

export class PluginProcess {
  readonly pluginId: string;
  /** 一次性握手 token（只经环境变量注入插件进程，不进日志、不进数据库）。 */
  readonly token: string;

  private child: ChildProcess | null = null;
  private expectedStop = false;
  private exitInfo: PluginExitInfo | null = null;
  private readonly stdoutBuf: RingTextBuffer;
  private readonly stderrBuf: RingTextBuffer;
  private readonly lineCarry = { stdout: "", stderr: "" };
  private readonly reportedSecrets = new Set<string>();
  readonly startedTs: number;

  constructor(private readonly options: PluginProcessOptions) {
    this.pluginId = options.pluginId;
    this.token = options.token ?? randomHex(16);
    const max = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.stdoutBuf = new RingTextBuffer(max);
    this.stderrBuf = new RingTextBuffer(max);
    this.startedTs = Date.now();
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null && this.exitInfo === null;
  }

  get lastExit(): PluginExitInfo | null {
    return this.exitInfo;
  }

  stdoutTail(maxBytes?: number): string {
    return this.stdoutBuf.tail(maxBytes);
  }

  stderrTail(maxBytes?: number): string {
    return this.stderrBuf.tail(maxBytes);
  }

  start(): void {
    if (this.child !== null) throw new Error(`插件进程 ${this.pluginId} 已在运行`);
    const args = [this.options.entryPath, ...(this.options.args ?? [])];
    this.options.log.debug(`启动插件进程：${this.options.entryPath}（pid 待定）`);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.exitInfo = {
        code: null,
        signal: null,
        expected: false,
        stdoutTail: "",
        stderrTail: errorText(error),
      };
      this.options.onExit?.(this.exitInfo);
      return;
    }
    this.child = child;
    this.exitInfo = null;
    this.expectedStop = false;

    child.stdout?.on("data", (chunk: Buffer) => this.onStdio("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onStdio("stderr", chunk));
    child.on("error", (error) => {
      this.options.log.warn(`插件进程 ${this.pluginId} 错误：${errorText(error)}`);
    });
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
  }

  /** 宿主主动停止（先发 terminate；Windows 上等价 TerminateProcess）。 */
  stop(graceMs = 2000): Promise<void> {
    const child = this.child;
    if (child === null || this.exitInfo !== null) return Promise.resolve();
    this.expectedStop = true;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill();
        resolve();
      }, Math.max(0, graceMs));
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  kill(): void {
    this.expectedStop = true;
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* 进程已退出 */
    }
  }

  private onStdio(stream: "stdout" | "stderr", chunk: Buffer): void {
    this.scanSecrets(stream, chunk);
    (stream === "stdout" ? this.stdoutBuf : this.stderrBuf).push(chunk);
    this.emitLines(stream, chunk);
  }

  private emitLines(stream: "stdout" | "stderr", chunk: Buffer): void {
    const carry = this.lineCarry[stream] + chunk.toString("utf8");
    const lines = carry.split("\n");
    const rest = lines.pop() ?? "";
    // 单行过长时丢弃前半，避免无限增长。
    this.lineCarry[stream] = rest.length > 64 * 1024 ? rest.slice(-64 * 1024) : rest;
    for (const line of lines) {
      if (line.length === 0) continue;
      this.options.onLine?.(stream, this.redact(line));
      this.options.log.debug(`[${this.pluginId}:${stream}] ${this.redact(line)}`);
    }
  }

  private scanSecrets(stream: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text) && !this.reportedSecrets.has(pattern.kind)) {
        this.reportedSecrets.add(pattern.kind);
        this.options.onSecret?.({ stream, kind: pattern.kind });
      }
    }
    for (const secret of this.options.knownSecrets ?? []) {
      if (secret.length >= 6 && text.includes(secret)) {
        const key = `known:${secret.slice(0, 3)}`;
        if (!this.reportedSecrets.has(key)) {
          this.reportedSecrets.add(key);
          this.options.onSecret?.({ stream, kind: "known-secret" });
        }
      }
    }
  }

  private redact(line: string): string {
    let output = line;
    for (const pattern of SECRET_PATTERNS) {
      output = output.replace(pattern.re, `[已脱敏:${pattern.kind}]`);
    }
    for (const secret of this.options.knownSecrets ?? []) {
      if (secret.length >= 6) output = output.split(secret).join("[已脱敏:known-secret]");
    }
    return output;
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const info: PluginExitInfo = {
      code,
      signal,
      expected: this.expectedStop,
      stdoutTail: this.stdoutBuf.tail(4096),
      stderrTail: this.stderrBuf.tail(4096),
    };
    this.exitInfo = info;
    this.child = null;
    this.options.log.info(
      `插件进程 ${this.pluginId} 退出：code=${String(code)} signal=${String(signal)} expected=${String(info.expected)}`,
    );
    this.options.onExit?.(info);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
