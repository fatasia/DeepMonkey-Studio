import { validateChartJson, type ChartIR, type ChartValue } from "./chartIr.js";
import { applyChartDataUpdate } from "./chartDataApply.js";
import { CHART_DATA_MESSAGE_MAX_BYTES, type ChartDataUpdateMessage } from "./chartDataUpdate.js";

export interface ChartSimFixture {
  readonly schema: "deep-engine.chart-sim";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly chartId: string;
  readonly datasetId: string;
  readonly dimensions: readonly string[];
  readonly rows: readonly (readonly ChartValue[])[];
  readonly seed: number;
  readonly intervalMs: number;
  readonly startTimeMs: number;
  readonly maxRows: number;
}
export interface ChartSimFrame {
  readonly capturedAtMs: number;
  readonly message: ChartDataUpdateMessage;
}
const fields = ["schema", "schemaVersion", "id", "chartId", "datasetId", "dimensions", "rows", "seed", "intervalMs", "startTimeMs", "maxRows"];
const stableId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(v)
  && !["__proto__", "prototype", "constructor"].includes(v);
const boundedInteger = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** 固定步长播放夹具行；时钟由宿主传入，seed 仅旋转起始行，不访问网络或系统随机源。 */
export class ChartSimulationSource {
  readonly #fixture: ChartSimFixture;
  readonly #frames = new WeakMap<ChartSimFrame, { tick: number; revision: number }>();
  #tick = 0;
  #cancelled = false;

  constructor(input: unknown, chart: ChartIR, dataRevision = 0) {
    if (validateChartJson(input).length || input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid sim fixture JSON.");
    const v = input as Record<string, unknown>;
    if (Object.keys(v).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(v, key))
      || v.schema !== "deep-engine.chart-sim" || v.schemaVersion !== 1 || !stableId(v.id) || v.chartId !== chart.id
      || !boundedInteger(v.seed, 0, 0xffffffff) || !boundedInteger(v.intervalMs, 1, 86400000)
      || !boundedInteger(v.startTimeMs, 0, Number.MAX_SAFE_INTEGER) || !Array.isArray(v.rows) || !v.rows.length)
      throw new Error("Invalid sim fixture identity, clock or rows.");
    const dataset = chart.datasets.find(dataset => dataset.id === v.datasetId);
    if (!dataset || JSON.stringify(dataset.dimensions) !== JSON.stringify(v.dimensions))
      throw new Error("Sim dataset dimensions do not match the chart.");
    this.#fixture = structuredClone(v) as unknown as ChartSimFixture;
    // 复用数据合同检查全部输入行；窗口将丢弃的行也必须合法。
    applyChartDataUpdate(chart, dataRevision, this.#message(this.#fixture.rows, dataRevision));
  }

  static fromJson(text: string, chart: ChartIR, dataRevision = 0): ChartSimulationSource {
    if (text.length > CHART_DATA_MESSAGE_MAX_BYTES || new TextEncoder().encode(text).byteLength > CHART_DATA_MESSAGE_MAX_BYTES)
      throw new Error("Sim fixture exceeds 16 MiB.");
    return new ChartSimulationSource(JSON.parse(text), chart, dataRevision);
  }
  /** Independent cursor for a page candidate; pending frame tokens never cross ownership. */
  fork(chart: ChartIR, dataRevision = 0): ChartSimulationSource {
    const copy = new ChartSimulationSource(this.#fixture, chart, dataRevision);
    copy.#tick = this.#tick;
    copy.#cancelled = this.#cancelled;
    return copy;
  }
  get nextDueMs(): number {
    const due = this.#tick * this.#fixture.intervalMs;
    if (!Number.isSafeInteger(due)) throw new Error("Sim clock exhausted.");
    return due;
  }
  get cancelled(): boolean { return this.#cancelled; }
  cancel(): void { this.#cancelled = true; }

  prepare(elapsedMs: number, dataRevision: number): ChartSimFrame | undefined {
    if (this.#cancelled) return undefined;
    if (!boundedInteger(elapsedMs, 0, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid sim elapsed time.");
    if (elapsedMs < this.nextDueMs) return undefined;
    const capturedAtMs = this.#fixture.startTimeMs + this.nextDueMs;
    if (!Number.isSafeInteger(capturedAtMs)) throw new Error("Sim timestamp exhausted.");
    if (!boundedInteger(dataRevision, 0, Number.MAX_SAFE_INTEGER - 1)) throw new Error("Sim data revision exhausted.");
    const count = this.#fixture.rows.length;
    const index = ((this.#fixture.seed % count) + (this.#tick % count)) % count;
    const row = Object.freeze([...this.#fixture.rows[index]!]);
    const message = this.#message(Object.freeze([row]), dataRevision);
    const frame = Object.freeze({ capturedAtMs, message });
    this.#frames.set(frame, { tick: this.#tick, revision: message.dataRevision });
    return frame;
  }

  commit(frame: ChartSimFrame, committedRevision: number): void {
    const pending = this.#frames.get(frame);
    this.#frames.delete(frame);
    if (!pending || this.#cancelled || pending.tick !== this.#tick || pending.revision !== committedRevision)
      throw new Error("Stale, cancelled or uncommitted sim frame.");
    this.#tick += 1;
  }

  #message(rows: readonly (readonly ChartValue[])[], revision: number): ChartDataUpdateMessage {
    return Object.freeze({ schema: "deep-engine.chart-data-update", schemaVersion: 1,
      chartId: this.#fixture.chartId, expectedDataRevision: revision, dataRevision: revision + 1,
      datasets: Object.freeze([Object.freeze({ kind: "append-window", datasetId: this.#fixture.datasetId,
        rows, maxRows: this.#fixture.maxRows })]) });
  }
}
