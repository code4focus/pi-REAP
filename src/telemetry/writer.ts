import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord, EpochRecord, RequestRecord } from "./records.js";

export interface TelemetryWriterOptions { directory?: string; sessionId?: string; now?: () => number }
export type TelemetryRecord = DecisionRecord | RequestRecord | EpochRecord;

/** Best-effort, observation-only JSONL writer. Any filesystem failure is ignored. */
export class TelemetryWriter {
  readonly sessionHash: string;
  private readonly directory: string;
  private readonly now: () => number;
  private failures = 0;

  constructor(options: TelemetryWriterOptions = {}) {
    this.directory = options.directory ?? process.env.PI_REAP_TELEMETRY_DIR ?? join(process.cwd(), ".pi", "effort-router");
    this.sessionHash = hash(options.sessionId ?? randomUUID());
    this.now = options.now ?? Date.now;
  }

  writeDecision(record: DecisionRecord): void { this.write("decisions.jsonl", record); }
  writeRequest(record: RequestRecord): void { this.write("requests.jsonl", record); }
  writeEpoch(record: EpochRecord): void { this.write("epochs.jsonl", record); }
  status(): string { return this.failures === 0 ? "telemetry:ready" : "telemetry:degraded"; }
  timestamp(): number { return this.now(); }

  private write(file: string, record: TelemetryRecord): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(join(this.directory, file), `${JSON.stringify(record)}\n`, "utf8");
    } catch { this.failures += 1; }
  }
}

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
