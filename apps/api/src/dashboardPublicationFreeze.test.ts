import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import {
  assertDashboardPublicationFreezeCommit,
  prepareDashboardPublicationFreeze,
  type DashboardFrozenResourceRequest,
  type DashboardPublicationAuthorityState,
  type DashboardPublicationFreezeCandidate,
  type PrepareDashboardPublicationFreezeOptions,
} from "./dashboardPublicationFreeze.js";

const expected = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1 } as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function publication(): PublishedApplicationRecord {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  return { id: expected.publicationId, projectId: expected.projectId, applicationId: expected.applicationId,
    applicationRevision: expected.applicationRevision, document: document.application,
    publishedAt: "2026-09-16T12:00:00.000Z" };
}

function authority(overrides: Partial<DashboardPublicationAuthorityState> = {}): DashboardPublicationAuthorityState {
  return { activePublicationId: expected.publicationId, currentApplicationRevision: expected.applicationRevision,
    publication: publication(), ...overrides };
}

function font(overrides: Partial<DashboardFrozenResourceRequest> = {}): DashboardFrozenResourceRequest {
  return { id: "font-main", kind: "font", objectKey: "projects/project-golden/assets/font-main.woff2",
    mime: "font/woff2", nodeIds: ["widget-scene-main"], revision: 3, faceIndex: 0,
    license: { redistributable: true, evidence: "OFL-1.1:font-main" }, ...overrides };
}

function image(overrides: Partial<DashboardFrozenResourceRequest> = {}): DashboardFrozenResourceRequest {
  return { id: "image-main", kind: "image", objectKey: "projects/project-golden/assets/image-main.png",
    mime: "image/png", nodeIds: ["widget-scene-main"], revision: 2, ...overrides };
}

function video(overrides: Partial<DashboardFrozenResourceRequest> = {}): DashboardFrozenResourceRequest {
  return { id: "video-main", kind: "video", objectKey: "projects/project-golden/assets/video-main.mp4",
    mime: "video/mp4", nodeIds: ["widget-scene-main"], revision: 4, ...overrides };
}

function options(overrides: Partial<PrepareDashboardPublicationFreezeOptions> = {}): PrepareDashboardPublicationFreezeOptions {
  return { expected, entryPageId: "page-main",
    data: [{ id: "metric-main", nodeId: "widget-scene-main", sourceRevision: "dataset:8" }],
    resources: [image(), font()], readAuthority: vi.fn(async () => authority()),
    resolveData: vi.fn(async () => ({ sourceRevision: "dataset:8", value: { unit: "kW", value: 42, labels: ["实时"] } })),
    readResource: vi.fn(async request => ({ revision: request.revision,
      bytes: request.kind === "font" ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5]) })),
    ...overrides };
}

describe("dashboard publication freeze", () => {
  it("rejects oversized, empty and non-byte resources before making a frozen copy", async () => {
    for (const bytes of [new Uint8Array(64 * 1024 * 1024 + 1), new Uint8Array(), [1, 2, 3]]) {
      const copy = vi.spyOn(Uint8Array, "from");
      try {
        const input = options({ data: [], resources: [image()],
          readResource: async () => ({ revision: 2, bytes: bytes as Uint8Array }) });
        await expect(prepareDashboardPublicationFreeze(input)).rejects.toThrow(/budget|invalid bytes/);
        expect(copy).not.toHaveBeenCalled();
        expect(input.readAuthority).toHaveBeenCalledTimes(1);
      } finally { copy.mockRestore(); }
    }
  });

  it("freezes only a byte view and checks the catalog digest of the isolated copy", async () => {
    const backing = new Uint8Array(1024 * 1024), bytes = backing.subarray(100, 103);
    bytes.set([7, 8, 9]);
    const input = options({ data: [], resources: [image({ expectedSha256: hash(bytes) })],
      readResource: async () => ({ revision: 2, bytes }) });
    const candidate = await prepareDashboardPublicationFreeze(input);
    expect(candidate.resources["image-main"]!.buffer.byteLength).toBe(3);
    bytes[0] = 99;
    expect(candidate.resources["image-main"]).toEqual(Uint8Array.of(7, 8, 9));
    expect(candidate.manifest.resources[0]!.sha256).toBe(hash(Uint8Array.of(7, 8, 9)));
    await expect(prepareDashboardPublicationFreeze(input)).rejects.toThrow(/deployed catalog/);
  });

  it("freezes project MP4 bytes with content identity and rejects other video MIME types", async () => {
    const bytes = Uint8Array.of(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32);
    const input = options({ data: [], resources: [video()],
      readResource: async request => ({ revision: request.revision, bytes }) });
    const candidate = await prepareDashboardPublicationFreeze(input);
    expect(candidate.manifest.resources[0]).toMatchObject({ kind: "video", mime: "video/mp4", bytes: 24, sha256: hash(bytes) });
    await expect(prepareDashboardPublicationFreeze(options({ data: [], resources: [video({ mime: "video/webm" })] })))
      .rejects.toThrow(/MIME/);
  });

  it("stops a cancelled resource read before copying its returned bytes", async () => {
    const controller = new AbortController(), copy = vi.spyOn(Uint8Array, "from");
    try {
      const input = options({ data: [], resources: [image()], signal: controller.signal,
        readResource: async () => { controller.abort(); return { revision: 2, bytes: new Uint8Array([1]) }; } });
      await expect(prepareDashboardPublicationFreeze(input)).rejects.toMatchObject({ name: "AbortError" });
      expect(copy).not.toHaveBeenCalled();
    } finally { copy.mockRestore(); }
  });
  it("freezes page-only images and retains page ownership during commit revalidation", async () => {
    const input = options({ resources: [image({ nodeIds: [], pageIds: ["page-main", "page-main"] })] });
    const candidate = await prepareDashboardPublicationFreeze(input);
    expect(candidate.manifest.resources[0]).toMatchObject({ nodeIds: [], pageIds: ["page-main"] });
    await assertDashboardPublicationFreezeCommit(candidate, input);
    expect(input.readResource).toHaveBeenLastCalledWith(expect.objectContaining({ nodeIds: [], pageIds: ["page-main"] }), undefined);
    const changed = structuredClone(candidate);
    (changed.manifest.resources[0]!.pageIds as string[])[0] = "other";
    await expect(assertDashboardPublicationFreezeCommit(changed, input)).rejects.toThrow(/modified/);
  });

  it("rejects unknown page owners, ownerless images and page-owned fonts before reading bytes", async () => {
    for (const resource of [image({ nodeIds: [], pageIds: ["other"] }), image({ nodeIds: [], pageIds: [] }),
      font({ nodeIds: [], pageIds: ["page-main"] })]) {
      const input = options({ resources: [resource] });
      await expect(prepareDashboardPublicationFreeze(input)).rejects.toThrow(/consumer/);
      expect(input.readResource).not.toHaveBeenCalled();
    }
  });

  it("binds the published application revision and hashes resolved data, font and image bytes", async () => {
    const input = options(), candidate = await prepareDashboardPublicationFreeze(input);
    expect(input.readAuthority).toHaveBeenCalledTimes(2);
    expect(candidate.authority).toEqual(expected);
    expect(candidate.document.application.metadata.revision).toBe(1);
    expect(candidate.manifest.data).toEqual([{ id: "metric-main", nodeId: "widget-scene-main",
      sourceRevision: "dataset:8", bytes: 44, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(candidate.manifest.resources.map(item => [item.id, item.sha256])).toEqual([
      ["font-main", hash(new Uint8Array([1, 2, 3]))], ["image-main", hash(new Uint8Array([4, 5]))],
    ]);
    expect(candidate.manifest.resources[0]).toMatchObject({ faceIndex: 0, licenseEvidence: "OFL-1.1:font-main" });
    expect(candidate.manifest.totalBytes).toBe(49);
    expect(candidate.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic across request and object-key order", async () => {
    const first = await prepareDashboardPublicationFreeze(options());
    const second = await prepareDashboardPublicationFreeze(options({ resources: [font(), image()],
      resolveData: async () => ({ sourceRevision: "dataset:8", value: { labels: ["实时"], value: 42, unit: "kW" } }) }));
    expect(second.manifest).toEqual(first.manifest);
  });

  it("rejects a stale revision before resolving external inputs", async () => {
    const input = options({ readAuthority: async () => authority({ currentApplicationRevision: 2 }) });
    await expect(prepareDashboardPublicationFreeze(input)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(input.resolveData).not.toHaveBeenCalled();
    expect(input.readResource).not.toHaveBeenCalled();
  });

  it("rejects when the active publication changes while inputs are resolving", async () => {
    let reads = 0;
    const input = options({ readAuthority: async () => ++reads === 1 ? authority()
      : authority({ activePublicationId: "publication-2" }) });
    await expect(prepareDashboardPublicationFreeze(input)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(reads).toBe(2);
  });

  it("rejects a same-revision published document substitution", async () => {
    let reads = 0;
    await expect(prepareDashboardPublicationFreeze(options({ readAuthority: async () => {
      const state = authority();
      if (++reads === 2) state.publication.document.metadata.name = "substituted";
      return state;
    } }))).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("honors cancellation between asynchronous resolvers and does not continue", async () => {
    const controller = new AbortController();
    const input = options({ signal: controller.signal, resolveData: async () => {
      controller.abort(new DOMException("cancelled", "AbortError")); return { sourceRevision: "dataset:8", value: { value: 42 } };
    } });
    await expect(prepareDashboardPublicationFreeze(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.readResource).not.toHaveBeenCalled();
    expect(input.readAuthority).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing font license", font({ license: undefined })],
    ["signed object URL", image({ objectKey: "projects/project-golden/assets/image.png?token=secret" })],
    ["foreign project key", image({ objectKey: "projects/other/assets/image.png" })],
    ["unknown consumer", image({ nodeIds: ["missing-node"] })],
  ])("rejects %s", async (_label, resource) => {
    const input = options({ data: [], resources: [resource] });
    await expect(prepareDashboardPublicationFreeze(input)).rejects.toThrow();
  });

  it("rejects non-canonical resolved values", async () => {
    await expect(prepareDashboardPublicationFreeze(options({ resolveData: async () => ({ sourceRevision: "dataset:8", value: { value: undefined } }) })))
      .rejects.toThrow(/undefined/);
    await expect(prepareDashboardPublicationFreeze(options({ resolveData: async () => ({ sourceRevision: "dataset:8", value: { value: Number.NaN } }) })))
      .rejects.toThrow(/non-finite/);
  });

  it.each(["data", "resource"] as const)("rejects a stale resolved %s revision", async kind => {
    const input = kind === "data"
      ? options({ resolveData: async () => ({ sourceRevision: "dataset:9", value: { value: 42 } }) })
      : options({ data: [], resources: [image()], readResource: async () => ({ revision: 3, bytes: new Uint8Array([4, 5]) }) });
    await expect(prepareDashboardPublicationFreeze(input)).rejects
      .toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("rechecks authority at commit and rejects a saved draft", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options());
    await expect(assertDashboardPublicationFreezeCommit(candidate, {
      ...commitReaders(), readAuthority: async () => authority({ currentApplicationRevision: 2 }),
    })).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("commits only after authority, data and every resource still match", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options()), readers = commitReaders();
    readers.readAuthority = vi.fn(readers.readAuthority);
    readers.resolveData = vi.fn(readers.resolveData);
    readers.readResource = vi.fn(readers.readResource);
    await expect(assertDashboardPublicationFreezeCommit(candidate, readers)).resolves.toBeUndefined();
    expect(readers.readAuthority).toHaveBeenCalledTimes(2);
    expect(readers.resolveData).toHaveBeenCalledOnce();
    expect(readers.readResource).toHaveBeenCalledTimes(2);
  });

  it.each(["data", "resource"] as const)("rejects stale %s bytes at commit", async kind => {
    const candidate = await prepareDashboardPublicationFreeze(options());
    const readers = commitReaders();
    if (kind === "data") readers.resolveData = async () => ({ sourceRevision: "dataset:8", value: { value: 43 } });
    else readers.readResource = async request => ({ revision: request.revision,
      bytes: request.kind === "font" ? new Uint8Array([1, 2, 9]) : new Uint8Array([4, 5]) });
    await expect(assertDashboardPublicationFreezeCommit(candidate, readers))
      .rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("rejects a draft saved while the final commit resource is being read", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options());
    const readers = commitReaders();
    let revision = 1;
    readers.readAuthority = async () => authority({ currentApplicationRevision: revision });
    const readResource = readers.readResource;
    readers.readResource = async request => {
      const result = await readResource(request);
      revision = 2;
      return result;
    };
    await expect(assertDashboardPublicationFreezeCommit(candidate, readers))
      .rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
  });

  it("detects mutation of already-checked candidate data during resource revalidation", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options());
    const readers = commitReaders();
    const readResource = readers.readResource;
    readers.readResource = async request => {
      mutate(candidate, "data");
      return readResource(request);
    };
    await expect(assertDashboardPublicationFreezeCommit(candidate, readers)).rejects.toThrow(/modified/);
  });

  it.each(["document", "data", "resource", "manifest"] as const)("detects %s mutation before commit", async kind => {
    const candidate = await prepareDashboardPublicationFreeze(options());
    mutate(candidate, kind);
    await expect(assertDashboardPublicationFreezeCommit(candidate, commitReaders()))
      .rejects.toThrow(/modified/);
  });

  it("honors cancellation before the commit authority read", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options()), controller = new AbortController();
    controller.abort(); const readAuthority = vi.fn(async () => authority());
    await expect(assertDashboardPublicationFreezeCommit(candidate, { ...commitReaders(), readAuthority, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it("honors cancellation between commit data and resource revalidation", async () => {
    const candidate = await prepareDashboardPublicationFreeze(options()), controller = new AbortController();
    const readers = commitReaders();
    readers.resolveData = async () => { controller.abort(new DOMException("cancelled", "AbortError"));
      return { sourceRevision: "dataset:8", value: { unit: "kW", value: 42, labels: ["实时"] } }; };
    readers.readResource = vi.fn(readers.readResource);
    await expect(assertDashboardPublicationFreezeCommit(candidate, { ...readers, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(readers.readResource).not.toHaveBeenCalled();
  });

  it("propagates authority and resource transport failures without producing a candidate", async () => {
    await expect(prepareDashboardPublicationFreeze(options({ readAuthority: async () => { throw new Error("offline"); } })))
      .rejects.toThrow("offline");
    await expect(prepareDashboardPublicationFreeze(options({ data: [], resources: [image()],
      readResource: async () => { throw new Error("object store 503"); } }))).rejects.toThrow("object store 503");
  });
});

function commitReaders() {
  return { readAuthority: async () => authority(), resolveData: async () => ({ sourceRevision: "dataset:8",
    value: { unit: "kW", value: 42, labels: ["实时"] } }),
    readResource: async (request: DashboardFrozenResourceRequest) => ({ revision: request.revision,
      bytes: request.kind === "font" ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5]) }) };
}

function mutate(candidate: DashboardPublicationFreezeCandidate, kind: "document" | "data" | "resource" | "manifest") {
  if (kind === "document") candidate.document.application.metadata.name = "tampered";
  if (kind === "data") (candidate.data["metric-main"] as { value: number }).value = 99;
  if (kind === "resource") candidate.resources["font-main"]![0] = 99;
  if (kind === "manifest") (candidate.manifest as { manifestSha256: string }).manifestSha256 = "f".repeat(64);
}
