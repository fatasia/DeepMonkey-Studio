import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import {
  createDashboardPublicationAuthorityAdapter,
  type DashboardPublicationTrustedInputs,
} from "./dashboardPublicationAuthorityAdapter.js";
import {
  createDashboardNativeCandidateService,
  DashboardNativeCandidateSupersededError,
} from "./dashboardNativeCandidateService.js";
import { dashboardDataRequestId } from "./dashboardDataRequestId.js";
import { dashboardCanonicalJsonSha256 } from "./dashboardPublicationFreeze.js";
import type { DashboardLayoutCaptureHost, DashboardLayoutCaptureRequest } from "./dashboardMeasuredLayout.js";
import { createDashboardChromiumLayoutHost, type DashboardChromiumLayoutHost } from "./dashboardLayoutCaptureHost.js";

const request = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1, entryPageId: "page-main" } as const;
const compilerIdentity = { id: "native-dashboard-v5", version: "1.0.0", sha256: "c".repeat(64),
  configuration: { antialias: "msaa4", runtimeSchema: 5 } } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function publication(widgetId: string): PublishedApplicationRecord {
  const value: unknown = structuredClone(source); assertDashboardDocument(value);
  if (widgetId === "widget-value") {
    // 与 dashboardLayoutCaptureHost.test.ts 真实用例同款测量组件:value 数据组件 + 冻结字体绑定。
    const typed = value as DashboardDocument;
    typed.application.scripts = [];
    typed.application.pages[0]!.nodes = [{ id: "widget-value", kind: "data-widget", zIndex: 3,
      frame: { x: 20, y: 30, width: 320, height: 120 },
      widget: { type: "value", title: "有功功率", key: "temperature", unit: "MW", source: "sample", color: "#ffffff" } }] as never;
  }
  return { id: request.publicationId, projectId: request.projectId, applicationId: request.applicationId,
    applicationRevision: request.applicationRevision, document: value.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

async function artifact(): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(bytes);
  if (!parsed.valid) throw new Error("Test package fixture invalid");
  return new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
}

const metric = { value: 42, samples: [{ time: 1, value: 42 }] };
/** 与宿主层测试同源的确定性测量值;fonts 必须引用冻结资源 id,verify 层会做绑定检查。 */
const measuredWidgetLayout = { textBoxes: [{ role: { kind: "value" }, rect: [12, 40, 96, 32], clip: null, fonts: ["font"],
  wrap: "none", whiteSpace: "nowrap", verticalAlign: "center",
  style: { fontSize: 32, lineHeight: 40, fontWeight: 600, fontStyle: "normal", align: "left", color: [231, 236, 244, 255] } }],
  backgrounds: [{ rect: [0, 0, 320, 120], color: [0, 0, 0, 0.8] }] };

function stubLayoutCapture(overrides: { readonly fail?: Error } = {}): {
  host: DashboardLayoutCaptureHost; requests: DashboardLayoutCaptureRequest[];
} {
  const requests: DashboardLayoutCaptureRequest[] = [];
  return {
    host: {
      id: "stub-layout-host", version: "0.0.0-stub",
      capture: async (request, signal) => {
        signal?.throwIfAborted();
        requests.push(structuredClone(request));
        if (overrides.fail) throw overrides.fail;
        return { protocol: "dashboard-measured-layout-v1", layout: structuredClone(measuredWidgetLayout) };
      },
    },
    requests,
  };
}

async function fixture(options: { readonly changeAfterWorker?: boolean; readonly deferWorker?: boolean;
  readonly checkWorkerSignal?: boolean; readonly measuredWidget?: boolean;
  readonly layoutCapture?: { readonly host: DashboardLayoutCaptureHost; readonly locale: string };
  readonly fontBytes?: Uint8Array } = {}) {
  const widgetId = options.measuredWidget ? "widget-value" : "widget-scene-main";
  let active = publication(widgetId), revision = 1;
  const bytes = await artifact();
  const store = {
    getProject: vi.fn(() => ({ id: request.projectId })),
    getApplication: vi.fn(() => ({ ...active.document, metadata: { ...active.document.metadata, revision } })),
    getApplicationPublicationPointer: vi.fn(() => ({ projectId: request.projectId, activePublicationId: active.id })),
    getPublishedApplication: vi.fn(() => structuredClone(active)),
  };
  const trustedInputs: DashboardPublicationTrustedInputs = {
    derive: vi.fn(async () => ({ data: options.measuredWidget
      ? [{ id: dashboardDataRequestId("widget-value"), nodeId: "widget-value", sourceRevision: "sample:e2e" }] : [],
      resources: [{ id: "font", kind: "font", objectKey: "projects/project-golden/assets/font.woff2",
        mime: "font/woff2", nodeIds: [widgetId], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } }] })),
    resolveData: vi.fn(async () => options.measuredWidget
      ? { sourceRevision: "sample:e2e", value: { source: { kind: "sample", id: "sample:widget-value", revision: 1,
        contentSha256: dashboardCanonicalJsonSha256(metric) }, metric } }
      : { sourceRevision: "", value: null }),
    readResource: vi.fn(async () => ({ revision: 2, bytes: options.fontBytes ? Uint8Array.from(options.fontBytes) : new Uint8Array([1, 2, 3]) })),
  };
  const authority = createDashboardPublicationAuthorityAdapter({ store, trustedInputs });
  let releaseWorker: (() => void) | undefined, workerRuns = 0;
  const worker = { compile: vi.fn(async (input: Parameters<typeof makeOutput>[0], signal?: AbortSignal) => {
    if (options.deferWorker && ++workerRuns === 1) await new Promise<void>(resolve => { releaseWorker = resolve; });
    if (options.checkWorkerSignal) signal?.throwIfAborted();
    if (options.changeAfterWorker) revision = 2;
    return makeOutput(input, bytes);
  }) };
  const service = createDashboardNativeCandidateService({ authority, compiler: {
    compilerId: compilerIdentity.id, compilerVersion: compilerIdentity.version, compilerSha256: compilerIdentity.sha256,
    configuration: compilerIdentity.configuration,
    compile: async () => ({ artifact: bytes, objects: [{ nodeId: widgetId, contentCompiled: true, deferredFields: [] }] }),
  }, compilerIdentity, expectedDeviceFingerprintSha256: "a".repeat(64), worker,
  ...(options.layoutCapture ? { layoutCapture: options.layoutCapture } : {}),
  verifyWindow: async input => ({ verifier: "native-dashboard-window-v1", authority: request,
    freezeManifestSha256: input.candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
    compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash,
    fixtureSha256: "b".repeat(64), deviceFingerprintSha256: "a".repeat(64),
    fontSha256: [{ resourceId: "font", sha256: sha(options.fontBytes ?? new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: [widgetId] }),
  });
  return { service, worker, trustedInputs, releaseWorker: () => releaseWorker?.() };
}

function makeOutput(input: { readonly protocol: "dashboard-runtime-compiler-v1"; readonly authority: typeof request;
  readonly freezeManifestSha256: string; readonly sourceSemanticHash: string; readonly compileGraphHash: string }, bytes: Uint8Array) {
  return { protocol: input.protocol, authority: input.authority, freezeManifestSha256: input.freezeManifestSha256,
    sourceSemanticHash: input.sourceSemanticHash, compileGraphHash: input.compileGraphHash, artifact: bytes } as const;
}

describe("dashboard Native candidate service", () => {
  it("isolates retained artifact bytes from both preparation and observation callers", async () => {
    const f = await fixture();
    const prepared = await f.service.prepare(request);
    const original = Uint8Array.from(prepared.artifact.artifact);
    prepared.artifact.artifact.fill(0);
    expect(f.service.candidate?.artifact.artifact).toEqual(original);
    const observed = f.service.candidate!;
    observed.artifact.artifact.fill(1);
    expect(f.service.candidate?.artifact.artifact).toEqual(original);
  });

  it("rejects a cancelled worker result and preserves the last accepted candidate", async () => {
    const f = await fixture();
    const accepted = await f.service.prepare(request);
    let release!: () => void;
    f.worker.compile.mockImplementationOnce(async input => {
      await new Promise<void>(resolve => { release = resolve; });
      return makeOutput(input, accepted.artifact.artifact);
    });
    const controller = new AbortController();
    const pending = f.service.prepare(request, controller.signal);
    await vi.waitFor(() => expect(f.worker.compile).toHaveBeenCalledTimes(2));
    const reason = new Error("disconnected during compile");
    controller.abort(reason);
    release();
    await expect(pending).rejects.toBe(reason);
    expect(f.service.candidate).toEqual(accepted);
  });

  it("rejects an already cancelled request without replacing an in-flight candidate", async () => {
    const f = await fixture({ deferWorker: true });
    const first = f.service.prepare(request);
    await vi.waitFor(() => expect(f.worker.compile).toHaveBeenCalledTimes(1));
    const cancelled = new AbortController();
    const reason = new Error("request disconnected before preparation");
    cancelled.abort(reason);
    await expect(f.service.prepare(request, cancelled.signal)).rejects.toBe(reason);
    expect(f.trustedInputs.derive).toHaveBeenCalledTimes(1);
    expect(f.worker.compile).toHaveBeenCalledTimes(1);
    f.releaseWorker();
    await expect(first).resolves.toMatchObject({ authority: request });
    expect(f.service.candidate).toMatchObject({ authority: request });
  });

  it("keeps only a fully authority, hash, and window-bound candidate in memory", async () => {
    const f = await fixture();
    const candidate = await f.service.prepare(request);
    expect(candidate).toMatchObject({ authority: request, artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetArtifactHash: candidate.artifactSha256, windowVerification: { verifier: "native-dashboard-window-v1" },
      capability: { freezeManifestSha256: candidate.freezeManifestSha256 } });
    expect(f.service.candidate).toEqual(candidate);
    f.service.clear();
    expect(f.service.candidate).toBeUndefined();
  });

  it("fails closed after a stale revision appears in the worker window without retaining a candidate", async () => {
    const f = await fixture({ changeAfterWorker: true });
    await expect(f.service.prepare(request)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(f.service.candidate).toBeUndefined();
    expect(f.worker.compile).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reports supersession consistently when worker checks cancellation: %s", async checkWorkerSignal => {
    const f = await fixture({ deferWorker: true, checkWorkerSignal });
    const first = f.service.prepare(request);
    await vi.waitFor(() => expect(f.worker.compile).toHaveBeenCalledTimes(1));
    const second = f.service.prepare(request);
    f.releaseWorker();
    await expect(first).rejects.toBeInstanceOf(DashboardNativeCandidateSupersededError);
    await expect(second).resolves.toMatchObject({ authority: request });
  });
});

describe("dashboard Native candidate service layout capture wiring", () => {
  it("binds server-measured layouts into the compiler input through the injected host", async () => {
    const stub = stubLayoutCapture();
    const f = await fixture({ measuredWidget: true, layoutCapture: { host: stub.host, locale: "zh-CN" } });
    await f.service.prepare(request);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ protocol: "dashboard-measured-layout-v1", nodeId: "widget-value",
      logicalSize: [320, 120], locale: "zh-CN" });
    expect(stub.requests[0]!.fonts[0]).toMatchObject({ id: "font", faceIndex: 0 });
    const input = f.worker.compile.mock.calls[0]![0];
    const bound = input.data[dashboardDataRequestId("widget-value")] as { layout: unknown };
    expect(bound.layout).toEqual(measuredWidgetLayout);
  });

  it("keeps frozen data untouched when no layout host is configured", async () => {
    const f = await fixture({ measuredWidget: true });
    await f.service.prepare(request);
    const input = f.worker.compile.mock.calls[0]![0];
    const bound = input.data[dashboardDataRequestId("widget-value")] as Record<string, unknown>;
    expect(bound).not.toHaveProperty("layout");
    expect(bound.metric).toEqual(metric);
  });

  it("fails the preparation closed when the injected host capture fails", async () => {
    const stub = stubLayoutCapture({ fail: new Error("capture page crashed before the measurement completed") });
    const f = await fixture({ measuredWidget: true, layoutCapture: { host: stub.host, locale: "zh-CN" } });
    await expect(f.service.prepare(request)).rejects.toThrow(/capture page crashed/);
    expect(f.service.candidate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 真实 Chrome 端到端(prepare→capture→编译输入带 layout):仅在设置
// BIM_STUDIO_CHROME_PATH 且本机存在捕获页入口与系统字体时运行;
// 字体仅本地验证,不随包交付。
// ---------------------------------------------------------------------------
const chromePath = process.env.BIM_STUDIO_CHROME_PATH;
const integrationEntry = fileURLToPath(new URL("../../web/scripts/fixtures/dashboardTrustedLayoutCapture.tsx", import.meta.url));
const integrationFont = process.env.DASHBOARD_TRUSTED_LAYOUT_FONT
  ?? ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf"].find(candidate => existsSync(candidate));

describe.skipIf(!chromePath || !existsSync(integrationEntry) || !integrationFont)("dashboard Native candidate service with real Chrome", () => {
  it("delivers a real measured layout in the compiler input", { timeout: 300_000 }, async () => {
    const host = createDashboardChromiumLayoutHost({ id: "chromium-layout-host-it", version: "1.0.0-it",
      chromePath: chromePath!, capturePageEntry: integrationEntry });
    try {
      const f = await fixture({ measuredWidget: true, fontBytes: new Uint8Array(await readFile(integrationFont!)),
        layoutCapture: { host, locale: "zh-CN" } });
      const candidate = await f.service.prepare(request);
      expect(candidate.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
      const input = f.worker.compile.mock.calls[0]![0];
      const bound = input.data[dashboardDataRequestId("widget-value")] as {
        layout: { textBoxes: { role: { kind: string } }[] };
      };
      expect(bound.layout.textBoxes.some(box => box.role.kind === "value")).toBe(true);
      expect(f.service.candidate).toEqual(candidate);
    } finally {
      await host.close();
    }
  });
});
