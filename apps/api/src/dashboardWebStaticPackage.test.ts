import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardDocument, dashboardFrozenFontStyle, validateDashboardWebPackageStructure,
  type DashboardWebPackage } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardWebStaticPackage } from "./dashboardWebStaticPackage.js";
import { dashboardCanonicalJsonSha256 } from "./dashboardPublicationFreeze.js";
import { createWebStaticFixture, FONT_KEYS, IMAGE_KEY, resealFreezeManifest, webAuthority, webFreezeManifest,
  webPublication } from "./dashboardWebStaticPackage.testUtils.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const base = await createWebStaticFixture();
  cleanup.push(base.directory);
  const calls: { readonly objectKey: string }[] = [];
  return { ...base, readResourceObject: async (objectKey: string) => {
    calls.push({ objectKey });
    const bytes = base.objects.get(objectKey);
    if (!bytes) throw new Error(`missing object: ${objectKey}`);
    return bytes;
  }, calls };
}

describe("dashboard web static package builder", () => {
  it("compiles a verifiable, deterministic web.zip from frozen evidence", async () => {
    const f = await fixture();
    const options = { publication: f.publication, freezeManifest: f.freezeManifest,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot };
    const bytes = await createDashboardWebStaticPackage(options);
    expect(bytes[0]).toBe(0x50); expect(bytes[1]).toBe(0x4b);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const names = Object.keys(zip.files).sort();
    expect(names).toContain("index.html"); expect(names).toContain("assets/app.js"); expect(names).toContain("assets/dashboard.css");
    expect(names).toContain("LICENSE"); expect(names).toContain("THIRD_PARTY_NOTICES.md");
    expect(names).not.toContain("licenses/decoy.txt");
    const manifestText = await zip.file("dashboard.web.json")!.async("text");
    expect(manifestText).not.toContain("stale manifest");
    const manifest = JSON.parse(manifestText) as DashboardWebPackage;
    validateDashboardWebPackageStructure(manifest);
    expect(manifest.publicationSha256).toBe(runtimeContentSha256(manifest.publication));
    const { contentSha256, ...body } = manifest;
    expect(runtimeContentSha256(body)).toBe(contentSha256);
    expect(manifest.entryPageId).toBe(f.publication.document.pages[0]!.id);
    expect(manifest.runtimeFiles.map(file => file.path)).not.toContain("dashboard.web.json");
    const banner = manifest.resources.find(resource => !resource.font)!;
    expect(banner.sourceUrl).toBe(`/assets/${IMAGE_KEY}`);
    expect(await zip.file(banner.path)!.async("uint8array")).toEqual(f.objects.get(IMAGE_KEY));
    const fonts = manifest.resources.filter(resource => resource.font);
    expect(fonts.map(resource => resource.font!.weight).sort()).toEqual([400, 700]);
    for (const resource of fonts) {
      const license = await zip.file(resource.font!.licensePath)!.async("text");
      expect(license).toContain("distribution license");
      expect(manifest.runtimeFiles.some(file => file.path === resource.font!.licensePath)).toBe(true);
    }
    // 字体样式必须来自真实字节（OS/2），而不是清单里的自我声明。
    expect(dashboardFrozenFontStyle(await zip.file(fonts[0]!.path)!.async("uint8array")))
      .toEqual({ weight: fonts[0]!.font!.weight, style: "normal" });
    expect(f.calls.map(call => call.objectKey).sort()).toEqual([...f.objects.keys()].sort());
    expect(Buffer.from(await createDashboardWebStaticPackage(options)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects frozen resources whose bytes no longer match the manifest", async () => {
    const f = await fixture();
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: f.freezeManifest,
      readResourceObject: async () => new Uint8Array([9, 9, 9]), licensedFonts: f.licensedFonts,
      webStaticRoot: f.webStaticRoot })).rejects.toThrow(/摘要不一致/);
  });

  it.each(["../escape.bin", "C:/evil.ttf", "/absolute.png", "nested\\..\\back", "a/./b", "a//b"])("rejects object keys escaping the object root: %s", async objectKey => {
    const f = await fixture();
    const manifest = resealFreezeManifest(webFreezeManifest(f.publication, f.objects));
    const tampered = resealFreezeManifest({ ...manifest, resources: [{ ...manifest.resources[0]!, objectKey }] });
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: tampered,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/越界/);
  });

  it("refuses frozen fonts without a matching distribution license or license evidence", async () => {
    const f = await fixture();
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: f.freezeManifest,
      readResourceObject: f.readResourceObject, licensedFonts: [], webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/缺少匹配的发行许可/);
    const manifest = f.freezeManifest;
    const stripped = resealFreezeManifest({ ...manifest,
      resources: manifest.resources.map(resource => {
        if (resource.kind !== "font") return resource;
        const { licenseEvidence: _removed, ...withoutEvidence } = resource;
        return withoutEvidence;
      }) });
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: stripped,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/许可证据/);
  });

  it.each(["empty", "oversized"])("fails closed on %s font license files", async kind => {
    const f = await fixture();
    const licensePath = path.join(f.directory, kind === "empty" ? "empty-license.txt" : "huge-license.txt");
    await writeFile(licensePath, kind === "empty" ? "" : Buffer.alloc(1024 * 1024 + 1, 0x41));
    const licensedFonts = [{ path: f.licensedFonts[0]!.path, licensePath }, ...f.licensedFonts.slice(1)];
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: f.freezeManifest,
      readResourceObject: f.readResourceObject, licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(kind === "empty" ? /许可文件为空/ : /许可文件超出预算/);
  });

  it("rejects a publication or freeze manifest that no longer matches the original release", async () => {
    const f = await fixture();
    const stalePublication = { ...f.publication, applicationRevision: f.publication.applicationRevision + 1 };
    await expect(createDashboardWebStaticPackage({ publication: stalePublication, freezeManifest: f.freezeManifest,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/原始发布文档与冻结清单/);
    const tampered = resealFreezeManifest({ ...f.freezeManifest,
      documentSha256: dashboardCanonicalJsonSha256(createDashboardDocument(
        { ...f.publication.document, metadata: { ...f.publication.document.metadata, name: "edited" } },
        f.freezeManifest.entryPageId)) });
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: tampered,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/原始发布文档与冻结清单/);
    const brokenManifest = { ...f.freezeManifest, manifestSha256: "0".repeat(64) };
    await expect(createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: brokenManifest,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/冻结清单/);
  });

  it("fails closed when the published document no longer closes over the frozen resources", async () => {
    const f = await fixture();
    const document = structuredClone(f.publication.document);
    delete (document.pages[0] as { appearance?: unknown }).appearance;
    const orphanPublication = { ...f.publication, document };
    const orphanManifest = webFreezeManifest(orphanPublication, f.objects);
    await expect(createDashboardWebStaticPackage({ publication: orphanPublication, freezeManifest: orphanManifest,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot }))
      .rejects.toThrow(/未被发布文档使用/);
  });

  it("keeps manifest accounting aligned with the packaged bytes", async () => {
    const f = await fixture();
    const bytes = await createDashboardWebStaticPackage({ publication: f.publication, freezeManifest: f.freezeManifest,
      readResourceObject: f.readResourceObject, licensedFonts: f.licensedFonts, webStaticRoot: f.webStaticRoot });
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("dashboard.web.json")!.async("text")) as DashboardWebPackage;
    for (const file of manifest.runtimeFiles) {
      const packaged = await zip.file(file.path)!.async("uint8array");
      expect(createHash("sha256").update(packaged).digest("hex")).toBe(file.sha256);
      expect(packaged.length).toBe(file.bytes);
    }
    const regular = await readFile(f.licensedFonts.find(font => font.path.includes("regular"))!.path);
    expect([...f.objects.get(FONT_KEYS.regular)!]).toEqual([...new Uint8Array(regular)]);
    expect(webAuthority.publicationId).toBe("publication-web");
  });
});
