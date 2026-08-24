// =============================================================================
// Minimal structured logger. Writes JSON lines to stdout so an external log
// collector can pick them up without us pulling in pino / winston.
//
// Format: `{"ts":...,"level":"info","component":"whatsapp","msg":"..."}`
// =============================================================================

import type { RuntimeConfig } from "./config.js";

const LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
type Level = (typeof LEVELS)[number];

export class Logger {
  constructor(
    private readonly component: string,
    private readonly threshold: RuntimeConfig["logLevel"],
  ) {}

  error(msg: string, extra?: Record<string, unknown>): void {
    this.log("error", msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.log("warn", msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.log("info", msg, extra);
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.log("debug", msg, extra);
  }

  private log(level: Level, msg: string, extra?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...(extra ?? {}),
    });
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  private enabled(level: Level): boolean {
    const t = LEVELS.indexOf(this.threshold);
    const l = LEVELS.indexOf(level);
    return t >= 0 && l >= 0 && l <= t;
  }
}
