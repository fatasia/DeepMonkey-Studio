import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode, type DashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { prepareDashboardPublicationFreeze, DashboardPublicationStaleError,
  type DashboardPublicationAuthorityState, type DashboardPublicationFreezeCandidate,
  type DashboardFrozenResourceRequest, type PrepareDashboardPublicationFreezeOptions } from "./dashboardPublicationFreeze.js";
import { dashboardDataRequestId } from "./dashboardPublishedClosure.js";
import { captureDashboardMeasuredLayout, DashboardLayoutFontMissingError, verifyDashboardMeasuredLayout,
  type DashboardLayoutCaptureHost, type DashboardMeasuredLayout, type DashboardMeasuredLayoutRecord } from "./dashboardMeasuredLayout.js";

const expected = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1 } as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const FONT_BYTES = new Uint8Array([1, 2, 3]);

function valueWidget(overrides: Partial<DashboardDataWidgetNode> = {}): DashboardDataWidgetNode {
  return { id: "widget-value", kind: "data-widget", zIndex: 3, frame: { x: 20, y: 30, width: 234, height: 134 },
    widget: { type: "value", title: "有功功率", key: "temperature", unit: "MW" }, ...overrides };
}

function documentWith(nodes: unknown[]): DashboardDocument {
  const input: unknown = structuredClone(source);
  assertDashboardDocument(input);
  const document: DashboardDocument = input;
  document.application.scripts = [];
  document.application.pages[0]!.nodes = nodes as DashboardDocument["application"]["pages"][number]["nodes"];
  return document;
}

function fixtureSceneNode(): DashboardDataWidgetNode {
  const original: unknown = structuredClone(source);
  assertDashboardDocument(original);
  return structuredClone((original as DashboardDocument).application.pages[0]!.nodes[0]!);
}

function publication(widget: DashboardDataWidgetNode): PublishedApplicationRecord {
  return { id: expected.publicationId, projectId: expected.projectId, applicationId: expected.applicationId,
    applicationRevision: expected.applicationRevision, document: documentWith([widget]).application,
    publishedAt: "2026-09-16T12:00:00.000Z" };
}

function authority(widget: DashboardDataWidgetNode): DashboardPublicationAuthorityState {
  return { activePublicationId: expected.publicationId, currentApplicationRevision: expected.applicationRevision,
    publication: publication(widget) };
}

const fontResource = (nodeId = "widget-value"): DashboardFrozenResourceRequest => ({ id: "font-main", kind: "font",
  objectKey: `projects/project-golden/assets/font-main.woff2`, mime: "font/woff2",
  nodeIds: [nodeId], revision: 3, faceIndex: 0,
  license: { redistributable: true, evidence: "OFL-1.1:font-main" } });

function freezeOptions(widget: DashboardDataWidgetNode,
  overrides: Partial<PrepareDashboardPublicationFreezeOptions> = {}): PrepareDashboardPublicationFreezeOptions {
  const metric = { value: 42, samples: [{ time: 1, value: 42 }] };
  return { expected, entryPageId: "page-main",
    data: [{ id: dashboardDataRequestId(widget.id), nodeId: widget.id, sourceRevision: "sample:1" }],
    resources: [fontResource(widget.id)], readAuthority: vi.fn(async () => authority(widget)),
    resolveData: vi.fn(async () => ({ sourceRevision: "sample:1", value: {
      source: { kind: "sample", id: `sample:${widget.id}`, revision: 1, contentSha256: "a".repeat(64) }, metric } })),
    readResource: vi.fn(async () => ({ revision: 3, bytes: FONT_BYTES })),
    ...overrides };
}

async function candidate(widget: DashboardDataWidgetNode = valueWidget(),
  overrides: Partial<PrepareDashboardPublicationFreezeOptions> = {}): Promise<DashboardPublicationFreezeCandidate> {
  return prepareDashboardPublicationFreeze(freezeOptions(widget, overrides));
}

function measuredLayout(): DashboardMeasuredLayout {
  return {
    textBoxes: [{ role: { kind: "value" }, rect: [12, 40, 96, 32], clip: null, fonts: ["font-main"],
      wrap: "none", whiteSpace: "nowrap", verticalAlign: "center",
      style: { fontSize: 32, lineHeight: 40, fontWeight: 600, fontStyle: "normal", align: "left", color: [231, 236, 244, 255] } }],
    paint: [{ kind: "background", index: 0 }, { kind: "text", index: 0 }],
    backgrounds: [{ rect: [0, 0, 234, 134], color: [0.01, 0.02, 0.03, 0.86] }],
  };
}

function captureOf(layout: DashboardMeasuredLayout, table?: DashboardMeasuredLayoutRecord["table"]) {
  return { protocol: "dashboard-measured-layout-v1" as const, layout, ...(table ? { table } : {}) };
}

function host(overrides: Partial<DashboardLayoutCaptureHost> = {}): DashboardLayoutCaptureHost {
  return { id: "chromium-trusted-host", version: "1.0.0", executableSha256: "b".repeat(64),
    capture: vi.fn(async () => captureOf(measuredLayout())), ...overrides };
}

interface CaptureOptions { candidate: DashboardPublicationFreezeCandidate; nodeId: string;
  host: DashboardLayoutCaptureHost; locale: string; signal?: AbortSignal }
function captureOptions(overrides: Partial<CaptureOptions>): CaptureOptions {
  return { nodeId: "widget-value", host: host(), locale: "zh-CN", ...overrides } as CaptureOptions;
}

describe("dashboard measured layout", () => {
  it("derives the shared frozen data request id used by the production closure", () => {
    expect(dashboardDataRequestId("widget-value")).toBe(`data.${createHash("sha256").update("widget-value").digest("hex")}`);
  });

  it("binds the measurement to the freeze manifest, data bytes and font bytes", async () => {
    const frozen = await candidate();
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen }));
    expect(record.nodeId).toBe("widget-value");
    expect(record.dataId).toBe(dashboardDataRequestId("widget-value"));
    expect(record.logicalSize).toEqual([234, 134]);
    expect(record.binds.documentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.binds.fonts).toEqual([{ id: "font-main", sha256: hash(FONT_BYTES), faceIndex: 0 }]);
    expect(record.host.capturedAt).toBeGreaterThan(0);
    expect(record.layoutSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyDashboardMeasuredLayout(record, frozen)).not.toThrow();
  });

  it("rebinds against a mutated candidate so font byte changes invalidate the measurement", async () => {
    const frozen = await candidate();
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen }));
    // 现实路径:字体字节替换产生新 freeze manifest,伞检查即判 stale。
    const rotated = await candidate(valueWidget(), { readResource: vi.fn(async () => ({ revision: 3, bytes: new Uint8Array([9, 9, 9]) })) });
    expect(() => verifyDashboardMeasuredLayout(record, rotated)).toThrow(DashboardPublicationStaleError);
    expect(() => verifyDashboardMeasuredLayout(record, rotated)).toThrow(/different freeze manifest/);
    // 深检查路径:manifest 与资源同被替换但 manifestSha256 未同步(部署侧篡改),必须报字体 hash 而非伞检查。
    const swapped = structuredClone(frozen);
    swapped.resources["font-main"] = new Uint8Array([9, 9, 9]);
    (swapped.manifest.resources[0] as { sha256: string }).sha256 = hash(new Uint8Array([9, 9, 9]));
    expect(() => verifyDashboardMeasuredLayout(record, swapped)).toThrow(/Font bytes changed/);
  });

  it("rejects stale measurements when the frozen data or manifest changed after capture", async () => {
    const frozen = await candidate();
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen }));
    const dataId = dashboardDataRequestId("widget-value");
    // 现实路径:数据变化产生新 manifest。
    const dataChanged = await candidate(valueWidget(), { resolveData: vi.fn(async () => ({ sourceRevision: "sample:1", value: {
      source: { kind: "sample", id: "sample:widget-value", revision: 1, contentSha256: "a".repeat(64) },
      metric: { value: 91, samples: [] } } })) });
    expect(() => verifyDashboardMeasuredLayout(record, dataChanged)).toThrow(DashboardPublicationStaleError);
    // 深检查路径:数据与 manifest 条目同步改写但 manifestSha256 未同步。
    const drifted = structuredClone(frozen);
    ((drifted.data[dataId] as { metric: { value: number } }).metric).value = 91;
    const { dashboardCanonicalJsonSha256 } = await import("./dashboardPublicationFreeze.js");
    (drifted.manifest.data[0] as { sha256: string }).sha256 = dashboardCanonicalJsonSha256(drifted.data[dataId]);
    expect(() => verifyDashboardMeasuredLayout(record, drifted)).toThrow(/Frozen data changed/);
    const current = await candidate();
    const manifestChanged = structuredClone(current);
    (manifestChanged.manifest as { documentSha256: string }).documentSha256 = "c".repeat(64);
    expect(() => verifyDashboardMeasuredLayout(record, manifestChanged)).toThrow(/different freeze manifest/);
  });

  it("detects a tampered layout or binds through the canonical hash", async () => {
    const frozen = await candidate();
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen }));
    const tamperedLayout = structuredClone(record);
    (tamperedLayout.layout.textBoxes[0]!.rect as unknown as number[])[2] += 1;
    expect(() => verifyDashboardMeasuredLayout(tamperedLayout, frozen)).toThrow(/layout was modified/);
    const tamperedBinds = structuredClone(record);
    (tamperedBinds.binds as { dataSha256: string }).dataSha256 = "d".repeat(64);
    expect(() => verifyDashboardMeasuredLayout(tamperedBinds, frozen)).toThrow(/Frozen data changed/);
  });

  it("produces the same layout hash for repeated captures of an unchanged candidate", async () => {
    const frozen = await candidate(), trusted = host();
    const first = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: trusted }));
    const second = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: trusted }));
    expect(second.layoutSha256).toBe(first.layoutSha256);
    expect(second.binds).toEqual(first.binds);
    expect(trusted.capture).toHaveBeenCalledTimes(2);
  });

  it("refuses to start when the signal is already aborted", async () => {
    const frozen = await candidate(), trusted = host();
    const controller = new AbortController();
    controller.abort();
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: trusted, signal: controller.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(trusted.capture).not.toHaveBeenCalled();
  });

  it("discards a late capture response that settles after cancellation", async () => {
    const frozen = await candidate();
    const controller = new AbortController();
    let resolve!: (value: { protocol: "dashboard-measured-layout-v1"; layout: DashboardMeasuredLayout }) => void;
    const trusted = host({ capture: vi.fn(() => new Promise(resolvePromise => { resolve = resolvePromise; })) });
    const pending = captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: trusted, signal: controller.signal }));
    controller.abort();
    resolve(captureOf(measuredLayout()));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates the host font-missing failure and rejects unbound font references", async () => {
    const frozen = await candidate();
    const failing = host({ capture: vi.fn(async () => { throw new DashboardLayoutFontMissingError(["Source Han Sans"]); }) });
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: failing })))
      .rejects.toThrow(/Source Han Sans/);
    const unboundLayout = measuredLayout();
    (unboundLayout.textBoxes[0] as { fonts: string[] }).fonts = ["fallback-family"];
    const unbound = host({ capture: vi.fn(async () => captureOf(unboundLayout)) });
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: unbound })))
      .rejects.toThrow(DashboardLayoutFontMissingError);
  });

  it("rejects widgets without a measured layout contract, hidden widgets and nodes without fonts", async () => {
    const frozenScene = await candidate(fixtureSceneNode());
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozenScene, nodeId: "widget-scene-main" })))
      .rejects.toThrow(/requires a data-widget node/);
    const hidden = await candidate(valueWidget({ visible: false }));
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: hidden })))
      .rejects.toThrow(/no measurable layout/);
    const noFonts = await candidate(valueWidget(), { resources: [], readResource: vi.fn(async () => ({ revision: 3, bytes: FONT_BYTES })) });
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: noFonts })))
      .rejects.toThrow(/no frozen font binding/);
  });

  it("fails closed on non-finite or structurally invalid measurements", async () => {
    const frozen = await candidate();
    const nonFinite = measuredLayout();
    (nonFinite.textBoxes[0] as { rect: number[] }).rect = [Number.NaN, 0, 10, 10];
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
      host: host({ capture: vi.fn(async () => captureOf(nonFinite)) }) }))).rejects.toThrow(/rect is invalid/);
    const unknownRole = measuredLayout();
    (unknownRole.textBoxes[0] as { role: unknown }).role = { kind: "mystery" };
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
      host: host({ capture: vi.fn(async () => captureOf(unknownRole)) }) }))).rejects.toThrow(/unknown role/);
  });

  it("binds a captured table state and rejects one on a value widget", async () => {
    const tableWidget = valueWidget({ id: "widget-table",
      widget: { type: "table", title: "机组表", key: "rows", unit: "MW" } });
    const frozen = await candidate(tableWidget);
    const table = { page: 1, scrollLeft: 24, sort: { column: "count", direction: "asc" as const } };
    const withTable = host({ capture: vi.fn(async () => captureOf(measuredLayout(), table)) });
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen, host: withTable, nodeId: "widget-table" }));
    expect(record.table).toEqual({ page: 1, scrollLeft: 24, sort: { column: "count", direction: "asc" } });
    expect(() => verifyDashboardMeasuredLayout(record, frozen)).not.toThrow();
    const valueFrozen = await candidate();
    const valueHost = host({ capture: vi.fn(async () => captureOf(measuredLayout(), { page: 0, scrollLeft: 0 })) });
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: valueFrozen, host: valueHost })))
      .rejects.toThrow(/Only table widgets/);
  });

  it("accepts the tool export-button role and fails closed on unknown tools or stray fields", async () => {
    const frozen = await candidate();
    const toolLayout = measuredLayout();
    (toolLayout.textBoxes[0] as { role: unknown }).role = { kind: "tool", tool: "csv" };
    const record = await captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
      host: host({ capture: vi.fn(async () => captureOf(toolLayout)) }) }));
    expect(record.layout.textBoxes[0]!.role).toEqual({ kind: "tool", tool: "csv" });
    expect(() => verifyDashboardMeasuredLayout(record, frozen)).not.toThrow();
    for (const role of [{ kind: "tool", tool: "pdf" }, { kind: "tool", tool: "excel", column: "x" }]) {
      const invalid = measuredLayout();
      (invalid.textBoxes[0] as { role: unknown }).role = role;
      await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
        host: host({ capture: vi.fn(async () => captureOf(invalid)) }) }))).rejects.toThrow(/export tool|unexpected role fields/);
    }
  });

  it("rejects capture hosts with invalid deployment identity", async () => {
    const frozen = await candidate();
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
      host: host({ executableSha256: "not-a-hash" }) }))).rejects.toThrow(/host identity/);
    await expect(captureDashboardMeasuredLayout(captureOptions({ candidate: frozen,
      host: host({ version: "" }) }))).rejects.toThrow(/host identity/);
  });
});
