import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import source from "../fixtures/application-v2-worker-behavior.json";
import { dashboardFrozenFontStyle, dashboardWebPath, validateDashboardWebPackageStructure,
  type DashboardWebPackage } from "./dashboardWebPackage.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = sha(new Uint8Array([1, 2, 3]));
const HEX = /^[a-f0-9]{64}$/;

function manifest(mutate?: (value: DashboardWebPackage) => void): unknown {
  const application = structuredClone(source);
  application.scripts = []; application.scenes = []; application.interactions = [];
  application.pages[0]!.nodes = [];
  const publication = { id: "published", applicationId: application.metadata.id, projectId: application.metadata.projectId,
    applicationRevision: application.metadata.revision, document: application, publishedAt: "2026-09-17T00:00:00.000Z" };
  const body = { schema: "deep-monkey.dashboard-web" as const, schemaVersion: 1 as const, publication,
    publicationSha256: "a".repeat(64), entryPageId: application.pages[0]!.id,
    runtimeFiles: [{ path: "assets/runtime.js", bytes: 3, sha256: digest }],
    resources: [400, 700].map(weight => ({ sourceUrl: `font:${weight}`, path: `resources/font-${weight}`,
      mime: "font/ttf", bytes: 3, sha256: digest,
      font: { weight, style: "normal" as const, licenseEvidence: "structure test", licensePath: "assets/runtime.js" } })) };
  const value = body as unknown as DashboardWebPackage;
  mutate?.(value);
  return value;
}

function font(weight = 700, selection = 0) {
  const bytes = new Uint8Array(92), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1);
  view.setUint32(12, 0x4f532f32); view.setUint32(20, 28); view.setUint32(24, 64);
  view.setUint16(32, weight); view.setUint16(90, selection);
  return bytes;
}

describe("dashboard web package structure contract", () => {
  it("accepts a well-formed package without checking runtime digests", () => {
    expect(() => validateDashboardWebPackageStructure(manifest())).not.toThrow();
  });

  it("rejects publication identity, entry page, scripts and unsupported nodes", () => {
    expect(() => validateDashboardWebPackageStructure(manifest(value => { value.publication.id = ""; }))).toThrow(/身份/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => { value.publication.applicationRevision += 1; }))).toThrow(/身份/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => { value.entryPageId = "missing"; }))).toThrow(/入口/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      (value.publication.document.scripts as unknown[]).push(structuredClone(source.scripts[0]!));
    }))).toThrow(/脚本/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.publication.document.pages[0]!.nodes.push({ ...structuredClone(source.pages[0]!.nodes[0]!), id: "scene-1" });
    }))).toThrow(/暂不支持节点/);
  });

  it("enforces the frozen resource closure in both directions", () => {
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      Object.assign(value.publication.document.pages[0]!, { appearance: { backgroundImageUrl: "https://example.invalid/bg.png" } });
    }))).toThrow(/资源未冻结/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.resources.push({ sourceUrl: "/assets/unused.png", path: "resources/unused", mime: "image/png", bytes: 3, sha256: digest });
    }))).toThrow(/未被发布文档使用/);
  });

  it("requires licensed regular and bold fonts", () => {
    expect(() => validateDashboardWebPackageStructure(manifest(value => { value.resources = []; }))).toThrow(/字体/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => { value.resources = value.resources.slice(0, 1); }))).toThrow(/字体/);
  });

  it("rejects traversal paths, duplicates, budget overflow and malformed digests", () => {
    for (const value of ["../file", "/file", "assets//file", "https://x/file", "a/%2e/file", "a\\b", "a/.", ""])
      expect(dashboardWebPath(value)).toBe(false);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles.push({ ...value.runtimeFiles[0]! });
    }))).toThrow(/路径/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles[0] = { ...value.runtimeFiles[0]!, path: "../escape" };
    }))).toThrow(/路径、摘要或预算/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles[0] = { ...value.runtimeFiles[0]!, sha256: "not-hex" };
    }))).toThrow(/路径、摘要或预算/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles[0] = { ...value.runtimeFiles[0]!, bytes: 0 };
    }))).toThrow(/路径、摘要或预算/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles[0] = { ...value.runtimeFiles[0]!, bytes: 65 * 1024 * 1024 };
    }))).toThrow(/预算/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles = Array.from({ length: 4097 }, (_item, index) =>
        ({ path: `assets/f${index}`, bytes: 1, sha256: digest }));
    }))).toThrow(/文件清单/);
  });

  it("closes resource identities, image mimes and font license records", () => {
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.resources.push({ sourceUrl: "/assets/a.png", path: "resources/a", mime: "image/png", bytes: 3, sha256: digest });
      value.resources.push({ sourceUrl: "/assets/a.png", path: "resources/b", mime: "image/png", bytes: 3, sha256: digest });
    }))).toThrow(/资源身份重复/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      Object.assign(value.publication.document.pages[0]!, { appearance: { backgroundImageUrl: "/assets/a.svg" } });
      value.resources.push({ sourceUrl: "/assets/a.svg", path: "resources/a", mime: "image/svg+xml", bytes: 3, sha256: digest });
    }))).toThrow(/图片类型尚未封闭/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.resources.push({ sourceUrl: "font:400i", path: "resources/font-400i", mime: "font/ttf", bytes: 3, sha256: digest,
        font: { weight: 400, style: "italic", licenseEvidence: "x", licensePath: "assets/missing.txt" } });
    }))).toThrow(/字体身份或授权记录/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles.push({ path: "assets/italic.ttf", bytes: 3, sha256: digest });
      value.resources.push({ sourceUrl: "font:400i", path: "resources/font-400i", mime: "image/png", bytes: 3, sha256: digest,
        font: { weight: 400, style: "italic", licenseEvidence: "x", licensePath: "assets/italic.ttf" } });
    }))).toThrow(/字体身份或授权记录/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.runtimeFiles.push({ path: "assets/second.ttf", bytes: 3, sha256: digest });
      value.resources.push({ sourceUrl: "font:400b", path: "resources/font-400b", mime: "font/ttf", bytes: 3, sha256: digest,
        font: { weight: 400, style: "normal", licenseEvidence: "x", licensePath: "assets/second.ttf" } });
    }))).toThrow(/字体身份或授权记录/);
    expect(() => validateDashboardWebPackageStructure(manifest(value => {
      value.resources.forEach(resource => { (resource.font as { licenseEvidence: string }).licenseEvidence = ""; });
    }))).toThrow(/字体身份或授权记录/);
  });

  it("keeps the sfnt style reader exact about weight and slant", () => {
    expect(dashboardFrozenFontStyle(font())).toEqual({ weight: 700, style: "normal" });
    expect(dashboardFrozenFontStyle(font(400, 1))).toEqual({ weight: 400, style: "italic" });
    expect(() => dashboardFrozenFontStyle(font(0))).toThrow();
    expect(() => dashboardFrozenFontStyle(font(400, 512))).toThrow();
    expect(HEX.test(digest)).toBe(true);
  });
});
