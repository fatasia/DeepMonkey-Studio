import { summarizeScenePublicationCompatibility, type PublicationCapabilityEvidence,
  type PublicationCapabilityItem, type ScenePublicationCompatibilityReport, type SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { SceneCompilationEvidence } from "./compileSceneRuntimePackage";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { createSceneLocalFrame } from "./sceneLocalCoordinates";
import { collectDeferredSceneFields, collectDeferredObjectFields } from "./sceneInactiveFields";

const CAPABILITIES = {
  runtime: "deep.scene.runtime.v1", primitives: "deep.scene.static-primitives.v1",
  models: "deep.scene.static-glb.v1", camera: "deep.scene.camera.v1", uncompiled: "deep.scene.uncompiled.v1",
} as const;

// 这些作者扩展未进入运行包时不会影响基础场景加载；保留缺失报告。
// 已知的相机回退单独由 nativeCameraFallback 标记，资源身份及未知字段仍必须阻断。
const OPTIONAL_OMITTED_SCENE_FIELDS = new Set(["postProcessing", "weather", "measurements", "annotations"]);

const COMPILED_FIELD_CAPABILITIES = {
  camera: new Set([CAPABILITIES.camera]),
  cameraConstraints: new Set([CAPABILITIES.camera]),
  cameraViews: new Set(["deep.scene.camera-views.v1"]),
  defaultCameraViewId: new Set(["deep.scene.camera-views.v1"]),
  clipping: new Set(["deep.scene.section-plane.v1"]),
  animation: new Set(["deep.scene.dynamic-runtime.v1"]),
  environment: new Set(["deep.scene.solid-environment.v1", "deep.scene.hdr-environment.v1"]),
  lighting: new Set([
    "deep.scene.directional-light.v1", "deep.scene.multi-light.v1", "deep.scene.spot-shadow.v1",
    "deep.scene.point-shadow.v1", "deep.scene.hdr-lighting.v1",
  ]),
} as const;

const COMPILED_RECIPES = new Set([
  "deep-scene-static-compile-v4", "deep-scene-static-compile-v5", "deep-scene-static-compile-v6",
  "deep-scene-static-compile-v7", "deep-scene-static-compile-v8", "deep-scene-static-compile-v9",
  "deep-scene-static-compile-v10", "deep-scene-static-compile-v11", "deep-scene-static-compile-v12",
  "deep-scene-static-compile-v13",
]);

function expectedRecipe(scene: SceneSnapshot, compilation: SceneCompilationEvidence): string {
  const fields = new Map((compilation.compiledSceneFields ?? []).map(entry => [entry.field, entry.capability]));
  if (scene.environment?.skybox === "studio"
    && fields.get("environment") === "deep.scene.solid-environment.v1") return "deep-scene-static-compile-v13";
  if (fields.get("environment") === "deep.scene.hdr-environment.v1") return "deep-scene-static-compile-v11";
  if (fields.get("environment") === "deep.scene.solid-environment.v1") {
    if (typeof scene.weather === "string" && ["sunny", "cloudy", "fog"].includes(scene.weather)) {
      return "deep-scene-static-compile-v12";
    }
    switch (fields.get("lighting")) {
      case "deep.scene.point-shadow.v1": return "deep-scene-static-compile-v10";
      case "deep.scene.spot-shadow.v1": return "deep-scene-static-compile-v9";
      case "deep.scene.multi-light.v1": return "deep-scene-static-compile-v8";
      case "deep.scene.directional-light.v1": return "deep-scene-static-compile-v7";
      default: return "deep-scene-static-compile-v6";
    }
  }
  return "deep-scene-static-compile-v5";
}

export interface CompiledScenePublicationOptions {
  readonly compilation: SceneCompilationEvidence;
  readonly fixtureId: string;
  readonly platform: string;
  /** 由受信任验证流程提供，不能由用户在发布表单中自行声明。 */
  readonly runtimeEvidence?: readonly PublicationCapabilityEvidence[];
}

/** 消费编译器的对象映射和未消费字段，不另维护几何、材质或二维支持白名单。 */
export function assessCompiledScenePublication(scene: SceneSnapshot, options: CompiledScenePublicationOptions): ScenePublicationCompatibilityReport {
  const { compilation, fixtureId, platform } = options;
  const items: PublicationCapabilityItem[] = [];
  const evidence = options.runtimeEvidence ?? [];
  const item = (objectId: string, path: string, capability: string, reason?: string,
    status: PublicationCapabilityItem["status"] = reason ? "blocked" : "supported"): PublicationCapabilityItem => ({
    sceneId: scene.id, objectId, path, capability, status,
    reason: reason ?? "编译完成，等待核对本产物的 Native 运行证据。",
    remediation: status === "degraded" ? "Native 本次不提供此项能力，保留场景浏览；对应不可用入口不显示。"
      : reason ? "补齐对应字段的编译和运行消费后重新检查，或选择 Three WebView。" : "场景或产物变化后重新验证运行证据。",
    evidenceIds: status === "degraded" || status === "blocked" ? [] : evidence.filter((proof) => proof.capability === capability).map((proof) => proof.id),
  });
  items.push(item(scene.id, "$", CAPABILITIES.runtime));
  if (runtimeContentSha256(sceneCompilationSource(scene)) !== compilation.sourceSemanticHash) {
    items.push(item(scene.id, "$source", CAPABILITIES.uncompiled, "编译证据不属于当前保存快照，请重新编译。"));
  }
  if (compilation.schemaVersion !== 1 || compilation.scope !== "static-render-packet"
    || !COMPILED_RECIPES.has(compilation.recipe) || compilation.recipe !== expectedRecipe(scene, compilation)) {
    items.push(item(scene.id, "$compiler", CAPABILITIES.uncompiled, "编译证据版本或范围未知。"));
  }
  let frameMatches = false;
  try { frameMatches = runtimeContentSha256(compilation.localCoordinates) === runtimeContentSha256(createSceneLocalFrame(scene)); }
  catch { /* 缺少或损坏的坐标证据按未编译处理。 */ }
  if (!frameMatches || !Number.isSafeInteger(compilation.maxSourceBytes) || compilation.maxSourceBytes < 1 || compilation.maxSourceBytes > 256 * 1024 * 1024) {
    items.push(item(scene.id, "$coordinates", CAPABILITIES.uncompiled, "局部坐标或资源预算证据与当前编译规则不一致。"));
  }
  const objects = [...scene.primitives.map((value, index) => ({ value, path: `primitives[${index}]`, capability: CAPABILITIES.primitives })),
    ...scene.models.map((value, index) => ({ value, path: `models[${index}]`, capability: CAPABILITIES.models }))];
  const objectIds = new Set<string>();
  const bindingIds = new Set<string>();
  const bindings = new Map(compilation.objectBindings.map((binding) => [binding.nodeId, binding]));
  const renderIds = new Set<string>();
  for (const binding of compilation.objectBindings) {
    if (bindingIds.has(binding.nodeId)) items.push(item(binding.nodeId, "$bindings", CAPABILITIES.uncompiled, "作者对象映射重复。"));
    bindingIds.add(binding.nodeId);
    for (const id of binding.instanceIds) {
      if (!id || renderIds.has(id)) items.push(item(binding.nodeId, "$bindings.instances", CAPABILITIES.uncompiled, "绘制实例 ID 缺失或重复。"));
      renderIds.add(id);
    }
  }
  for (const { value, path, capability } of objects) {
    const reason = !value.modelId || objectIds.has(value.modelId) ? "作者对象 ID 缺失或重复。"
      : !bindingIds.has(value.modelId) ? "对象缺少编译映射。"
      : value.visible && !bindings.get(value.modelId)?.instanceIds.length ? "可见对象没有绘制实例。" : undefined;
    objectIds.add(value.modelId);
    items.push(item(value.modelId || scene.id, path, capability, reason));
  }
  for (const id of bindingIds) {
    if (!objectIds.has(id)) items.push(item(id || scene.id, "$bindings", CAPABILITIES.uncompiled, "编译映射引用了保存快照中不存在的对象。"));
  }
  const compiledFields = compilation.compiledSceneFields ?? [];
  const compiledFieldNames = new Set(compiledFields.map((entry) => entry.field));
  const deferredSceneFields = new Set(compilation.deferredSceneFields);
  const selectedCameraMode = scene.cameraViews?.find(view => view.id === scene.defaultCameraViewId)?.camera.mode ?? scene.camera.mode;
  // Deep Native currently compiles first/third person authoring into an orbit
  // camera. Keep the package publishable and expose the loss as a degraded
  // capability instead of treating a known runtime fallback as a hard block.
  const nativeCameraFallback = selectedCameraMode !== "orbit" && compiledFieldNames.has("camera");
  for (const field of collectDeferredSceneFields(sceneCompilationSource(scene))) {
    if (!compiledFieldNames.has(field)) deferredSceneFields.add(field);
  }
  const fields = new Set<string>(), resources = new Set<string>();
  for (const entry of compiledFields) {
    // 这里只核对场景字段与资源身份合同，不推断编译器的渲染能力。
    const expectedResource = entry.field === "camera" || entry.field === "cameraConstraints" || entry.field === "cameraViews"
      || entry.field === "defaultCameraViewId" || entry.field === "clipping" ? "scene.camera"
      : entry.field === "animation" ? "scene.dynamic"
      : entry.field === "environment" || entry.field === "lighting" ? "scene.environment" : undefined;
    const capabilities = entry.field in COMPILED_FIELD_CAPABILITIES
      ? COMPILED_FIELD_CAPABILITIES[entry.field as keyof typeof COMPILED_FIELD_CAPABILITIES] : undefined;
    const known = expectedResource !== undefined && entry.resourceId === expectedResource
      && capabilities?.has(entry.capability) === true;
    const sharesEnvironmentResource = entry.resourceId === "scene.environment"
      && entry.field === "lighting" && fields.has("environment");
    const sharesCameraResource = entry.resourceId === "scene.camera"
      && ["cameraConstraints", "cameraViews", "defaultCameraViewId", "clipping"].includes(entry.field)
      && fields.has("camera");
    const reason = !known ? "场景字段、能力或编译资源映射未知。"
      : fields.has(entry.field) || (resources.has(entry.resourceId) && !sharesEnvironmentResource && !sharesCameraResource) ? "场景字段或编译资源映射重复。"
      : !Object.hasOwn(scene, entry.field) ? "编译字段不在当前保存快照中。"
      : deferredSceneFields.has(entry.field)
        ? entry.field === "camera" && nativeCameraFallback
          ? `Deep Native 将该导航模式回退为 orbit；人物、步高和坡度参数不生效。`
          : entry.field === "camera" && selectedCameraMode !== "orbit"
            ? `Deep Native 尚未实现 ${selectedCameraMode} 相机导航模式；当前仅支持 orbit。`
          : "场景字段同时标记为已编译和未编译。"
        : undefined;
    fields.add(entry.field); resources.add(entry.resourceId);
    items.push(item(scene.id, entry.field || "$fields", known ? entry.capability : CAPABILITIES.uncompiled, reason,
      nativeCameraFallback && entry.field === "camera" && deferredSceneFields.has(entry.field) ? "degraded" : undefined));
  }
  // camera 是保存快照的必填语义；删掉 deferred 记录不能使它从预检中消失。
  if (!fields.has("camera") && !deferredSceneFields.has("camera")) {
    items.push(item(scene.id, "camera", CAPABILITIES.uncompiled, "相机缺少编译字段映射。"));
  }
  for (const field of [...deferredSceneFields].sort()) {
    const fallbackField = nativeCameraFallback && (field === "camera" || field === "navigationSettings");
    const reason = field === "camera" && nativeCameraFallback
      ? `Deep Native 将该导航模式回退为 orbit；人物、步高和坡度参数不生效。`
      : field === "camera" && selectedCameraMode !== "orbit"
        ? `Deep Native 尚未实现 ${selectedCameraMode} 相机导航模式；当前仅支持 orbit。`
      : field === "navigationSettings"
        ? "Deep Native 尚未执行 firstPerson/thirdPerson 的 walk/fly、冲刺、重力、跳跃、步高和坡度导航参数。"
      : field === "postProcessing" && scene.postProcessing?.enabled && (scene.postProcessing.screenSpaceReflection
        || (scene.postProcessing.colorGrading && [scene.postProcessing.hue, scene.postProcessing.saturation,
          scene.postProcessing.brightness, scene.postProcessing.contrast, scene.postProcessing.temperature,
          scene.postProcessing.tint].some(value => (value ?? 0) !== 0)))
      ? scene.postProcessing.screenSpaceReflection
        ? "Deep Native 尚未实现 SSR 深度/法线/HDR 合成消费；该效果当前仅由 Studio Deep WebGPU 运行。"
        : "Deep Native 尚未实现作者色彩分级后处理消费（色相/饱和度/亮度/对比度/色温/色调）；该效果当前仅由 Studio Deep WebGPU 与 WebGL 运行。"
      : field === "lighting" && scene.lighting?.lights?.some(light => light.enabled && light.type === "spot"
        && light.castShadow && (light.shadowSoftness ?? 0) > 0)
        ? "Deep Native 尚未实现作者 PCSS 阴影柔化参数消费；该效果当前仅由 Studio Deep WebGPU 运行。"
      : `场景字段 ${field} 尚未进入运行包。`;
    items.push(item(scene.id, field, CAPABILITIES.uncompiled, reason,
      fallbackField || OPTIONAL_OMITTED_SCENE_FIELDS.has(field) ? "degraded" : "blocked"));
  }
  const seenObjectFields = new Set<string>();
  for (const deferred of [...compilation.deferredObjectFields, ...collectDeferredObjectFields(scene)]) {
    for (const field of deferred.fields) {
      const identity = JSON.stringify([deferred.nodeId, field]);
      if (seenObjectFields.has(identity)) continue;
      seenObjectFields.add(identity);
      items.push(item(deferred.nodeId, `objects[${JSON.stringify(deferred.nodeId)}].${field}`, CAPABILITIES.uncompiled,
        `对象字段 ${field} 尚未进入运行包。`));
    }
  }
  return summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: scene.id,
    contentFingerprint: compilation.sourceSemanticHash, compileGraphHash: compilation.compileGraphHash,
    targetArtifactHash: compilation.targetArtifactHash, fixtureId, platform,
    profile: { version: "deep-scene-compiled-v1", capabilities: [...new Set([
      ...Object.values(CAPABILITIES),
      ...new Set(Object.values(COMPILED_FIELD_CAPABILITIES).flatMap((values) => [...values])),
    ])] }, items, evidence });
}
