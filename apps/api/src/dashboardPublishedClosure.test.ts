import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord, DataPipelineDefinition, ProjectAssetRecord, PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { createDashboardPublishedClosure } from "./dashboardPublishedClosure.js";
import { prepareDashboardPublicationFreeze, assertDashboardPublicationFreezeCommit } from "./dashboardPublicationFreeze.js";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

const now = "2026-09-16T12:00:00.000Z";
const authority = { projectId: "project-golden", applicationId: "application-worker-behavior", applicationRevision: 1,
  publicationId: "published", entryPageId: "page-main" };
const servers: net.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function fixture() {
  const document = structuredClone(source.application) as PublishedApplicationRecord["document"];
  document.pages = [document.pages[0]!]; document.scripts = []; document.interactions = [];
  document.pages[0]!.nodes = [
    { id: "image", kind: "data-widget", zIndex: 0, frame: { x: 0, y: 0, width: 120, height: 120 },
      widget: { type: "image", title: "Image", key: "image", unit: "", assetId: "image-asset", imageUrl: "/assets/projects/project-golden/assets/image-asset/a.png" } },
    { id: "chart", kind: "data-widget", zIndex: 1, frame: { x: 130, y: 0, width: 120, height: 120 },
      widget: { type: "bar", title: "Value", key: "saved.value", unit: "", datasetId: "saved" } },
  ];
  const publication: PublishedApplicationRecord = { id: authority.publicationId, applicationId: authority.applicationId,
    projectId: authority.projectId, applicationRevision: 1, document, publishedAt: now };
  const assets: ProjectAssetRecord[] = [{ id: "image-asset", projectId: authority.projectId, kind: "image", name: "a", fileName: "a.png",
    mimeType: "image/png", size: 3, url: "/assets/projects/project-golden/assets/image-asset/a.png", createdAt: now, updatedAt: now }];
  const datasets: DataDatasetRecord[] = [{ id: "saved", projectId: authority.projectId, connectionId: "conn", name: "Saved",
    refreshSeconds: 1, fields: [{ key: "value", label: "Value", type: "number" }], createdAt: now, updatedAt: now }];
  const connections: DataConnectionRecord[] = [{ id: "conn", projectId: authority.projectId, name: "Saved connection",
    type: "tcp", enabled: true, config: {}, createdAt: now, updatedAt: now }];
  const pipelines: DataPipelineDefinition[] = [];
  const store = { getProject: () => ({ id: authority.projectId } as never), getPublishedApplication: (id: string) => id === publication.id ? publication : undefined,
    listAssets: () => assets, listDatasets: () => datasets, listDataConnections: () => connections, listDataPipelines: () => pipelines };
  return { publication, assets, datasets, connections, pipelines, closure: createDashboardPublishedClosure(store, {} as never) };
}

describe("published Dashboard production closure", () => {
  it("deduplicates page and widget image consumers and rechecks page binding", async () => {
    const f = fixture();
    const page = f.publication.document.pages[0]!;
    page.appearance = { backgroundImageUrl: f.assets[0]!.url };
    const requests = await f.closure.derive(f.publication, authority.entryPageId);
    expect(requests.resources).toHaveLength(1);
    expect(requests.resources[0]).toMatchObject({ nodeIds: ["image"], pageIds: [page.id] });
    expect(await f.closure.resourceRevision(authority, requests.resources[0]!)).toBe(Date.parse(now));
    delete page.appearance.backgroundImageUrl;
    await expect(f.closure.resourceRevision(authority, requests.resources[0]!)).rejects.toThrow(/belongs/);
  });

  it("captures page-only backgrounds and rejects external or missing assets", async () => {
    const f = fixture();
    const page = f.publication.document.pages[0]!;
    page.nodes = [];
    page.appearance = { backgroundImageUrl: f.assets[0]!.url };
    f.publication.document.pages.push({ ...structuredClone(page), id: "page-secondary" });
    const result = await f.closure.derive(f.publication, authority.entryPageId);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ nodeIds: [], pageIds: [page.id, "page-secondary"] });
    for (const url of ["https://example.test/background.png", "/assets/projects/other/assets/image/a.png"]) {
      page.appearance.backgroundImageUrl = url;
      await expect(f.closure.derive(f.publication, authority.entryPageId)).rejects.toThrow(/no project asset/);
    }
  });

  it("selects the saved image object and maps its timestamp revision", async () => {
    const f = fixture(), result = await f.closure.derive(f.publication, authority.entryPageId);
    expect(result.resources).toEqual([{ id: "image-asset", kind: "image", nodeIds: ["image"],
      objectKey: "projects/project-golden/assets/image-asset/a.png", mime: "image/png", revision: Date.parse(now) }]);
    expect(result.data[0]).toMatchObject({ nodeId: "chart" });
    f.assets[0]!.updatedAt = "2026-09-16T13:00:00.000Z";
    expect(await f.closure.resourceRevision(authority, result.resources[0]!)).toBe(Date.parse(f.assets[0]!.updatedAt));
  });

  it("rejects changed image binding, remote URLs and cross-project metadata", async () => {
    const f = fixture(), result = await f.closure.derive(f.publication, authority.entryPageId);
    f.assets[0]!.url = "https://example.test/a.png";
    await expect(f.closure.resourceRevision(authority, result.resources[0]!)).rejects.toThrow(/disagree|outside/);
    const other = fixture(); other.datasets[0]!.projectId = "foreign";
    await expect(other.closure.derive(other.publication, authority.entryPageId)).rejects.toThrow(/outside/);
  });

  it("reads actual saved connector rows and C3 catches changing content", async () => {
    const f = fixture(); let rows = [{ recorded_at: now, value: 37 }, { recorded_at: now, value: 91 }];
    const server = net.createServer(socket => socket.end(rows.map(row => JSON.stringify(row)).join("\n") + "\n")); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as net.AddressInfo;
    f.connections[0]!.config.url = `tcp://127.0.0.1:${address.port}`;
    const requests = await f.closure.derive(f.publication, authority.entryPageId);
    const value = await f.closure.resolveData(authority, requests.data[0]!);
    expect(value.value).toMatchObject({ source: { kind: "dataset", id: "saved" }, metric: { value: 37, rows,
      samples: [{ time: Date.parse(now), value: 91 }, { time: Date.parse(now), value: 37 }] } });
    const typed = value.value as { source: { contentSha256: string }; metric: unknown };
    expect(typed.source.contentSha256).toBe(runtimeContentSha256(typed.metric));
    const revalidation = { readAuthority: async () => ({ activePublicationId: f.publication.id,
      currentApplicationRevision: 1, publication: f.publication }),
      resolveData: (request: typeof requests.data[number]) => f.closure.resolveData(authority, request),
      readResource: async () => ({ revision: Date.parse(now), bytes: Uint8Array.of(1, 2, 3) }) };
    const candidate = await prepareDashboardPublicationFreeze({ expected: authority, entryPageId: authority.entryPageId, ...requests, ...revalidation });
    await assertDashboardPublicationFreezeCommit(candidate, revalidation);
    rows = [{ recorded_at: now, value: 99 }];
    await expect(assertDashboardPublicationFreezeCommit(candidate, revalidation)).rejects.toThrow(/changed before commit/);
  });

  it("does not query a replaced data connection or accept an unrelated node request", async () => {
    const f = fixture(), requests = await f.closure.derive(f.publication, authority.entryPageId);
    f.connections[0]!.config.url = "tcp://127.0.0.1:1";
    await expect(f.closure.resolveData(authority, requests.data[0]!)).rejects.toThrow(/changed since freeze/);
    await expect(f.closure.resolveData(authority, { ...requests.data[0]!, nodeId: "image" })).rejects.toThrow(/Unbound/);
  });

  it("executes the saved pipeline against its project dataset and rejects a disabled connection", async () => {
    const f = fixture();
    const server = net.createServer(socket => socket.end('{"value":19}\n')); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    f.connections[0]!.config.url = `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    f.pipelines.push({ id: "pipe", projectId: authority.projectId, name: "Saved pipe", createdAt: now, updatedAt: now,
      nodes: [{ id: "src", type: "source", name: "Data", datasetId: "saved", position: { x: 0, y: 0 } },
        { id: "out", type: "output", name: "Result", position: { x: 1, y: 0 } }],
      edges: [{ id: "edge", sourceNodeId: "src", targetNodeId: "out" }] });
    const chart = f.publication.document.pages[0]!.nodes[1]!;
    if (chart.kind !== "data-widget") throw new Error("invalid test node");
    delete chart.widget.datasetId; chart.widget.pipelineId = "pipe"; chart.widget.key = "pipe.value";
    const requests = await f.closure.derive(f.publication, authority.entryPageId);
    expect((await f.closure.resolveData(authority, requests.data[0]!)).value).toMatchObject({
      source: { kind: "pipeline", id: "pipe" }, metric: { value: 19 } });
    f.connections[0]!.enabled = false;
    await expect(f.closure.derive(f.publication, authority.entryPageId)).rejects.toThrow(/outside/);
  });

  it("has no default font or invented measured layout and handles cancellation before reads", async () => {
    const f = fixture();
    f.publication.document.pages[0]!.nodes = [{ id: "text", kind: "data-widget", zIndex: 0,
      frame: { x: 0, y: 0, width: 100, height: 100 }, widget: { type: "text", key: "text", title: "Actual text", unit: "" } }];
    expect(await f.closure.derive(f.publication, authority.entryPageId)).toEqual({ data: [], resources: [] });
    const controller = new AbortController(); controller.abort();
    await expect(f.closure.derive(f.publication, authority.entryPageId, controller.signal)).rejects.toThrow();
  });

  it.each(["bar", "value", "table"] as const)("freezes authored %s rows with exact Web samples and author revision", async type => {
    const f = fixture();
    const chart = f.publication.document.pages[0]!.nodes[1]!;
    if (chart.kind !== "data-widget") throw new Error("invalid test node");
    delete chart.widget.datasetId;
    chart.widget.type = type; chart.widget.field = "ignored";
    chart.widget.analysis = { measureField: "value", aggregation: "sum" };
    const rows = [{ value: null }, { value: 7 }, { value: "9" }, { value: -3 }];
    chart.widget.sampleData = { sourceId: "author-supplied", rows };
    const selected = await f.closure.derive(f.publication, authority.entryPageId);
    const result = await f.closure.resolveData(authority, selected.data[0]!);
    expect(result.value).toEqual({ source: { kind: "sample", id: "author-supplied", revision: 1,
      contentSha256: runtimeContentSha256({ value: 13, rows, samples: [{ time: 1, value: 7 }, { time: 3, value: -3 }] }) },
      metric: { value: 13, rows, samples: [{ time: 1, value: 7 }, { time: 3, value: -3 }] } });
    expect(result.value).not.toHaveProperty("layout");
    rows[1]!.value = 20;
    await expect(f.closure.resolveData(authority, selected.data[0]!)).rejects.toThrow(/changed since freeze/);
  });

  it("keeps empty authored samples empty and rejects simultaneous data products", async () => {
    const f = fixture();
    const chart = f.publication.document.pages[0]!.nodes[1]!;
    if (chart.kind !== "data-widget") throw new Error("invalid test node");
    chart.widget.sampleData = { rows: [] };
    await expect(f.closure.derive(f.publication, authority.entryPageId)).rejects.toThrow();
    delete chart.widget.datasetId;
    const selected = await f.closure.derive(f.publication, authority.entryPageId);
    expect((await f.closure.resolveData(authority, selected.data[0]!)).value).toMatchObject({
      source: { kind: "sample", revision: 1 }, metric: { rows: [], samples: [] } });
    expect((await f.closure.resolveData(authority, selected.data[0]!)).value).not.toHaveProperty("metric.value");
    f.publication.applicationRevision = 2; f.publication.document.metadata.revision = 2;
    await expect(f.closure.resolveData({ ...authority, applicationRevision: 2 }, selected.data[0]!)).rejects.toThrow(/changed since freeze/);
  });
});
