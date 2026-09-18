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
  const item = (objectId: string, path: string, capability: string, reason?: string): PublicationCapabilityItem => ({
    sceneId: scene.id, objectId, path, capability, status: reason ? "blocked" : "supported",
    reason: reason ?? "编译完成，等待核对本产物的 Native 运行证据。",
    remediation: reason ? "补齐对应字段的编译和运行消费后重新检查，或选择 Three WebView。" : "场景或产物变化后重新验证运行证据。",
    evidenceIds: reason ? [] : evidence.filter((proof) => proof.capability === capability).map((proof) => proof.id),
  });
  items.push(item(scene.id, "$", CAPABILITIES.runtime));
  if (runtimeContentSha256(sceneCompilationSource(scene)) !== compilation.sourceSemanticHash) {
    items.push(item(scene.id, "$source", CAPABILITIES.uncompiled, "编译证据不属于当前保存快照，请重新编译。"));
  }
  if (compilation.schemaVersion !== 1 || compilation.scope !== "static-render-packet"
    || !["deep-scene-static-compile-v4", "deep-scene-static-compile-v5"].includes(compilation.recipe)) {
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
  const deferredSceneFields = new Set([...compilation.deferredSceneFields,
    ...collectDeferredSceneFields(sceneCompilationSource(scene))]);
  const fields = new Set<string>(), resources = new Set<string>();
  for (const entry of compiledFields) {
    // 这里只核对场景字段与资源身份合同，不推断编译器的渲染能力。
    const known = entry.field === "camera" && entry.capability === CAPABILITIES.camera && entry.resourceId === "scene.camera";
    const reason = !known ? "场景字段、能力或编译资源映射未知。"
      : fields.has(entry.field) || resources.has(entry.resourceId) ? "场景字段或编译资源映射重复。"
      : !Object.hasOwn(scene, entry.field) ? "编译字段不在当前保存快照中。"
      : deferredSceneFields.has(entry.field) ? "场景字段同时标记为已编译和未编译。" : undefined;
    fields.add(entry.field); resources.add(entry.resourceId);
    items.push(item(scene.id, entry.field || "$fields", known ? CAPABILITIES.camera : CAPABILITIES.uncompiled, reason));
  }
  // camera 是保存快照的必填语义；删掉 deferred 记录不能使它从预检中消失。
  if (!fields.has("camera") && !deferredSceneFields.has("camera")) {
    items.push(item(scene.id, "camera", CAPABILITIES.uncompiled, "相机缺少编译字段映射。"));
  }
  for (const field of [...deferredSceneFields].sort()) {
    items.push(item(scene.id, field, CAPABILITIES.uncompiled, `场景字段 ${field} 尚未进入运行包。`));
  }
  const seenObjectFields = new Set<string>();
  for (const deferred of [...compilation.deferredObjectFields, ...collectDeferredObjectFields(scene)]) {
    for (const field of deferred.fields) {
      const identity = JSON.stringify([deferred.nodeId, field]);
      if (seenObjectFields.has(identity)) continue;
      seenObjectFields.add(identity);
      items.push(item(deferred.nodeId, `objects[${JSON.stringify(deferred.nodeId)}].${field}`, CAPABILITIES.uncompiled, `对象字段 ${field} 尚未进入运行包。`));
    }
  }
  return summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: scene.id,
    contentFingerprint: compilation.sourceSemanticHash, compileGraphHash: compilation.compileGraphHash,
    targetArtifactHash: compilation.targetArtifactHash, fixtureId, platform,
    profile: { version: "deep-scene-compiled-v1", capabilities: Object.values(CAPABILITIES) }, items, evidence });
}
