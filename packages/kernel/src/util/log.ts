/**
 * 结构化日志：写文件 + 环形内存缓冲（客户端日志面板用）。
 *
 * 红线：插件 stdout/stderr 与密钥不得进日志（规范 6 §11.2）；这里只做兜底脱敏，
 * 真正的约束在各调用点——不要 log 出 apiKey、token、明文消息正文。
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 内核内部统一的日志出口。`Logger`（进程级）与 `SourceLogger`（带 source 前缀）
 * 都实现它，这样构造函数既可以收进程级 logger，也可以收 `logger.child("chat")`。
 */
export interface LogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

const SENSITIVE = /(sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|password=([^\s,&]+)|token=([^\s,&]+))/g;

function redact(text: string): string {
  return text.replace(SENSITIVE, (match) => {
    const head = match.slice(0, 4);
    return `${head}***`;
  });
}

export class Logger implements LogSink {
  private readonly buffer: LogEntry[] = [];
  private readonly stream: fs.WriteStream | null;
  private readonly level: LogLevel;
  private readonly maxBuffer = 500;
  private readonly source: string;

  constructor(options: { dataDir?: string; level?: LogLevel; source?: string } = {}) {
    this.level = options.level ?? "info";
    this.source = options.source ?? "kernel";
    if (options.dataDir) {
      const dir = path.join(options.dataDir, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      this.stream = fs.createWriteStream(path.join(dir, `kernel-${day}.log`), { flags: "a" });
    } else {
      this.stream = null;
    }
  }

  debug(message: string): void {
    this.write("debug", this.source, message);
  }
  info(message: string): void {
    this.write("info", this.source, message);
  }
  warn(message: string): void {
    this.write("warn", this.source, message);
  }
  error(message: string): void {
    this.write("error", this.source, message);
  }

  child(source: string): SourceLogger {
    return new SourceLogger(this, source);
  }

  /** 供客户端拉取最近日志。 */
  recent(limit = 200): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  write(level: LogLevel, source: string, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, source, message: redact(message) };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    const line = JSON.stringify(entry);
    if (this.stream) this.stream.write(line + "\n");
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  }

  close(): void {
    this.stream?.end();
  }
}

export class SourceLogger implements LogSink {
  constructor(
    private readonly logger: Logger,
    private readonly source: string,
  ) {}

  debug(message: string): void {
    this.logger.write("debug", this.source, message);
  }
  info(message: string): void {
    this.logger.write("info", this.source, message);
  }
  warn(message: string): void {
    this.logger.write("warn", this.source, message);
  }
  error(message: string): void {
    this.logger.write("error", this.source, message);
  }
}