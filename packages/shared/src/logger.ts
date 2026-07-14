import { appendJsonl, redactSecrets } from "./storage";
import type { EngineName, RunEvent } from "./schemas/run";

export interface RunLogger {
  readonly file: string;
  event(level: RunEvent["level"], event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(fields: { engine?: EngineName; scenarioId?: string; step?: string }): RunLogger;
  /** Wait for queued writes to hit disk. Call before reading the file. */
  flush(): Promise<void>;
}

export interface RunLoggerOptions {
  runId: string;
  file: string;
  engine?: EngineName;
  scenarioId?: string;
  step?: string;
  console?: boolean;
}

/**
 * Structured JSONL logger. Appends are serialised through a promise chain so
 * concurrent events never interleave mid-line; every line passes through
 * secret redaction before hitting disk or the console.
 */
export function createRunLogger(options: RunLoggerOptions): RunLogger {
  let queue: Promise<void> = Promise.resolve();

  const emit = (
    fields: Pick<RunLoggerOptions, "engine" | "scenarioId" | "step">,
    level: RunEvent["level"],
    event: string,
    data?: Record<string, unknown>
  ): void => {
    const record: RunEvent = {
      ts: new Date().toISOString(),
      runId: options.runId,
      level,
      event,
      ...(fields.engine ? { engine: fields.engine } : {}),
      ...(fields.scenarioId ? { scenarioId: fields.scenarioId } : {}),
      ...(fields.step ? { step: fields.step } : {}),
      ...(data ? { data } : {})
    };
    const line = redactSecrets(JSON.stringify(record));
    queue = queue
      .then(() => appendJsonl(options.file, JSON.parse(line)))
      .catch(() => {
        /* logging must never crash the pipeline */
      });
    if (options.console) {
      const time = record.ts.slice(11, 19);
      const scope = [fields.engine, fields.step].filter(Boolean).join(" ");
      const extra = data ? ` ${redactSecrets(JSON.stringify(data))}` : "";
      console.log(`${time} ${level.padEnd(5)} ${scope ? `[${scope}] ` : ""}${event}${extra}`);
    }
  };

  const make = (
    fields: Pick<RunLoggerOptions, "engine" | "scenarioId" | "step">
  ): RunLogger => ({
    file: options.file,
    event: (level, event, data) => emit(fields, level, event, data),
    debug: (event, data) => emit(fields, "debug", event, data),
    info: (event, data) => emit(fields, "info", event, data),
    warn: (event, data) => emit(fields, "warn", event, data),
    error: (event, data) => emit(fields, "error", event, data),
    child: (extra) => make({ ...fields, ...extra }),
    flush: () => queue
  });

  return make({
    engine: options.engine,
    scenarioId: options.scenarioId,
    step: options.step
  });
}
