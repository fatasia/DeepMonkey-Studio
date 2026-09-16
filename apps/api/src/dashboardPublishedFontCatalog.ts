import { createHash } from "node:crypto";
import type { PublishedApplicationRecord } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";
import type { DashboardFrozenResourceRequest } from "./dashboardPublicationFreeze.js";
import { readDashboardTrustedObject } from "./dashboardNativeCandidateRuntime.js";

export interface DashboardPublishedFontConfiguration {
  readonly projectId: string;
  readonly applicationId: string;
  readonly applicationRevision: number;
  readonly fonts: readonly { readonly id: string; readonly objectKey: string; readonly mime: string;
    readonly revision: number; readonly sha256: string; readonly faceIndex: number;
    readonly license: { readonly redistributable: boolean; readonly evidence: string } }[];
  readonly nodes: readonly { readonly nodeId: string; readonly fonts: readonly string[];
    readonly textStyle: { readonly fontSize: number; readonly fontWeight: number;
      readonly fontStyle: "normal" | "italic" | "oblique"; readonly lineHeight: number;
      readonly color: readonly [number, number, number, number]; readonly align: "left" | "center" | "right" } }[];
}

export interface DashboardPublishedFontCatalog {
  /** Include this value in the compiler configuration so C4 binds inherited styles and font order. */
  readonly compilerNodeAssets: Readonly<Record<string, { readonly fonts: readonly string[];
    readonly textStyle: DashboardPublishedFontConfiguration["nodes"][number]["textStyle"] }>>;
  derive(publication: PublishedApplicationRecord, signal?: AbortSignal): Promise<readonly DashboardFrozenResourceRequest[]>;
  resourceRevision(publication: PublishedApplicationRecord, request: DashboardFrozenResourceRequest, signal?: AbortSignal): Promise<number>;
}

/** Explicit server deployment catalog. It never discovers local system fonts or invents license grants. */
export function createDashboardPublishedFontCatalog(configuration: DashboardPublishedFontConfiguration,
  objects: Pick<ObjectStore, "read">): DashboardPublishedFontCatalog {
  const catalog = structuredClone(configuration);
  validateCatalog(catalog);
  function requests(publication: PublishedApplicationRecord): DashboardFrozenResourceRequest[] {
    if (publication.projectId !== catalog.projectId || publication.applicationId !== catalog.applicationId
      || publication.applicationRevision !== catalog.applicationRevision) throw new Error("Font catalog does not match the published application revision");
    const nodes = publication.document.pages.flatMap(page => page.nodes);
    for (const binding of catalog.nodes) {
      const node = nodes.find(node => node.id === binding.nodeId);
      if (!node || node.kind !== "data-widget") throw new Error(`Unknown font catalog consumer: ${binding.nodeId}`);
    }
    return catalog.fonts.map(font => ({ id: font.id, kind: "font", objectKey: font.objectKey,
      mime: font.mime, revision: font.revision, expectedSha256: font.sha256, faceIndex: font.faceIndex,
      license: { ...font.license }, nodeIds: catalog.nodes.filter(node => node.fonts.includes(font.id)).map(node => node.nodeId) }));
  }
  async function verify(request: DashboardFrozenResourceRequest, signal?: AbortSignal) {
    const bytes = await readDashboardTrustedObject(objects, request.objectKey, signal);
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== request.expectedSha256)
      throw new Error(`Published font bytes differ from deployment catalog: ${request.id}`);
  }
  return {
    get compilerNodeAssets() {
      return Object.fromEntries(catalog.nodes.map(node => [node.nodeId, { fonts: [...node.fonts], textStyle: structuredClone(node.textStyle) }]));
    },
    async derive(publication, signal) {
      signal?.throwIfAborted();
      const result = requests(publication);
      for (const request of result) await verify(request, signal);
      return result;
    },
    async resourceRevision(publication, request, signal) {
      signal?.throwIfAborted();
      const current = requests(publication).find(font => font.id === request.id);
      if (!current || current.objectKey !== request.objectKey || current.mime !== request.mime || request.kind !== "font"
        || current.faceIndex !== request.faceIndex || current.license?.evidence !== request.license?.evidence
        || current.license?.redistributable !== request.license?.redistributable
        || [...current.nodeIds].sort().join("\0") !== [...request.nodeIds].sort().join("\0"))
        throw new Error("Font request differs from the deployed publication binding");
      await verify(current, signal);
      return current.revision;
    },
  };
}

function validateCatalog(catalog: DashboardPublishedFontConfiguration) {
  const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
  if (!id(catalog.projectId) || !id(catalog.applicationId) || !Number.isSafeInteger(catalog.applicationRevision)
    || catalog.applicationRevision < 1 || !catalog.fonts.length || !catalog.nodes.length) throw new Error("Invalid published font catalog identity");
  const fonts = new Set<string>(), nodes = new Set<string>();
  for (const font of catalog.fonts) {
    if (!id(font.id) || fonts.has(font.id) || !/^font\//.test(font.mime) || !/^[a-f0-9]{64}$/.test(font.sha256)
      || !Number.isSafeInteger(font.revision) || font.revision < 1 || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0
      || font.license?.redistributable !== true || !font.license.evidence.trim()) throw new Error("Font identity, face or redistribution evidence is missing");
    if (!font.objectKey.startsWith(`projects/${catalog.projectId}/`) || /[?%#\\\u0000-\u001f]/.test(font.objectKey)
      || font.objectKey.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Font object key is outside its project");
    fonts.add(font.id);
  }
  for (const node of catalog.nodes) {
    if (!id(node.nodeId) || nodes.has(node.nodeId) || !node.fonts.length || new Set(node.fonts).size !== node.fonts.length
      || node.fonts.some(font => !fonts.has(font))) throw new Error("Invalid published font node/order");
    nodes.add(node.nodeId);
    const style = node.textStyle;
    if (!style || !Number.isFinite(style.fontSize) || style.fontSize <= 0 || !Number.isFinite(style.lineHeight) || style.lineHeight <= 0
      || !Number.isInteger(style.fontWeight) || style.fontWeight < 1 || style.fontWeight > 1000
      || !["normal", "italic", "oblique"].includes(style.fontStyle) || !["left", "center", "right"].includes(style.align)
      || style.color.length !== 4 || !style.color.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
      throw new Error("Explicit inherited text style is required");
  }
  if (catalog.fonts.some(font => !catalog.nodes.some(node => node.fonts.includes(font.id)))) throw new Error("Unbound deployed font");
}
