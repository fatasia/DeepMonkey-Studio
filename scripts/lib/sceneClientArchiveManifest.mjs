import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { validateSceneClientArchivePaths } from "../../apps/web/src/delivery/sceneClientPackageIndex.ts";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { runtimeContentSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
const targets = ["three-webview", "deep-native"];
const required = ["scene.json", "project.json", "applications.json", "runtime.json", "README.txt"];
const nativeFiles = ["native/runtime-package.json", "native/compilation-evidence.json", "native/compatibility-report.json"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonblank = value => typeof value === "string" && value.trim().length > 0;
const date = value => nonblank(value) && Number.isFinite(Date.parse(value));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hashObject = value => object(value) && value.algorithm === "sha256" && hash(value.value);
function check(valid, message) { if (!valid) throw new Error(`客户端包清单无效：${message}`); }

/** 仅验证清单结构和内容身份；ZIP 文件字节及 Native 证据真实性由调用方验证。 */
export function validateSceneClientArchiveManifest(manifest, { expectedTarget } = {}) {
  check(object(manifest), "manifest 必须是对象");
  check(manifest.kind === "bim-studio-scene-client-package" && manifest.schemaVersion === 1, "kind/schemaVersion 不支持");
  check(manifest.purpose === "delivery", "只接受正式 delivery 包");
  check(targets.includes(manifest.target), "target 不支持");
  check(expectedTarget === undefined || (targets.includes(expectedTarget) && manifest.target === expectedTarget), "目标与 expectedTarget 不一致");
  check(["webgl", "webgpu-preferred"].includes(manifest.renderer), "renderer 不支持");
  check(typeof manifest.toolbarVisible === "boolean", "toolbarVisible 必须是布尔值");
  check([manifest.projectId, manifest.sceneId, manifest.sceneName].every(nonblank), "项目或场景身份缺失");
  // 直接导出允许未发布场景，exporter 使用 null 标识。
  check(manifest.publishedAt === null || date(manifest.publishedAt), "publishedAt 无效");
  check(date(manifest.generatedAt), "generatedAt 无效");
  check(Array.isArray(manifest.files), "files 必须是数组");
  for (const file of manifest.files) {
    check(object(file) && typeof file.path === "string" && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && hash(file.sha256) && typeof file.sourceUrl === "string", "文件项 path/bytes/sha256/sourceUrl 无效");
  }
  const paths = manifest.files.map(file => file.path);
  validateSceneClientArchivePaths(paths);
  check(paths.every((path, index) => index === 0 || paths[index - 1] < path), "文件路径未排序");
  check(required.every(path => paths.includes(path)), "缺少必要文本文件");
  if (manifest.branding !== undefined) {
    const branding = manifest.branding;
    check(object(branding) && Object.keys(branding).length > 0
      && Object.keys(branding).every(key => ["applicationName", "iconPath"].includes(key)), "branding 字段无效");
    check(branding.applicationName === undefined || (nonblank(branding.applicationName)
      && branding.applicationName === branding.applicationName.trim() && branding.applicationName.length <= 80
      && !/[\u0000-\u001f\u007f]/.test(branding.applicationName)), "branding.applicationName 无效");
    check(branding.iconPath === undefined || (["branding/icon.png", "branding/icon.ico"].includes(branding.iconPath)
      && paths.includes(branding.iconPath)), "branding.iconPath 缺失或无效");
  }
  check(object(manifest.capabilities), "capabilities 缺失");
  if (manifest.target === "deep-native") {
    const native = manifest.nativeRuntime;
    check(nativeFiles.every(path => paths.includes(path)), "缺少 Native 文件");
    check(object(native) && native.kind === "deep-engine.runtime-package" && native.schemaVersion === 3
      && native.path === nativeFiles[0] && native.reportPath === nativeFiles[2] && native.status === "ready"
      && hashObject(native.packageHash), "Native 运行包合同不匹配");
    check(manifest.capabilities.status === native.status && manifest.capabilities.reportPath === native.reportPath
      && !["twoD", "threeD", "dataBindings", "liveConnections"].some(key => Object.hasOwn(manifest.capabilities, key)), "Native capabilities 不匹配");
  } else {
    check(manifest.nativeRuntime === undefined && !paths.some(path => path.toLowerCase().startsWith("native/")), "Three 包包含 Native 内容");
    check(["twoD", "threeD", "dataBindings", "liveConnections"].every(key => typeof manifest.capabilities[key] === "boolean")
      && !Object.hasOwn(manifest.capabilities, "status") && !Object.hasOwn(manifest.capabilities, "reportPath"), "Three capabilities 不匹配");
  }
  check(hashObject(manifest.contentHash), "contentHash 无效");
  const { files, contentHash, generatedAt: _generatedAt, ...metadata } = manifest;
  const expected = runtimeContentSha256({ metadata, files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
  check(contentHash.value === expected, "contentHash 不匹配");
  return manifest;
}
