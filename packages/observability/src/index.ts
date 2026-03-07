export interface LogContext {
  taskId?: string;
  stepId?: string;
  jobId?: string;
  workerId?: string;
  correlationId?: string;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: LogContext): Logger;
}

export class ConsoleLogger implements Logger {
  constructor(
    private readonly enabled = true,
    private readonly context: LogContext = {}
  ) {}

  child(context: LogContext): Logger {
    return new ConsoleLogger(this.enabled, { ...this.context, ...context });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }
    const merged = this.merge(meta);
    console.info(`[info] ${message}`, Object.keys(merged).length > 0 ? merged : "");
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }
    const merged = this.merge(meta);
    console.warn(`[warn] ${message}`, Object.keys(merged).length > 0 ? merged : "");
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }
    const merged = this.merge(meta);
    console.error(`[error] ${message}`, Object.keys(merged).length > 0 ? merged : "");
  }

  private merge(meta?: Record<string, unknown>): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.context)) {
      if (value !== undefined) {
        ctx[key] = value;
      }
    }
    return { ...ctx, ...meta };
  }
}

export class StructuredLogger implements Logger {
  constructor(private readonly context: LogContext = {}) {}

  child(context: LogContext): Logger {
    return new StructuredLogger({ ...this.context, ...context });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }

  private emit(level: string, message: string, meta?: Record<string, unknown>): void {
    const ctx: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.context)) {
      if (value !== undefined) {
        ctx[key] = value;
      }
    }
    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      msg: message,
      ...ctx,
      ...meta
    });
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
