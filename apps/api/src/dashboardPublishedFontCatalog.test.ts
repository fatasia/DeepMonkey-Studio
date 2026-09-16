import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { LocalObjectStore } from "./objects.js";
import { createDashboardPublishedFontCatalog, type DashboardPublishedFontConfiguration } from "./dashboardPublishedFontCatalog.js";
import { createDashboardPublishedClosure } from "./dashboardPublishedClosure.js";
import { assertDashboardPublicationFreezeCommit, prepareDashboardPublicationFreeze } from "./dashboardPublicationFreeze.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const bytes = Uint8Array.of(0, 1, 0, 0, 5, 6, 7, 8);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const objectKey = "projects/project-golden/fonts/explicit.ttf";
const configuration = (): DashboardPublishedFontConfiguration => ({ projectId: "project-golden", applicationId: "application-worker-behavior",
  applicationRevision: 1, fonts: [{ id: "explicit-font", objectKey, mime: "font/ttf", revision: 4, sha256, faceIndex: 0,
    license: { redistributable: true, evidence: "unit-test-bytes-only: not a production font license" } }],
  nodes: [{ nodeId: "text", fonts: ["explicit-font"], textStyle: { fontSize: 16, fontWeight: 400,
    fontStyle: "normal", lineHeight: 22, color: [255, 255, 255, 255], align: "left" } }] });
function publication(): PublishedApplicationRecord {
  const document = structuredClone(source.application) as PublishedApplicationRecord["document"];
  document.pages = [document.pages[0]!]; document.scripts = []; document.interactions = [];
  document.pages[0]!.nodes = [{ id: "text", kind: "data-widget", zIndex: 0, frame: { x: 0, y: 0, width: 150, height: 80 },
    widget: { type: "text", key: "text", title: "Text", content: "Published text", unit: "", fontWeight: 600 } }];
  return { id: "publication", projectId: "project-golden", applicationId: "application-worker-behavior", applicationRevision: 1,
    publishedAt: "2026-09-16T12:00:00.000Z", document };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-font-catalog-")); directories.push(directory);
  const file = path.join(directory, objectKey); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  const objects = new LocalObjectStore(directory), catalog = createDashboardPublishedFontCatalog(configuration(), objects);
  return { file, objects, catalog };
}

describe("explicit published font catalog", () => {
  it("reads private object bytes and returns isolated compiler font/style configuration", async () => {
    const f = await fixture();
    expect(await f.catalog.derive(publication())).toMatchObject([{ id: "explicit-font", expectedSha256: sha256,
      faceIndex: 0, revision: 4, nodeIds: ["text"] }]);
    const style = f.catalog.compilerNodeAssets;
    (style.text!.fonts as string[]).push("foreign");
    expect(f.catalog.compilerNodeAssets.text!.fonts).toEqual(["explicit-font"]);
    expect(f.catalog.compilerNodeAssets.text!.textStyle.fontWeight).toBe(400);
  });

  it("does not invent redistribution evidence, face indices or inherited text styles", async () => {
    const f = await fixture();
    for (const mutate of [
      (value: any) => { value.fonts[0].license.redistributable = false; },
      (value: any) => { value.fonts[0].license.evidence = " "; },
      (value: any) => { delete value.fonts[0].faceIndex; },
      (value: any) => { delete value.nodes[0].textStyle; },
      (value: any) => { value.fonts[0].objectKey = "projects/foreign/font.ttf"; },
    ]) {
      const value = structuredClone(configuration()); mutate(value);
      expect(() => createDashboardPublishedFontCatalog(value, f.objects)).toThrow();
    }
  });

  it("rejects changed private bytes and old application revision", async () => {
    const f = await fixture(), published = publication();
    const requests = await f.catalog.derive(published);
    await writeFile(f.file, Uint8Array.of(9, 9));
    await expect(f.catalog.resourceRevision(published, requests[0]!)).rejects.toThrow(/bytes differ/);
    published.applicationRevision++;
    await expect(f.catalog.derive(published)).rejects.toThrow(/revision/);
  });

  it("cancels an idle object transport and destroys its stream", async () => {
    const stream = new Readable({ read() {} });
    const catalog = createDashboardPublishedFontCatalog(configuration(), { read: async () => ({ stream, completed: new Promise<void>(() => {}) }) });
    const controller = new AbortController();
    const pending = catalog.derive(publication(), controller.signal);
    await Promise.resolve(); controller.abort(new Error("cancel font read"));
    await expect(pending).rejects.toThrow(/cancel font read/);
    expect(stream.destroyed).toBe(true);
  });

  it("freezes the configured bytes, rejects replacement between catalog check and C3 read, and rechecks commit", async () => {
    const f = await fixture(), published = publication();
    const store = { getProject: () => ({ id: published.projectId } as never), getPublishedApplication: () => published,
      listAssets: () => [], listDatasets: () => [], listDataConnections: () => [], listDataPipelines: () => [] };
    const closure = createDashboardPublishedClosure(store, {} as never, { fonts: f.catalog });
    const selected = await closure.derive(published, "page-main");
    const expected = { projectId: published.projectId, applicationId: published.applicationId,
      applicationRevision: published.applicationRevision, publicationId: published.id };
    const authority = { ...expected, entryPageId: "page-main" };
    const readAuthority = async () => ({ activePublicationId: published.id, currentApplicationRevision: 1, publication: published });
    const resolveData = async () => ({ sourceRevision: "", value: null });
    await expect(prepareDashboardPublicationFreeze({ expected, entryPageId: "page-main", ...selected, readAuthority, resolveData,
      readResource: async () => ({ revision: 4, bytes: Uint8Array.of(9) }) })).rejects.toThrow(/deployed catalog/);
    const readResource = async () => ({ revision: 4, bytes });
    const candidate = await prepareDashboardPublicationFreeze({ expected, entryPageId: "page-main", ...selected, readAuthority, resolveData, readResource });
    await assertDashboardPublicationFreezeCommit(candidate, { readAuthority, resolveData, readResource });
    await expect(assertDashboardPublicationFreezeCommit(candidate, { readAuthority, resolveData,
      readResource: async () => ({ revision: 4, bytes: Uint8Array.of(7) }) })).rejects.toThrow(/changed before commit/);
    await expect(closure.resourceRevision(authority, selected.resources[0]!)).resolves.toBe(4);
    await expect(closure.resourceRevision(authority, { ...selected.resources[0]!, faceIndex: 3 })).rejects.toThrow(/differs/);
  });
});
