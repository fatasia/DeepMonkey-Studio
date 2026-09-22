import {
  DashboardPublicationStaleError,
  dashboardCanonicalJsonSha256,
  type DashboardPublicationFreezeCandidate,
} from "./dashboardPublicationFreeze.js";
import { dashboardDataRequestId } from "./dashboardDataRequestId.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FRAME = 16_777_216;

/**
 * Wire shape measured by the trusted capture host. It mirrors the web producer's
 * `captureRenderedDashboardData` output; the API never accepts these values from
 * a browser client — only from its own host process.
 */
export interface DashboardMeasuredLayout {
  readonly textBoxes: readonly {
    readonly role: Record<string, unknown>;
    readonly rect: readonly [number, number, number, number];
    readonly clip: readonly [number, number, number, number] | null;
    readonly buttonGroup?: Record<string, unknown>;
    readonly fonts: readonly string[];
    readonly wrap: string;
    readonly whiteSpace: string;
    readonly verticalAlign: string;
    readonly style: { readonly fontSize: number; readonly lineHeight: number; readonly fontWeight: number;
      readonly fontStyle: string; readonly align: string; readonly color: readonly [number, number, number, number] };
  }[];
  readonly paint?: readonly { readonly kind: string; readonly index: number }[];
  readonly backgrounds: readonly { readonly rect: readonly [number, number, number, number];
    readonly color: readonly [number, number, number, number] }[];
}

/** Hosts return only measurements; every identity below is computed server-side from the frozen candidate. */
export interface DashboardMeasuredLayoutRecord {
  readonly protocol: "dashboard-measured-layout-v1";
  readonly nodeId: string;
  readonly dataId: string;
  readonly locale: string;
  readonly logicalSize: readonly [number, number];
  readonly layout: DashboardMeasuredLayout;
  readonly table?: { readonly page: number; readonly scrollLeft: number;
    readonly sort?: { readonly column: string; readonly direction: "asc" | "desc" } };
  readonly layoutSha256: string;
  readonly binds: {
    readonly freezeManifestSha256: string;
    readonly documentSha256: string;
    readonly dataSha256: string;
    readonly fonts: readonly { readonly id: string; readonly sha256: string; readonly faceIndex: number }[];
  };
  readonly host: { readonly id: string; readonly version: string; readonly executableSha256?: string; readonly capturedAt: number };
}

export interface DashboardLayoutCaptureRequest {
  readonly table?: DashboardMeasuredLayoutRecord["table"];
  readonly protocol: "dashboard-measured-layout-v1";
  readonly nodeId: string;
  readonly logicalSize: readonly [number, number];
  readonly widget: Record<string, unknown>;
  readonly data: { readonly source: Record<string, unknown>; readonly metric: Record<string, unknown> };
  readonly fonts: readonly { readonly id: string; readonly faceIndex: number; readonly bytes: Uint8Array }[];
  readonly locale: string;
}

export interface DashboardLayoutCaptureHost {
  readonly id: string;
  readonly version: string;
  readonly executableSha256?: string;
  capture(request: DashboardLayoutCaptureRequest, signal?: AbortSignal): Promise<{
    readonly protocol: "dashboard-measured-layout-v1";
    readonly layout: DashboardMeasuredLayout;
    readonly table?: DashboardMeasuredLayoutRecord["table"];
  }>;
}

export class DashboardLayoutFontMissingError extends Error {
  override readonly name = "DashboardLayoutFontMissingError";
  readonly families: readonly string[];
  constructor(families: readonly string[]) {
    super(`Measured widget references fonts outside its frozen binding: ${families.join(", ")}`);
    this.families = families;
  }
}

export interface CaptureDashboardMeasuredLayoutOptions {
  readonly table?: DashboardMeasuredLayoutRecord["table"];
  readonly candidate: DashboardPublicationFreezeCandidate;
  readonly nodeId: string;
  readonly host: DashboardLayoutCaptureHost;
  readonly locale: string;
  readonly signal?: AbortSignal;
}

/**
 * Render one frozen data widget in the trusted capture host and bind the
 * measurement to the exact freeze manifest, data bytes and font bytes it was
 * rendered with. Repeat captures of an unchanged candidate produce the same
 * layoutSha256; the host cannot forge binds because it only returns measurements.
 */
export async function captureDashboardMeasuredLayout(options: CaptureDashboardMeasuredLayoutOptions): Promise<DashboardMeasuredLayoutRecord> {
  options.signal?.throwIfAborted();
  assertHostIdentity(options.host);
  const node = options.candidate.document.application.pages
    .flatMap(page => page.nodes).find(candidate => candidate.id === options.nodeId);
  if (!node || node.kind !== "data-widget") throw new Error(`Measured layout requires a data-widget node: ${options.nodeId}`);
  if (node.visible === false) throw new Error(`Hidden widget ${options.nodeId} has no measurable layout`);
  if (!["value", "table", "bar", "line", "scatter", "pie"].includes(node.widget.type)) {
    throw new Error(`Widget ${options.nodeId} type ${node.widget.type} has no measured layout contract`);
  }
  const frame = node.frame;
  if (!finiteFrame(frame)) throw new Error(`Widget ${options.nodeId} frame is outside the measurable range`);
  const dataId = dashboardDataRequestId(node.id);
  const frozen = options.candidate.data[dataId] as { source?: unknown; metric?: unknown } | undefined;
  if (!isFrozenDataValue(frozen)) throw new Error(`Frozen data ${dataId} is missing for widget ${options.nodeId}`);
  const fonts = options.candidate.manifest.resources.filter(resource => resource.kind === "font" && resource.nodeIds.includes(node.id));
  if (!fonts.length) throw new Error(`Widget ${options.nodeId} has no frozen font binding to measure with`);
  const request: DashboardLayoutCaptureRequest = {
    ...(options.table ? { table: structuredClone(options.table) } : {}),
    protocol: "dashboard-measured-layout-v1", nodeId: node.id,
    logicalSize: [frame.width, frame.height], widget: structuredClone(node.widget),
    data: { source: structuredClone((frozen as { source: Record<string, unknown> }).source),
      metric: structuredClone((frozen as { metric: Record<string, unknown> }).metric) },
    fonts: fonts.map(font => ({ id: font.id, faceIndex: font.faceIndex ?? 0,
      bytes: Uint8Array.from(options.candidate.resources[font.id]!) })),
    locale: options.locale,
  };
  assertTableState(options.table);
  if (options.table && node.widget.type !== "table") throw new Error("Only table widgets accept a requested view state");
  options.signal?.throwIfAborted();
  const capture = await options.host.capture(request, options.signal);
  // 迟到响应:中止发生在宿主返回之后时,测量结果必须作废而不是进入记录。
  options.signal?.throwIfAborted();
  if (capture.protocol !== "dashboard-measured-layout-v1") throw new Error("Capture host returned an unsupported protocol");
  assertMeasuredLayoutShape(capture.layout);
  const boundIds = new Set(fonts.map(font => font.id));
  const unbound = [...new Set(capture.layout.textBoxes.flatMap(box => box.fonts))].filter(font => !boundIds.has(font));
  if (unbound.length) throw new DashboardLayoutFontMissingError(unbound);
  if (capture.table && node.widget.type !== "table") throw new Error("Only table widgets may capture a table state");
  assertTableState(capture.table);
  const logicalSize: readonly [number, number] = [frame.width, frame.height];
  const layoutSha256 = dashboardCanonicalJsonSha256({ logicalSize, layout: capture.layout, ...(capture.table ? { table: capture.table } : {}) });
  const dataManifest = options.candidate.manifest.data.find(item => item.id === dataId);
  if (!dataManifest) throw new Error(`Frozen data manifest entry ${dataId} is missing for widget ${options.nodeId}`);
  return Object.freeze({
    protocol: "dashboard-measured-layout-v1", nodeId: node.id, dataId, locale: options.locale,
    logicalSize, layout: structuredClone(capture.layout), ...(capture.table ? { table: structuredClone(capture.table) } : {}),
    layoutSha256,
    binds: {
      freezeManifestSha256: options.candidate.manifest.manifestSha256,
      documentSha256: options.candidate.manifest.documentSha256,
      dataSha256: dataManifest.sha256,
      fonts: fonts.map(font => ({ id: font.id, sha256: font.sha256, faceIndex: font.faceIndex ?? 0 })).sort(byId),
    },
    host: { id: options.host.id, version: options.host.version, ...(options.host.executableSha256 ? { executableSha256: options.host.executableSha256 } : {}), capturedAt: Date.now() },
  });
}

/**
 * Re-verify a measurement against the current candidate at any later boundary
 * (compile input assembly, capability report, download). Returns the measured
 * view so the compiler can compose `DashboardFrozenData` from it.
 */
export function verifyDashboardMeasuredLayout(record: DashboardMeasuredLayoutRecord,
  candidate: DashboardPublicationFreezeCandidate): { readonly layout: DashboardMeasuredLayout; readonly table?: DashboardMeasuredLayoutRecord["table"] } {
  if (record.protocol !== "dashboard-measured-layout-v1") throw new Error("Measured layout record has an unsupported protocol");
  assertHostIdentity(record.host);
  if (record.dataId !== dashboardDataRequestId(record.nodeId)) throw new Error("Measured layout data id does not derive from its node");
  assertMeasuredLayoutShape(record.layout);
  assertTableState(record.table);
  const hashed = dashboardCanonicalJsonSha256({ logicalSize: record.logicalSize, layout: record.layout,
    ...(record.table ? { table: record.table } : {}) });
  if (hashed !== record.layoutSha256) throw new Error("Measured dashboard layout was modified");
  const binds = record.binds;
  if (binds.freezeManifestSha256 !== candidate.manifest.manifestSha256 || binds.documentSha256 !== candidate.manifest.documentSha256) {
    throw new DashboardPublicationStaleError("Measured layout binds a different freeze manifest");
  }
  const dataId = dashboardDataRequestId(record.nodeId);
  const currentData = candidate.data[dataId] as { source?: unknown; metric?: unknown } | undefined;
  if (!isFrozenDataValue(currentData)) throw new DashboardPublicationStaleError(`Frozen data ${dataId} for the measured widget is gone`);
  if (dashboardCanonicalJsonSha256(currentData) !== binds.dataSha256) {
    throw new DashboardPublicationStaleError("Frozen data changed after the layout was measured");
  }
  const currentFonts = candidate.manifest.resources
    .filter(resource => resource.kind === "font" && resource.nodeIds.includes(record.nodeId))
    .map(font => ({ id: font.id, sha256: font.sha256, faceIndex: font.faceIndex ?? 0 })).sort(byId);
  if (JSON.stringify(currentFonts) !== JSON.stringify([...binds.fonts].sort(byId))) {
    throw new DashboardPublicationStaleError("Font bytes changed after the layout was measured");
  }
  return { layout: structuredClone(record.layout), ...(record.table ? { table: structuredClone(record.table) } : {}) };
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function assertHostIdentity(host: { readonly id: string; readonly version: string; readonly executableSha256?: string }): void {
  if (!host.id.trim() || !host.version.trim()
    || host.executableSha256 !== undefined && !SHA256.test(host.executableSha256)) {
    throw new Error("Dashboard layout capture host identity is invalid");
  }
}

function finiteFrame(frame: { readonly width: number; readonly height: number }): boolean {
  return [frame.width, frame.height].every(value => Number.isFinite(value) && value > 0 && value <= MAX_FRAME);
}

function isFrozenDataValue(value: unknown): value is { source: Record<string, unknown>; metric: Record<string, unknown> } {
  const source = (value as { source?: unknown })?.source, metric = (value as { metric?: unknown })?.metric;
  return Boolean(value) && typeof value === "object" && Boolean(source) && typeof source === "object"
    && Boolean(metric) && typeof metric === "object";
}

function assertTableState(table: DashboardMeasuredLayoutRecord["table"]): void {
  if (!table) return;
  if (!Number.isSafeInteger(table.page) || table.page < 0 || !Number.isFinite(table.scrollLeft) || table.scrollLeft < 0
    || Boolean(table.sort) !== Boolean(table.sort?.direction)
    || table.sort && (!table.sort.column || table.sort.direction !== "asc" && table.sort.direction !== "desc")) {
    throw new Error("Measured table state is invalid");
  }
}

const ROLES = new Set(["title", "value", "unit", "footer", "previous", "next", "row-number-header", "header", "sort", "total", "cell", "row-number", "tool", "empty"]);
const PLAIN_ROLES = new Set(["title", "value", "unit", "footer", "previous", "next", "row-number-header", "empty"]);
const TOOLS = new Set(["csv", "excel"]);
const COLUMN_ROLES = new Set(["header", "sort", "total"]);
const WRAPS = new Set(["none", "word", "glyph", "word-or-glyph"]);
const WHITE_SPACES = new Set(["normal", "nowrap", "pre", "pre-wrap"]);
const ALIGNMENTS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNMENTS = new Set(["top", "center", "bottom"]);
const FONT_STYLES = new Set(["normal", "italic", "oblique"]);
const PAINT_KINDS = new Set(["background", "text"]);

/** Fail closed on any value the canonical JSON hash or the Native painter could not reproduce. */
function assertMeasuredLayoutShape(layout: DashboardMeasuredLayout): void {
  if (!Array.isArray(layout.textBoxes) || !Array.isArray(layout.backgrounds)) throw new Error("Measured layout is missing its boxes or backgrounds");
  if (layout.paint !== undefined && !Array.isArray(layout.paint)) throw new Error("Measured layout paint order is invalid");
  const paintLength = layout.textBoxes.length + layout.backgrounds.length;
  for (const entry of layout.paint ?? []) {
    if (typeof entry.kind !== "string" || !PAINT_KINDS.has(entry.kind) || !Number.isSafeInteger(entry.index)
      || entry.index < 0 || entry.index >= (entry.kind === "text" ? layout.textBoxes.length : layout.backgrounds.length)) {
      throw new Error("Measured layout paint entry is out of range");
    }
  }
  layout.textBoxes.forEach((box, index) => {
    const role = box.role as { kind?: unknown; row?: unknown; column?: unknown; tool?: unknown };
    if (typeof role.kind !== "string" || !ROLES.has(role.kind)) throw new Error(`Measured text box ${index} has an unknown role`);
    if (role.kind === "tool" && !TOOLS.has(role.tool as string)) throw new Error(`Measured text box ${index} has an unknown export tool`);
    if ((PLAIN_ROLES.has(role.kind) || role.kind === "tool") && (role.row !== undefined || role.column !== undefined))
      throw new Error(`Measured text box ${index} carries unexpected role fields`);
    if (COLUMN_ROLES.has(role.kind) && (typeof role.column !== "string" || !role.column)) throw new Error(`Measured text box ${index} is missing its column`);
    if ((role.kind === "cell" || role.kind === "row-number") && (!Number.isSafeInteger(role.row) || (role.row as number) < 0)) {
      throw new Error(`Measured text box ${index} has an invalid row`);
    }
    assertRect(box.rect, `text box ${index} rect`);
    if (box.clip !== null) assertRect(box.clip, `text box ${index} clip`);
    const boxFonts: unknown = box.fonts;
    if (!Array.isArray(boxFonts) || !boxFonts.length
      || boxFonts.some((font: unknown) => typeof font !== "string" || !font.trim())
      || new Set(boxFonts as string[]).size !== boxFonts.length) {
      throw new Error(`Measured text box ${index} has no unique frozen font binding`);
    }
    if (!WRAPS.has(box.wrap) || !WHITE_SPACES.has(box.whiteSpace) || !VERTICAL_ALIGNMENTS.has(box.verticalAlign)
      || !ALIGNMENTS.has(box.style?.align) || !FONT_STYLES.has(box.style?.fontStyle)) {
      throw new Error(`Measured text box ${index} has an unsupported style enum: wrap=${String(box.wrap)} whiteSpace=${String(box.whiteSpace)}`
        + ` verticalAlign=${String(box.verticalAlign)} align=${String(box.style?.align)} fontStyle=${String(box.style?.fontStyle)}`);
    }
    const style = box.style;
    if (![style.fontSize, style.lineHeight].every(value => Number.isFinite(value) && value > 0)
      || !Number.isInteger(style.fontWeight) || style.fontWeight < 1 || style.fontWeight > 1000
      || !finiteQuad(style.color)) throw new Error(`Measured text box ${index} has invalid text metrics`);
    if (box.buttonGroup !== undefined) {
      const group = box.buttonGroup as Record<string, unknown>;
      assertRect(group.rect as unknown as readonly [number, number, number, number], `text box ${index} button group`);
      if (typeof group.radius !== "number" || typeof group.borderWidth !== "number" || typeof group.opacity !== "number"
        || [group.radius, group.borderWidth, group.opacity].some(value => !Number.isFinite(value) || value < 0)
        || !finiteQuad(group.background as readonly [number, number, number, number])
        || !finiteQuad(group.border as readonly [number, number, number, number])) {
        throw new Error(`Measured text box ${index} button group is invalid`);
      }
    }
  });
  layout.backgrounds.forEach((background, index) => {
    assertRect(background.rect, `background ${index} rect`);
    if (!finiteQuad(background.color)) throw new Error(`Background ${index} color is invalid`);
  });
}

function assertRect(rect: unknown, label: string): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error(`Measured ${label} is invalid`);
  }
}

function finiteQuad(color: unknown): boolean {
  return Array.isArray(color) && color.length === 4 && color.every(value => Number.isFinite(value));
}
