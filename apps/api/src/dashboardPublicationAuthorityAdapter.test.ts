import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import {
  assertDashboardPublicationAuthorityRequest,
  createDashboardPublicationAuthorityAdapter,
  type DashboardPublicationTrustedInputs,
} from "./dashboardPublicationAuthorityAdapter.js";

const request = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1, entryPageId: "page-main" } as const;

function publication(): PublishedApplicationRecord {
  const dashboard: unknown = structuredClone(source); assertDashboardDocument(dashboard);
  return { id: request.publicationId, projectId: request.projectId, applicationId: request.applicationId,
    applicationRevision: request.applicationRevision, document: dashboard.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

function fixture(overrides: { readonly afterDerive?: () => void; readonly resourceRevision?: number } = {}) {
  let active = publication();
  const store = {
    getProject: vi.fn(() => ({ id: request.projectId })),
    getApplication: vi.fn(() => structuredClone(active.document)),
    getApplicationPublicationPointer: vi.fn(() => ({ projectId: request.projectId, activePublicationId: active.id })),
    getPublishedApplication: vi.fn(() => structuredClone(active)),
  };
  const trustedInputs: DashboardPublicationTrustedInputs = {
    derive: vi.fn(async () => {
      overrides.afterDerive?.();
      return { data: [{ id: "metric-main", nodeId: "widget-scene-main", sourceRevision: "dataset:8" }],
        resources: [{ id: "image-main", kind: "image", objectKey: "projects/project-golden/assets/image.png",
          mime: "image/png", nodeIds: ["widget-scene-main"], revision: 2 }] };
    }),
    resolveData: vi.fn(async () => ({ sourceRevision: "dataset:8", value: { value: 42, unit: "kW" } })),
    readResource: vi.fn(async () => ({ revision: overrides.resourceRevision ?? 2, bytes: new Uint8Array([1, 2, 3]) })),
  };
  const adapter = createDashboardPublicationAuthorityAdapter({ store, trustedInputs });
  return { adapter, store, trustedInputs, replacePublication(next: PublishedApplicationRecord) { active = next; } };
}

describe("dashboard publication authority adapter", () => {
  it("derives every frozen input from the published application and trusted server readers", async () => {
    const f = fixture();
    const frozen = await f.adapter.prepare(request);
    expect(frozen.authority).toEqual({ ...request });
    expect(frozen.document.application).toEqual(publication().document);
    expect(frozen.manifest.data[0]).toMatchObject({ id: "metric-main", sourceRevision: "dataset:8" });
    expect(frozen.manifest.resources[0]).toMatchObject({ id: "image-main", revision: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.trustedInputs.derive).toHaveBeenCalledWith(expect.objectContaining({ id: request.publicationId }), request.entryPageId, undefined);
    expect(f.trustedInputs.resolveData).toHaveBeenCalledWith(request, expect.any(Object), undefined);
    expect(f.trustedInputs.readResource).toHaveBeenCalledWith(request, expect.any(Object), undefined);
  });

  it.each([
    { ...request, document: publication().document },
    { ...request, data: [{ value: 999 }] },
    { ...request, resources: [] },
    { ...request, hash: "f".repeat(64) },
  ])("rejects browser-supplied freeze material", value => {
    expect(() => assertDashboardPublicationAuthorityRequest(value)).toThrow(/unsupported client fields/);
  });

  it("rejects a draft revision or active-publication replacement before trusting closure inputs", async () => {
    const revision = fixture();
    revision.store.getApplication.mockReturnValue({ ...publication().document, metadata: { ...publication().document.metadata, revision: 2 } });
    await expect(revision.adapter.prepare(request)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(revision.trustedInputs.derive).not.toHaveBeenCalled();

    const replaced = fixture({ afterDerive: () => replaced.replacePublication({ ...publication(), id: "publication-2" }) });
    await expect(replaced.adapter.prepare(request)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("rejects a trusted object revision that changes after server-side closure derivation", async () => {
    const f = fixture({ resourceRevision: 3 });
    await expect(f.adapter.prepare(request)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("does not begin trusted derivation when cancelled", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.adapter.prepare(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.trustedInputs.derive).not.toHaveBeenCalled();
  });
});
