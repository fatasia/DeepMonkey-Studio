import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveFixture } from "../../../scripts/lib/sceneClientArchiveFixture.mjs";
import { resolveSceneViewerBranding, stageSceneViewerIcon } from "./scene-viewer-branding.mjs";
import { createTauriOverlay } from "./scene-viewer-package-core.mjs";

const publication = { projectId: "project", sceneId: "scene", publishedAt: null };
test("unset branding retains product resources", async () => {
  assert.deepEqual(await resolveSceneViewerBranding({}, publication), {});
  assert.equal(createTauriOverlay({ productName: "Deep Monkey Studio" }).bundle.icon, undefined);
});
test("verified UI archive is consumed and ICO reaches all Windows packaging surfaces", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "scene-brand-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ico = await readFile(new URL("../src-tauri/icons/icon.ico", import.meta.url));
  const fixture = await archiveFixture({ branding: { applicationName: "园区客户端", iconPath: "branding/icon.ico" },
    payloads: [{ path: "branding/icon.ico", content: Uint8Array.from(ico).buffer }] });
  const file = path.join(root, "scene.zip"); await writeFile(file, fixture.buffer);
  const branding = await resolveSceneViewerBranding({ clientBrandingPackage: file }, publication);
  assert.equal(branding.applicationName, "园区客户端");
  assert.deepEqual(Buffer.from(branding.iconIco), ico);
  const iconPath = await stageSceneViewerIcon(branding, root);
  assert.deepEqual(await readFile(iconPath), ico);
  const overlay = createTauriOverlay({ productName: branding.applicationName, iconPath });
  assert.deepEqual(overlay.bundle.icon, [iconPath]);
  assert.equal(overlay.bundle.windows.nsis.installerIcon, iconPath);
  assert.equal(overlay.bundle.windows.nsis.uninstallerIcon, iconPath);
  assert.equal(overlay.app.windows[0].title, "园区客户端");
  assert.equal(overlay.app.windows[0].create, false);
  assert.equal(overlay.app.windows[0].decorations, true);
  await assert.rejects(resolveSceneViewerBranding({ clientBrandingPackage: file }, { ...publication, sceneId: "other" }), /发布版本一致/);
  assert.equal((await resolveSceneViewerBranding({ clientBrandingPackage: file, productName: "显式覆盖" }, publication)).applicationName, "显式覆盖");
});
test("invalid explicit names and icons fail before build", async t => {
  await assert.rejects(resolveSceneViewerBranding({ productName: "x\nname" }, publication), /控制字符/);
  const root = await mkdtemp(path.join(tmpdir(), "scene-brand-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "broken.png"); await writeFile(file, "bad");
  await assert.rejects(resolveSceneViewerBranding({ iconFile: file }, publication));
});

test("name-only and icon-only overrides preserve the other product default independently", async () => {
  assert.deepEqual(await resolveSceneViewerBranding({ productName: " 客户端 " }, publication), { applicationName: "客户端" });
  const iconFile = new URL("../src-tauri/icons/32x32.png", import.meta.url);
  const icon = await resolveSceneViewerBranding({ iconFile: (await import("node:url")).fileURLToPath(iconFile) }, publication);
  assert.equal(icon.applicationName, undefined);
  assert.equal(Buffer.from(icon.iconIco).readUInt16LE(4), 6);
});
