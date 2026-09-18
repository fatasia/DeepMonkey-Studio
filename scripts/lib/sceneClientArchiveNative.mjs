import { isDeepStrictEqual } from "node:util";
import { createSceneLocalFrame, worldToLocal } from "../../apps/web/src/delivery/sceneLocalCoordinates.ts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { sceneCompilationSource } from "../../apps/web/src/delivery/sceneCompilationSource.ts";
import { collectDeferredObjectFields, collectDeferredSceneFields } from "../../apps/web/src/delivery/sceneInactiveFields.ts";
import { summarizeScenePublicationCompatibility } from "../../packages/contracts/src/scenePublicationCompatibility.ts";
import { getSceneModelAssetId } from "../../packages/contracts/src/sceneModelAsset.ts";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { parseDeepRuntimePackage, runtimeContentSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);
const capabilities = ["deep.scene.runtime.v1", "deep.scene.static-primitives.v1", "deep.scene.static-glb.v1", "deep.scene.camera.v1"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function check(valid, message) { if (!valid) throw new Error(`Native 包内容不一致：${message}`); }

/** 验证归档内部语义和证据绑定；不证明证据来源可信或 Native 已经运行。 */
export function validateSceneClientArchiveNative(manifest, contents) {
  check(manifest?.target === "deep-native" && contents instanceof Map, "目标或内容集合无效");
  const bytes = path => {
    const value = contents.get(path);
    check(Buffer.isBuffer(value), `缺少文件 ${path}`);
    return value;
  };
  const json = path => {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(path)));
    check(object(value), `${path} 必须是对象`);
    return value;
  };
  const scene = json("scene.json"), project = json("project.json");
  check(Array.isArray(scene.models) && Array.isArray(scene.primitives) && Array.isArray(project.models), "对象或项目资源列表缺失");
  check(scene.schemaVersion === 1 && scene.id === manifest.sceneId && scene.projectId === manifest.projectId
    && scene.name === manifest.sceneName && (scene.publishedAt ?? null) === manifest.publishedAt
    && project.id === manifest.projectId, "场景或项目身份不匹配");
  const packageBytes = bytes("native/runtime-package.json");
  const parsed = parseDeepRuntimePackage(packageBytes);
  check(parsed.valid, `运行包校验失败：${parsed.valid ? "" : parsed.issues[0]?.message}`);
  const runtime = parsed.value, native = manifest.nativeRuntime;
  check(object(native) && runtime.schema === native.kind && runtime.schemaVersion === 3 && native.schemaVersion === 3
    && runtime.packageHash.algorithm === native.packageHash?.algorithm && runtime.packageHash.value === native.packageHash?.value,
  "内外运行包合同或 packageHash 不匹配");
  const compilation = json("native/compilation-evidence.json"), report = json("native/compatibility-report.json");
  const sourceHash = runtimeContentSha256(sceneCompilationSource(scene));
  const artifactHash = createHash("sha256").update(packageBytes).digest("hex");
  check(compilation.schemaVersion === 1 && compilation.scope === "static-render-packet"
    && ["deep-scene-static-compile-v3", "deep-scene-static-compile-v4", "deep-scene-static-compile-v5"].includes(compilation.recipe), "编译证据版本、范围或 recipe 不支持");
  check(compilation.sourceSemanticHash === sourceHash && compilation.targetArtifactHash === artifactHash
    && hash(compilation.compileGraphHash), "编译源或产物 hash 不匹配");
  check(Array.isArray(compilation.deferredSceneFields) && compilation.deferredSceneFields.length === 0
    && Array.isArray(compilation.deferredObjectFields) && compilation.deferredObjectFields.length === 0, "仍有未编译字段");
  if (["deep-scene-static-compile-v4", "deep-scene-static-compile-v5"].includes(compilation.recipe)) {
    check(isDeepStrictEqual(compilation.deferredSceneFields, collectDeferredSceneFields(sceneCompilationSource(scene))), "未编译场景字段与源快照不匹配");
    check(isDeepStrictEqual(compilation.deferredObjectFields, collectDeferredObjectFields(scene)), "未编译对象字段与源快照不匹配");
  }
  check(Array.isArray(compilation.compiledSceneFields) && compilation.compiledSceneFields.length === 1
    && compilation.compiledSceneFields[0]?.field === "camera"
    && compilation.compiledSceneFields[0]?.capability === "deep.scene.camera.v1"
    && compilation.compiledSceneFields[0]?.resourceId === "scene.camera"
    && runtime.entrypoints.camera === compilation.compiledSceneFields[0].resourceId, "相机编译映射不匹配");
  check(report.schemaVersion === 1 && report.target === "deep-native" && report.sceneId === scene.id
    && report.platform === "windows-x64" && report.fixtureId === `scene-${sourceHash}`
    && report.capabilityProfileVersion === "deep-scene-compiled-v1" && report.status === "ready"
    && native.status === "ready" && manifest.capabilities?.status === "ready", "报告目标、场景、范围或状态不匹配");
  check(report.contentFingerprint === sourceHash && report.compileGraphHash === compilation.compileGraphHash
    && report.targetArtifactHash === artifactHash, "报告与编译 hash 不匹配");
  check(Array.isArray(report.items) && Array.isArray(report.evidence), "报告检查项或证据缺失");
  for (const [capability, path] of [["deep.scene.runtime.v1", "$"], ["deep.scene.camera.v1", "camera"]]) {
    check(report.items.some(item => item?.capability === capability && item.objectId === scene.id && item.path === path), `缺少 ${capability} 检查项`);
  }
  validateObjectBindings(scene, runtime, compilation, report);
  validateSourceAssets(scene, project, compilation, manifest);
  if (["deep-scene-static-compile-v4", "deep-scene-static-compile-v5"].includes(compilation.recipe)) validateLocalCompilation(scene, runtime, compilation);
  const verified = summarizeScenePublicationCompatibility({ ...report,
    profile: { version: "deep-scene-compiled-v1", capabilities } });
  check(verified.status === "ready", "报告检查项或运行证据绑定未通过");
}

function validateObjectBindings(scene, runtime, compilation, report) {
  const objects = [...scene.primitives.map((value, index) => ({ value, path: `primitives[${index}]`, capability: "deep.scene.static-primitives.v1" })),
    ...scene.models.map((value, index) => ({ value, path: `models[${index}]`, capability: "deep.scene.static-glb.v1" }))];
  const ids = new Set(), instanceIds = new Set();
  check(report.items.length === objects.length + 2, "能力检查项集合不匹配");
  check(Array.isArray(compilation.objectBindings) && compilation.objectBindings.length === objects.length, "对象编译映射数量不匹配");
  const bindings = uniqueIndex(compilation.objectBindings, "nodeId", "对象编译映射缺失或重复");
  const reported = new Set(report.items.map(item => JSON.stringify([item?.objectId, item?.path, item?.capability])));
  for (const { value, path, capability } of objects) {
    check(object(value) && typeof value.modelId === "string" && value.modelId.trim() && !ids.has(value.modelId), "对象 ID 缺失或重复");
    ids.add(value.modelId);
    const binding = bindings.get(value.modelId);
    check(binding && Array.isArray(binding.instanceIds), "对象编译映射缺失或重复");
    check(typeof value.visible === "boolean" && (value.visible ? binding.instanceIds.length > 0 : binding.instanceIds.length === 0), "对象可见性与绘制实例不匹配");
    for (const id of binding.instanceIds) {
      check(typeof id === "string" && id.trim() && !instanceIds.has(id), "绘制实例 ID 缺失或重复");
      instanceIds.add(id);
    }
    check(reported.has(JSON.stringify([value.modelId, path, capability])), `对象缺少能力检查项：${value.modelId}`);
  }
  const instances = runtime.payloads[runtime.entrypoints.renderPacket].instances;
  check(instances.length === instanceIds.size && instances.every(instance => instanceIds.has(instance.id)), "编译映射与运行包实例集合不匹配");
}

function validateSourceAssets(scene, project, compilation, manifest) {
  const expected = new Set(scene.models.filter(model => model.visible).map(getSceneModelAssetId));
  check(Array.isArray(compilation.sourceAssets) && compilation.sourceAssets.length === expected.size, "源资源证据数量不匹配");
  const seen = new Set();
  const models = uniqueIndex(project.models, "id", "项目源资源 ID 缺失或重复");
  check(Array.isArray(manifest.files), "归档索引缺失");
  const files = uniqueIndex(manifest.files, "path", "归档索引路径缺失或重复");
  for (const asset of compilation.sourceAssets) {
    check(object(asset) && typeof asset.assetId === "string" && expected.has(asset.assetId) && !seen.has(asset.assetId)
      && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && hash(asset.sha256), "源资源证据缺失或重复");
    seen.add(asset.assetId);
    const model = models.get(asset.assetId);
    check(model && (model.projectId === undefined || model.projectId === manifest.projectId), "项目源资源 ID 缺失或跨项目");
    const path = model.manifest?.geometryUrl;
    check(typeof path === "string" && path.startsWith("assets/"), "源资源不是包内路径");
    const file = files.get(path);
    check(file && file.bytes === asset.bytes && file.sha256 === asset.sha256, "源资源与归档索引不匹配");
  }
}

function uniqueIndex(values, key, message) {
  const index = new Map();
  for (const value of values) {
    check(object(value) && typeof value[key] === "string" && value[key].trim() && !index.has(value[key]), message);
    index.set(value[key], value);
  }
  return index;
}


function validateLocalCompilation(scene, runtime, compilation) {
  let frame, position, target;
  try {
    frame = createSceneLocalFrame(scene);
    const camera = scene.cameraViews?.find(view => view.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
    position = worldToLocal(camera.position, frame.origin, "camera.position");
    target = worldToLocal(camera.target, frame.origin, "camera.target");
  } catch (error) { check(false, `局部坐标无效：${error.message}`); }
  check(isDeepStrictEqual(compilation.localCoordinates, frame), "局部坐标原点或 profile 不匹配");
  const camera = runtime.payloads[runtime.entrypoints.camera];
  if (compilation.recipe === "deep-scene-static-compile-v5") {
    check(camera.schemaVersion === 2 && runtimeContentSha256(camera.coordinateFrame) === runtimeContentSha256(frame), "运行相机坐标帧与编译证据不匹配");
  } else check(camera.schemaVersion === 1 && camera.coordinateFrame === undefined, "旧版编译的相机合同不匹配");
  const vector = value => [value.x, value.y, value.z];
  check(isDeepStrictEqual(camera.position, vector(position)) && isDeepStrictEqual(camera.target, vector(target)), "局部相机位置或目标不匹配");
  // v4/v5 已由 deferred 检查限定为默认 orbit；自定义约束仍不可交付。
  // 固定 recipe 的相机数学与 Studio 默认自适应范围一致，不加载 Three/Web UI。
  const distance = Math.hypot(...vector(position).map((value, axis) => value - vector(target)[axis]));
  const framed = compilation.recipe === "deep-scene-static-compile-v5";
  const expectedCamera = { schema: "deep-engine.scene-camera", schemaVersion: framed ? 2 : 1,
    ...(framed ? { coordinateFrame: frame } : {}), id: "scene.camera", revision: 1,
    position: vector(position), target: vector(target), verticalFovDegrees: 50,
    near: Math.min(0.05, Math.max(1e-8, distance * 0.01)), far: Math.max(100000, distance * 100) };
  check(runtimeContentSha256(camera) === runtimeContentSha256(expectedCamera), "完整相机参数与编译规则不匹配");
  check(Number.isSafeInteger(compilation.maxSourceBytes) && compilation.maxSourceBytes > 0 && compilation.maxSourceBytes <= 256 * 1024 ** 2
    && compilation.sourceAssets.reduce((sum, asset) => sum + asset.bytes, 0) <= compilation.maxSourceBytes, "源资源预算无效或超限");
  check(compilation.sourceAssets.every((asset, index) => index === 0 || compilation.sourceAssets[index - 1].assetId < asset.assetId), "编译源资源未排序");
  const cameraResource = runtime.resources.find(resource => resource.kind === "scene-camera" && resource.id === runtime.entrypoints.camera);
  const packetResource = runtime.resources.find(resource => resource.kind === "render-packet" && resource.id === runtime.entrypoints.renderPacket);
  check(cameraResource && packetResource, "编译图资源缺失");
  const expected = runtimeContentSha256({ recipe: compilation.recipe, sourceSemanticHash: compilation.sourceSemanticHash,
    sourceAssets: compilation.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
    maxSourceBytes: compilation.maxSourceBytes, localCoordinates: compilation.localCoordinates,
    cameraHash: cameraResource.contentHash.value, renderPacketHash: packetResource.contentHash.value });
  check(compilation.compileGraphHash === expected, "compileGraphHash 重算不匹配");
}

