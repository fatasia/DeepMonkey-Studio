import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { assertDashboardDocument, createDashboardDocument, type DashboardDocument,
  type PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json" with { type: "json" };
import type { DashboardWebStaticDownloadDependencies } from "./dashboardOfflineArchiveDownloadRoutes.js";
import { dashboardCanonicalJsonSha256, type DashboardPublicationFreezeManifest } from "./dashboardPublicationFreeze.js";

export const webAuthority = { projectId: "project-golden", applicationId: "application-web",
  publicationId: "publication-web", applicationRevision: 7 } as const;
export const IMAGE_KEY = "projects/project-golden/assets/banner.png";
export const FONT_KEYS = { regular: "projects/project-golden/assets/regular.ttf",
  bold: "projects/project-golden/assets/bold.ttf" } as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 92 字节最小静态 sfnt：dashboardFrozenFontStyle 能读出真实 OS/2 字重与斜体位。 */
export function fontBytes(weight: number, selection = 0): Uint8Array {
  const bytes = new Uint8Array(92), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1);
  view.setUint32(12, 0x4f532f32); view.setUint32(20, 28); view.setUint32(24, 64);
  view.setUint16(32, weight); view.setUint16(90, selection);
  return bytes;
}

/** 已发布的静态 Dashboard：无脚本/三维/交互/数据绑定，页面背景引用唯一冻结图片。 */
export function webPublication(): PublishedApplicationRecord {
  const document: unknown = structuredClone(source);
  assertDashboardDocument(document);
  const application = (document as DashboardDocument).application;
  application.metadata.id = webAuthority.applicationId;
  application.metadata.projectId = webAuthority.projectId;
  application.metadata.revision = webAuthority.applicationRevision;
  application.scripts = []; application.scenes = []; application.interactions = [];
  application.pages = application.pages.slice(0, 1);
  application.pages[0]!.nodes = [];
  Object.assign(application.pages[0]!, { appearance: { backgroundImageUrl: `/assets/${IMAGE_KEY}` } });
  application.publicationProfiles.forEach(profile => { profile.entryPageId = application.pages[0]!.id; });
  return { id: webAuthority.publicationId, projectId: webAuthority.projectId, applicationId: webAuthority.applicationId,
    applicationRevision: webAuthority.applicationRevision, document: application, publishedAt: "2026-09-17T00:00:00.000Z" };
}

export function webFreezeManifest(publication: PublishedApplicationRecord,
  objects: ReadonlyMap<string, Uint8Array>): DashboardPublicationFreezeManifest {
  const entryPageId = publication.document.pages[0]!.id;
  const resources = [
    { id: "banner", kind: "image" as const, objectKey: IMAGE_KEY, mime: "image/png", nodeIds: [] as string[],
      revision: 1, bytes: objects.get(IMAGE_KEY)!.length, sha256: sha(objects.get(IMAGE_KEY)!) },
    ...Object.entries(FONT_KEYS).map(([name, objectKey]) => ({ id: `font-${name}`, kind: "font" as const,
      objectKey, mime: "font/ttf", nodeIds: [] as string[], revision: 1, bytes: 92, sha256: sha(objects.get(objectKey)!),
      faceIndex: 0, licenseEvidence: "test-only OFL identity" })),
  ];
  const body = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const,
    authority: { projectId: publication.projectId, applicationId: publication.applicationId,
      publicationId: publication.id, applicationRevision: publication.applicationRevision },
    entryPageId,
    documentSha256: dashboardCanonicalJsonSha256(createDashboardDocument(publication.document, entryPageId)),
    data: [], resources, totalBytes: resources.reduce((sum, resource) => sum + resource.bytes, 0) };
  return { ...body, manifestSha256: dashboardCanonicalJsonSha256(body) };
}

/** 重算 manifestSha256：用于构造"内容被改但哈希自洽"的冻结清单，测试更深层的拒绝分支。 */
export function resealFreezeManifest(manifest: DashboardPublicationFreezeManifest): DashboardPublicationFreezeManifest {
  const { manifestSha256: _removed, ...body } = manifest;
  return { ...body, manifestSha256: dashboardCanonicalJsonSha256(body) };
}

export interface DashboardWebStaticFixture {
  readonly publication: PublishedApplicationRecord;
  readonly freezeManifest: DashboardPublicationFreezeManifest;
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly licensedFonts: readonly { readonly path: string; readonly licensePath: string }[];
  readonly webStaticRoot: string;
  readonly directory: string;
}

/** 目录化的完整夹具：对象字节、授权字体与许可文本、伪 dist（含必须被排除的 decoy）。 */
export async function createWebStaticFixture(): Promise<DashboardWebStaticFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-web-static-"));
  const objects = new Map<string, Uint8Array>([
    [IMAGE_KEY, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
    [FONT_KEYS.regular, fontBytes(400)],
    [FONT_KEYS.bold, fontBytes(700)],
  ]);
  const fonts = path.join(directory, "fonts");
  await mkdir(fonts, { recursive: true });
  const licensedFonts = [] as { path: string; licensePath: string }[];
  for (const [name, objectKey] of Object.entries(FONT_KEYS)) {
    const fontPath = path.join(fonts, `${name}.ttf`), licensePath = path.join(fonts, `${name}.license.txt`);
    await writeFile(fontPath, objects.get(objectKey)!);
    await writeFile(licensePath, `test-only distribution license for ${name}`);
    licensedFonts.push({ path: fontPath, licensePath });
  }
  const webStaticRoot = path.join(directory, "dist");
  await mkdir(path.join(webStaticRoot, "assets"), { recursive: true });
  await mkdir(path.join(webStaticRoot, "licenses"), { recursive: true });
  await writeFile(path.join(webStaticRoot, "index.html"), "<!doctype html><title>dashboard</title>");
  await writeFile(path.join(webStaticRoot, "assets", "app.js"), "export const main=1;");
  await writeFile(path.join(webStaticRoot, "assets", "dashboard.css"), ":root{color-scheme:dark}");
  await writeFile(path.join(webStaticRoot, "licenses", "decoy.txt"), "must not enter the package");
  await writeFile(path.join(webStaticRoot, "dashboard.web.json"), "stale manifest must be excluded");
  return { publication: webPublication(), freezeManifest: webFreezeManifest(webPublication(), objects), objects,
    licensedFonts, webStaticRoot, directory };
}

/** 路由测试用的部署侧供给：readPublication/readResourceObject 均可注入失败或篡改。 */
export async function createWebStaticDownloadFixture(): Promise<{
  readonly fixture: DashboardWebStaticFixture;
  readonly dependencies: DashboardWebStaticDownloadDependencies;
  readonly readPublication: ReturnType<typeof vi.fn>;
}> {
  const fixture = await createWebStaticFixture();
  const readPublication = vi.fn(async () => structuredClone(fixture.publication));
  const readResourceObject = vi.fn(async (objectKey: string) => {
    const bytes = fixture.objects.get(objectKey);
    if (!bytes) throw new Error(`missing object: ${objectKey}`);
    return bytes;
  });
  return { fixture, readPublication,
    dependencies: { readPublication: readPublication as unknown as DashboardWebStaticDownloadDependencies["readPublication"],
      readResourceObject, licensedFonts: fixture.licensedFonts, webStaticRoot: fixture.webStaticRoot } };
}
