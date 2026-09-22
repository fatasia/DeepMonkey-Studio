import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "../apps/api/node_modules/jszip/lib/index.js";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { loadConfig } from "../apps/api/src/config.js";
import { createDashboardPublishedFontCatalog } from "../apps/api/src/dashboardPublishedFontCatalog.js";
import { createDashboardPublishedClosure } from "../apps/api/src/dashboardPublishedClosure.js";
import { createDashboardPublicationAuthorityAdapter } from "../apps/api/src/dashboardPublicationAuthorityAdapter.js";
import { createDashboardOfflineArchive } from "../apps/api/src/dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "../apps/api/src/dashboardOfflineArchiveBytes.js";
import { createDashboardStandaloneExecutable } from "../apps/api/src/dashboardStandaloneExecutable.js";
import { createDashboardPortableZip } from "../apps/api/src/dashboardPortableZip.js";
import { parseClientPackageBranding } from "../apps/api/src/clientPackageBranding.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "test-output/native-client-branding-20260918");
await mkdir(output, { recursive: true });
const prior = path.join(root, "test-output/p03-05-atlas-semantic-20260918");
const candidate = path.join(root, "test-output/dashboard-text-density-2x-cached-20260918");
const deployment = JSON.parse(await readFile(path.join(candidate, "deployment.json"), "utf8"));
let capability = JSON.parse(await readFile(path.join(candidate, "capability.json"), "utf8"));
let artifact = await readFile(path.join(candidate, "runtime-package.json"));
const store = new JsonStore(path.join(prior, "isolated-metadata")); await store.init();
const objects = new LocalObjectStore(path.join(prior, "isolated-objects"));
const fonts = createDashboardPublishedFontCatalog(deployment.fontCatalog, objects);
const closure = createDashboardPublishedClosure(store, loadConfig(), { fonts });
const authority = createDashboardPublicationAuthorityAdapter({ store, trustedInputs: {
  derive: (...args) => closure.derive(...args), resolveData: (...args) => closure.resolveData(...args),
  readResource: async (request, item, signal) => ({ revision: await closure.resourceRevision(request, item, signal),
    bytes: await readFile(path.join(prior, "isolated-objects", item.objectKey)) }),
} });
let freezeManifest = (await authority.prepare(capability.authority)).manifest;
if (freezeManifest.manifestSha256 !== capability.freezeManifestSha256) {
  // 数据冻结含 capturedAt，旧进程未落 freeze 时不能编造旧哈希；重新取得真实候选。
  const app = createApiServer();
  app.addHook("preHandler", async request => { request.systemUser = { id: "brand-acceptance", role: "editor", enabled: true, projectIds: [capability.authority.projectId] } as never; });
  try {
    const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, path.join(candidate, "deployment.json"));
    assert(registered);
    const a = capability.authority;
    const response = await app.inject({ method: "POST", url: `/api/projects/${a.projectId}/applications/${a.applicationId}/dashboard-candidates`,
      payload: { publicationId: a.publicationId, applicationRevision: a.applicationRevision, entryPageId: a.entryPageId } });
    assert.equal(response.statusCode, 201, response.body);
    const record = registered.registry.read({ candidateId: response.json().candidateId, projectId: a.projectId, applicationId: a.applicationId });
    assert(record); freezeManifest = record.candidate.freezeManifest;
    capability = record.candidate.capability; artifact = Buffer.from(record.candidate.artifact.artifact);
  } finally { await app.close(); }
}
await writeFile(path.join(output, "freeze-manifest.json"), JSON.stringify(freezeManifest));
await writeFile(path.join(output, "capability.json"), JSON.stringify(capability));
await writeFile(path.join(output, "runtime-package.json"), artifact);
const archive = serializeDashboardOfflineArchive(createDashboardOfflineArchive({ freezeManifest, capability, artifact }));
const executable = path.join(root, "packages/deep-engine-native/target/debug/deep-engine-native.exe");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expectedSha256 = sha(await readFile(executable));
// 已有横向产品字标作为自定义上传验证图，不绘制新品牌资源。
const custom = await parseClientPackageBranding({ applicationName: "工厂运营中心·验证版",
  iconDataUrl: `data:image/png;base64,${(await readFile(path.join(root, "apps/web/public/brand/logo-transparent.png"))).toString("base64")}` });
const evidence: unknown[] = [];
for (const variant of ["default", "custom"]) {
  const options = { expectedSha256, ...(variant === "custom" ? { branding: custom } : {}) };
  const bytes = Buffer.from(await createDashboardStandaloneExecutable(archive, executable, options));
  const packaged = path.join(output, `${variant}.exe`); await writeFile(packaged, bytes);
  const footer = bytes.subarray(-48); assert.equal(footer.subarray(16).toString("hex"), sha(artifact));
  assert.equal(sha(bytes.subarray(bytes.length - 48 - Number(footer.readBigUInt64LE(8)), -48)), sha(artifact));
  const zip = await JSZip.loadAsync(await createDashboardPortableZip(archive, executable, options));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.files["deep-native-player.exe"], sha(await zip.file("deep-native-player.exe")!.async("uint8array")));
  const captures = [];
  for (const round of [1, 2]) {
    const capture = await captureNativePlayerWindow({ label: `${variant}-round-${round}`, executable: packaged, args: [],
      env: { ...process.env, LOCALAPPDATA: path.join(output, `local-${variant}-${round}`) }, outputDirectory: output,
      presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 });
    const brand = JSON.parse((await readFile(`${capture.png}.brand.json`, "utf8")).replace(/^\uFEFF/, ""));
    assert(brand.title.startsWith(variant === "custom" ? custom.applicationName! : "Deep Monkey Studio"));
    assert.deepEqual(brand.icons.map((icon: { kind: string }) => icon.kind), ["window", "taskbar"]);
    captures.push({ ...capture, brand });
  }
  evidence.push({ variant, executableSha256: sha(bytes), candidateSha256: expectedSha256, artifactSha256: sha(artifact), portablePlayerSha256: manifest.files["deep-native-player.exe"], captures });
}
assert.equal(sha(await readFile(executable)), expectedSha256);
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ output, expectedSha256, variants: evidence.length }));
