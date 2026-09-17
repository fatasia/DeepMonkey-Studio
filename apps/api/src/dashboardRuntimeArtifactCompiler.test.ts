import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode, type DashboardDocument,
  type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { buildDashboardPublicationCapabilityReport } from "./dashboardPublicationCapability.js";
import { prepareDashboardPublicationFreeze, type DashboardFrozenResourceRequest,
  type DashboardPublicationAuthorityState } from "./dashboardPublicationFreeze.js";
import { dashboardDataRequestId } from "./dashboardDataRequestId.js";
import type { DashboardLayoutCaptureHost } from "./dashboardMeasuredLayout.js";
import {
  acceptDashboardRuntimeArtifactCompilerOutput,
  prepareDashboardRuntimeArtifactCompilerInput,
  type DashboardFreezeRevalidation,
} from "./dashboardRuntimeArtifactCompiler.js";

const authority = { projectId: "project-golden", applicationId: "application-worker-behavior", publicationId: "publication-1", applicationRevision: 1 } as const;
const compiler = { id: "native-dashboard-v5", version: "1.0.0", sha256: "c".repeat(64), configuration: { antialias: "msaa4", runtimeSchema: 5 } } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function state() {
  const value: unknown = structuredClone(source); assertDashboardDocument(value);
  const publication: PublishedApplicationRecord = { id: authority.publicationId, projectId: authority.projectId,
    applicationId: authority.applicationId, applicationRevision: authority.applicationRevision, document: value.application,
    publishedAt: "2026-09-16T12:00:00.000Z" };
  return { activePublicationId: authority.publicationId, currentApplicationRevision: authority.applicationRevision, publication };
}
function font(): DashboardFrozenResourceRequest {
  return { id: "font", kind: "font", objectKey: "projects/project-golden/assets/font.woff2", mime: "font/woff2",
    nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } };
}
function revalidation(): DashboardFreezeRevalidation {
  return { readAuthority: async () => state(), resolveData: async () => ({ sourceRevision: "", value: null }),
    readResource: async () => ({ revision: 2, bytes: new Uint8Array([1, 2, 3]) }) };
}
async function frozen() {
  return prepareDashboardPublicationFreeze({ expected: authority, entryPageId: "page-main", data: [], resources: [font()], ...revalidation() });
}
async function artifact(): Promise<Uint8Array> {
  const sourceBytes = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(sourceBytes);
  if (!parsed.valid || parsed.value.schemaVersion !== 5) throw new Error("Test v5 fixture invalid");
  return new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
}
async function capability(candidate: Awaited<ReturnType<typeof frozen>>, bytes: Uint8Array) {
  return buildDashboardPublicationCapabilityReport({ candidate, expectedDeviceFingerprintSha256: "a".repeat(64), revalidation: revalidation(),
    compiler: { compilerId: compiler.id, compilerVersion: compiler.version, compilerSha256: compiler.sha256, configuration: compiler.configuration,
      compile: async () => ({ artifact: bytes, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] }] }) },
    verifyWindow: async request => ({ verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: candidate.manifest.manifestSha256,
      sourceSemanticHash: request.sourceSemanticHash, compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash,
      fixtureSha256: "b".repeat(64), deviceFingerprintSha256: "a".repeat(64),
      fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"] }),
  });
}

describe("dashboard v5 runtime compiler contract", () => {
  it("snapshots the C3 candidate and accepts exactly the C4-proven canonical v5 bytes", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: revalidation() });
    const accepted = acceptDashboardRuntimeArtifactCompilerOutput(input, { protocol: input.protocol, authority: input.authority,
      freezeManifestSha256: input.freezeManifestSha256, sourceSemanticHash: input.sourceSemanticHash,
      compileGraphHash: input.compileGraphHash, artifact: bytes }, report);
    expect(accepted).toMatchObject({ artifactSha256: report.targetArtifactHash, authority, freezeManifestSha256: candidate.manifest.manifestSha256 });
    expect(accepted.runtimePackage.schemaVersion).toBe(5);
    expect(input.resources.font).not.toBe(candidate.resources.font);
    expect(input.freezeManifest).toEqual(candidate.manifest);
    expect(input.freezeManifest).not.toBe(candidate.manifest);
  });

  it("rejects compiler/capability substitution before work and stale authority during preparation", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report,
      compiler: { ...compiler, sha256: "d".repeat(64) }, revalidation: revalidation() })).rejects.toThrow("capability report");
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: {
      ...revalidation(), readAuthority: async () => ({ ...state(), currentApplicationRevision: 2 }),
    } })).rejects.toThrow("authority changed");
  });

  it("fails closed for changed authority/hash, noncanonical bytes, and non-v5 artifacts", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: revalidation() });
    const output = () => ({ protocol: input.protocol, authority: input.authority, freezeManifestSha256: input.freezeManifestSha256,
      sourceSemanticHash: input.sourceSemanticHash, compileGraphHash: input.compileGraphHash, artifact: bytes });
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), authority: { ...authority, publicationId: "other" } }, report)).toThrow("not bound");
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), artifact: Uint8Array.from([...bytes, 10]) }, report)).toThrow();
    const v4 = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-runtime-v1.json", import.meta.url)));
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), artifact: v4 }, report)).toThrow();
  });
});

describe("G04 measured layout binding into compiler input", () => {
  const fontBytes = new Uint8Array([1, 2, 3]);
  const valueWidget = (id = "widget-value"): DashboardDataWidgetNode => ({ id, kind: "data-widget", zIndex: 3,
    frame: { x: 20, y: 30, width: 234, height: 134 }, widget: { type: "value", title: "有功功率", key: "temperature", unit: "MW" } });
  const documentWith = (nodes: unknown[]): DashboardDocument => {
    const input: unknown = structuredClone(source);
    assertDashboardDocument(input);
    input.application.pages[0]!.nodes = nodes;
    return input;
  };
  const frozenValue = { source: { kind: "sample", id: "sample:widget-value", revision: 1, contentSha256: "a".repeat(64) },
    metric: { value: 42, samples: [{ time: 1, value: 42 }] } };
  const widgetState = (widgets: DashboardDataWidgetNode[]): DashboardPublicationAuthorityState => ({
    activePublicationId: authority.publicationId, currentApplicationRevision: authority.applicationRevision,
    publication: { id: authority.publicationId, projectId: authority.projectId, applicationId: authority.applicationId,
      applicationRevision: authority.applicationRevision, document: documentWith(widgets).application, publishedAt: "2026-09-17T00:00:00.000Z" } });
  const measuredRevalidation = (widgets: DashboardDataWidgetNode[], value: unknown = frozenValue): DashboardFreezeRevalidation => ({
    readAuthority: vi.fn(async () => widgetState(widgets)),
    resolveData: vi.fn(async () => ({ sourceRevision: "sample:1", value: structuredClone(value) })),
    readResource: vi.fn(async () => ({ revision: 3, bytes: fontBytes })) });
  async function frozenWidgets(widgets: DashboardDataWidgetNode[], withData: boolean, value: unknown = structuredClone(frozenValue)) {
    return prepareDashboardPublicationFreeze({ expected: authority, entryPageId: "page-main",
      data: withData ? widgets.map(widget => ({ id: dashboardDataRequestId(widget.id), nodeId: widget.id, sourceRevision: "sample:1" })) : [],
      resources: [{ id: "font-main", kind: "font", objectKey: "projects/project-golden/assets/font-main.woff2",
        mime: "font/woff2", nodeIds: widgets.map(widget => widget.id), revision: 3, faceIndex: 0,
        license: { redistributable: true, evidence: "OFL-1.1:font-main" } }],
      readAuthority: vi.fn(async () => widgetState(widgets)),
      resolveData: vi.fn(async () => ({ sourceRevision: "sample:1", value: structuredClone(value) })),
      readResource: vi.fn(async () => ({ revision: 3, bytes: fontBytes })) });
  }
  async function measuredCapability(candidate: Awaited<ReturnType<typeof frozenWidgets>>, bytes: Uint8Array,
    nodeId: string, widgets: DashboardDataWidgetNode[], value: unknown = frozenValue) {
    return buildDashboardPublicationCapabilityReport({ candidate, expectedDeviceFingerprintSha256: "a".repeat(64),
      revalidation: measuredRevalidation(widgets, value),
      compiler: { compilerId: compiler.id, compilerVersion: compiler.version, compilerSha256: compiler.sha256, configuration: compiler.configuration,
        compile: async () => ({ artifact: bytes, objects: [{ nodeId, contentCompiled: true, deferredFields: [] }] }) },
      verifyWindow: async request => ({ verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: candidate.manifest.manifestSha256,
        sourceSemanticHash: request.sourceSemanticHash, compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash,
        fixtureSha256: "b".repeat(64), deviceFingerprintSha256: "a".repeat(64),
        fontSha256: [{ resourceId: "font-main", sha256: sha(fontBytes), faceIndex: 0 }], renderedNodeIds: [nodeId] }) });
  }
  function trustedHost(layout: Record<string, unknown> = measuredLayoutShape()) {
    return { id: "chromium-trusted-host", version: "1.0.0", executableSha256: "b".repeat(64),
      capture: vi.fn(async () => ({ protocol: "dashboard-measured-layout-v1" as const, layout })) };
  }
  function measuredLayoutShape() {
    return { textBoxes: [{ role: { kind: "value" }, rect: [12, 40, 96, 32], clip: null, fonts: ["font-main"],
        wrap: "none", whiteSpace: "nowrap", verticalAlign: "center",
        style: { fontSize: 32, lineHeight: 40, fontWeight: 600, fontStyle: "normal", align: "left", color: [231, 236, 244, 255] } }],
      paint: [{ kind: "background", index: 0 }, { kind: "text", index: 0 }],
      backgrounds: [{ rect: [0, 0, 234, 134], color: [0.01, 0.02, 0.03, 0.86] }] };
  }

  it("binds server-measured layout into the frozen data consumed by the compiler input", async () => {
    const widget = valueWidget(), candidate = await frozenWidgets([widget], true), host = trustedHost();
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: await measuredCapability(candidate, await artifact(), widget.id, [widget]),
      compiler, revalidation: measuredRevalidation([widget]), layoutCapture: { host, locale: "zh-CN" } });
    const bound = input.data[dashboardDataRequestId(widget.id)] as { layout?: { textBoxes: unknown[] } };
    expect(bound.layout?.textBoxes).toEqual(measuredLayoutShape().textBoxes);
    expect(host.capture).toHaveBeenCalledOnce();
  });

  it("keeps widgets without frozen data or visibility untouched, and rejects host font betrayal", async () => {
    const hidden: DashboardDataWidgetNode = { ...valueWidget("widget-hidden"), visible: false };
    const orphan = valueWidget("widget-orphan");
    const candidate = await frozenWidgets([orphan], false), host = trustedHost();
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: await measuredCapability(candidate, await artifact(), orphan.id, [orphan]),
      compiler, revalidation: measuredRevalidation([orphan]), layoutCapture: { host, locale: "zh-CN" } });
    expect(host.capture).not.toHaveBeenCalled();
    expect(input.data).toEqual({});
    const traitor = trustedHost({ textBoxes: [{ role: { kind: "value" }, rect: [0, 0, 8, 8], clip: null, fonts: ["font-other"],
        wrap: "none", whiteSpace: "nowrap", verticalAlign: "center",
        style: { fontSize: 8, lineHeight: 10, fontWeight: 400, fontStyle: "normal", align: "left", color: [0, 0, 0, 255] } }],
      paint: [], backgrounds: [] });
    const withData = await frozenWidgets([orphan, hidden], true);
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate: withData, capability: await measuredCapability(withData, await artifact(), orphan.id, [orphan, hidden]),
      compiler, revalidation: measuredRevalidation([orphan, hidden]), layoutCapture: { host: traitor, locale: "zh-CN" } }))
      .rejects.toThrow("outside its frozen binding");
  });

  it("refuses to overwrite a layout that arrived through the frozen data itself", async () => {
    const widget = valueWidget();
    const valueWithLayout = { ...structuredClone(frozenValue), layout: { textBoxes: [], backgrounds: [] } };
    const candidate = await frozenWidgets([widget], true, valueWithLayout);
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: await measuredCapability(candidate, await artifact(), widget.id, [widget], valueWithLayout),
      compiler, revalidation: measuredRevalidation([widget], valueWithLayout),
      layoutCapture: { host: trustedHost(), locale: "zh-CN" } })).rejects.toThrow("already carries a layout");
  });
});
