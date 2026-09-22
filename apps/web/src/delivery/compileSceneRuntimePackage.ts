import type { SceneSnapshot } from "@bim-studio/contracts";
import { buildDeepRuntimePackage, runtimeContentSha256, serializeDeepRuntimePackage,
  type DeepRuntimePackage, type RuntimeJson, type RuntimePrefilteredIbl,
  type RuntimeIrradianceProbe, type RuntimeIrradianceProbeGrid } from "@bim-studio/deep-engine/runtime-package";
import { packNativeProbeGridRecords } from "@bim-studio/deep-engine/lighting";
import type { DynamicAnimationRuntime, DynamicAnimationTrack } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRenderPacket, type CompileSceneRenderOptions, type SceneRenderCompilation } from "./compileSceneRenderPacket";
import { compileSceneCamera } from "./compileSceneCamera";
import { compileSceneEnvironment } from "./compileSceneEnvironment";
import { compileSceneHdrEnvironment } from "./compileSceneHdrEnvironment";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { collectDeferredSceneFields, collectDeferredObjectFields,
  hasOnlyCompiledCameraConstraintFields } from "./sceneInactiveFields";
import { localizeSceneCoordinates, worldToLocal, type SceneLocalCoordinateFrame } from "./sceneLocalCoordinates";
import { compileScenePhysicsRuntime, type CompileScenePhysicsRuntimeOptions } from "./compileScenePhysicsRuntime";
import { compileSceneAnimationController } from "./compileSceneAnimationController";

const RECIPE = "deep-scene-static-compile-v5";
function findNonJson(value: unknown, path = "$", seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") return `${path} (${typeof value})`;
  if (seen.has(value)) return `${path} (cycle)`;
  seen.add(value);
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) { const issue = findNonJson(value[i], `${path}[${i}]`, seen); if (issue) return issue; } }
  else for (const [key, child] of Object.entries(value)) { const issue = findNonJson(child, `${path}.${key}`, seen); if (issue) return issue; }
  seen.delete(value);
}
function stage<T>(name: string, run: () => T): T { try { return run(); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
/** Lower deterministic camera and object TRS keyframes into the v7 dynamic resource.
 * Imported model clip playback remains deferred until its dedicated consumer exists.
 * Exported for delivery hosts that play the dynamic channel of an already
 * frozen publication snapshot without recompiling geometry resources.
 */
export function compileDynamicRuntime(scene: SceneSnapshot, physicsOptions?: CompileScenePhysicsRuntimeOptions): { readonly id: string; readonly revision: number; readonly value: RuntimeJson } | undefined {
  const animationRuntime = compileAnimationRuntime(scene);
  const animationController = compileSceneAnimationController({
    id: "scene.dynamic",
    revision: 1,
    stateMachine: scene.animation?.stateMachine,
  })?.animationController;
  const physics = physicsOptions ? compileScenePhysicsRuntime(scene, physicsOptions) : undefined;
  if (!animationRuntime && !animationController && !physics) return;
  return { id: "scene.dynamic", revision: 1, value: {
    schema: "deep-engine.dynamic-runtime", schemaVersion: physics ? 3 : animationController ? 2 : 1,
    id: "scene.dynamic", revision: 1,
    ...(animationRuntime ? { animation: animationRuntime } : {}),
    ...(animationController ? { animationController } : {}),
    ...(physics ? { physics } : {}),
  } as unknown as RuntimeJson };
}

function compileAnimationRuntime(scene: SceneSnapshot): DynamicAnimationRuntime | undefined {
  const animation = scene.animation;
  if (!animation || !Number.isFinite(animation.duration) || animation.duration < 0 || animation.duration > 86_400) return;
  const grouped = new Map<string, typeof animation.models>();
  for (const model of animation.models) grouped.set(model.modelId, [...(grouped.get(model.modelId) ?? []), model]);
  const tracks: DynamicAnimationTrack[] = [...grouped.entries()].flatMap(([modelId, frames]) => {
    const sorted = frames.sort((a, b) => a.time - b.time);
    const quat = (x: number, y: number, z: number): readonly [number, number, number, number] => {
      const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
      return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
    };
    const transition = (frame: { transition?: "linear" | "smooth" | "ease-in" | "ease-out" | "step" }) =>
      frame.transition === undefined ? {} : { transition: frame.transition };
    const translation = sorted.map(frame => {
      const { position } = frame.transform;
      return { timeMs: Math.round(frame.time * 1000), value: [position.x, position.y, position.z, 0, 0, 0, 1] as const, ...transition(frame) };
    });
    const rotation = sorted.map(frame => { const q = quat(frame.transform.rotation.x, frame.transform.rotation.y, frame.transform.rotation.z); return { timeMs: Math.round(frame.time * 1000), value: [0, 0, 0, q[0], q[1], q[2], q[3]] as const, ...transition(frame) }; });
    const scale = sorted.map(frame => ({ timeMs: Math.round(frame.time * 1000), value: [frame.transform.scale.x, frame.transform.scale.y, frame.transform.scale.z, 0, 0, 0, 1] as const, ...transition(frame) }));
    const visibleTrack = sorted.filter(frame => frame.visibility !== undefined)
      .map(frame => ({ timeMs: Math.round(frame.time * 1000), value: [frame.visibility ? 1 : 0, 0, 0, 0, 0, 0, 1] as const }));
    const objectTracks = [
      { targetId: modelId, property: "translation" as const, keyframes: translation.map(({ timeMs, value }) => ({ timeMs, value })) },
      { targetId: modelId, property: "rotation" as const, keyframes: rotation },
      { targetId: modelId, property: "scale" as const, keyframes: scale },
      ...(visibleTrack.length ? [{ targetId: modelId, property: "object-visible" as const, keyframes: visibleTrack }] : []),
    ];
    return objectTracks;
  });
  const cameraFrames = [...animation.camera].sort((a, b) => a.time - b.time);
  if (cameraFrames.length) {
    tracks.push({ targetId: "scene.camera", property: "camera-position", keyframes: cameraFrames.map(frame => ({
      timeMs: Math.round(frame.time * 1000), value: [frame.camera.position.x, frame.camera.position.y, frame.camera.position.z, 0, 0, 0, 1],
    })) });
    tracks.push({ targetId: "scene.camera", property: "camera-target", keyframes: cameraFrames.map(frame => ({
      timeMs: Math.round(frame.time * 1000), value: [frame.camera.target.x, frame.camera.target.y, frame.camera.target.z, 0, 0, 0, 1],
    })) });
  }
  if (!tracks.length) return;
  // B2-b:编辑器播放区间随发布包下译,Native/发布查看器按同一区间采样;
  // 缺省(未设区间)不写字段,旧包语义不变。
  const range = animation.playbackRange;
  return {
    schema: "deep-engine.dynamic-animation", schemaVersion: 1,
    durationMs: Math.round(animation.duration * 1000),
    autoplay: animation.autoplay !== false, loop: animation.loop, tracks,
    ...(range ? { playbackRangeMs: { inMs: Math.round(range.inPoint * 1000), outMs: Math.round(range.outPoint * 1000) } } : {}),
  };
}
/**
 * F3 探针网格烘焙结果（发布编译器可选输入）：数据段形状对齐 RuntimeIrradianceProbeGrid，
 * schema/schemaVersion 由编译器盖章（调用方只提供烘焙数据，不能伪造载荷身份）。
 * origin 为场景作者坐标（与烘焙时的场景坐标系一致），编译器随包局部化到局部坐标系。
 */
export interface SceneIrradianceProbeBake {
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly gridSize: readonly [number, number, number];
  readonly probes: readonly RuntimeIrradianceProbe[];
}

export interface CompileSceneRuntimeOptions extends CompileSceneRenderOptions {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly hdrEnvironment?: {readonly payload:RuntimePrefilteredIbl;readonly source:{readonly bytes:number;readonly sha256:string}};
  /** F3 探针网格烘焙结果；缺省或 null 不写环境 irradianceProbes 字段，旧包语义逐位不变。 */
  readonly irradianceProbes?: SceneIrradianceProbeBake | null;
}
export interface SceneCompilationEvidence {
  readonly schemaVersion: 1;
  readonly scope: "static-render-packet";
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  /** 对 runtime/package.json 实际 UTF-8 字节计算，与包内 canonical hash 分开。 */
  readonly targetArtifactHash: string;
  readonly recipe: typeof RECIPE | "deep-scene-static-compile-v4" | "deep-scene-static-compile-v6" | "deep-scene-static-compile-v7" | "deep-scene-static-compile-v8" | "deep-scene-static-compile-v9" | "deep-scene-static-compile-v10" | "deep-scene-static-compile-v11" | "deep-scene-static-compile-v12" | "deep-scene-static-compile-v13";
  readonly environmentSource?:{readonly bytes:number;readonly sha256:string};
  readonly localCoordinates: SceneLocalCoordinateFrame;
  readonly maxSourceBytes: number;
  readonly sourceAssets: readonly { assetId: string; bytes: number; sha256: string }[];
  readonly objectBindings: SceneRenderCompilation["objectBindings"];
  readonly compiledSceneFields: readonly { field: string; capability: string; resourceId: string }[];
  /** 尚未进入运行包的语义，正式发布门禁必须继续处理，不能直接放行。 */
  readonly deferredSceneFields: readonly string[];
  readonly deferredObjectFields: readonly { nodeId: string; fields: readonly string[] }[];
}
export interface CompiledSceneRuntime {
  readonly runtimePackage: DeepRuntimePackage;
  readonly packageJson: string;
  readonly evidence: SceneCompilationEvidence;
}

/** 生成可装载的静态 Runtime Package 与编译证据；不把未编译场景语义声明为支持。 */
export async function compileSceneRuntimePackage(input: SceneSnapshot,
  options: CompileSceneRuntimeOptions): Promise<CompiledSceneRuntime> {
  const scene = structuredClone(input);
  const { packageId, packageVersion, loadModel, imageDecoder, signal, maxSourceBytes } = options;
  signal?.throwIfAborted();
  const semantic = sceneCompilationSource(scene);
  const sourceSemanticHash = stage("source hash", () => runtimeContentSha256(semantic));
  const localized = localizeSceneCoordinates(scene);
  const camera = compileSceneCamera(localized.scene, localized.frame);
  const authoredEnvironment = options.hdrEnvironment ? compileSceneHdrEnvironment(scene.environment,scene.lighting,options.hdrEnvironment.payload,scene.weather,localized.frame.origin) : compileSceneEnvironment(scene.environment, scene.lighting, scene.weather, localized.frame.origin);
  // F3:探针网格烘焙结果(可选)经 Native 打包器校验后随环境载荷发布;缺省完全不写该字段。
  const irradianceProbes = compileSceneIrradianceProbes(options.irradianceProbes, localized.frame.origin);
  const environment = authoredEnvironment && irradianceProbes ? { ...authoredEnvironment, irradianceProbes } : authoredEnvironment;
  const environmentSource=environment?.schemaVersion===6 ? options.hdrEnvironment?.source : undefined;
  if (environment?.schemaVersion===6 && !environmentSource) throw new Error("HDR 来源身份缺失");
  if (environmentSource && (!Number.isSafeInteger(environmentSource.bytes) || environmentSource.bytes<1 || environmentSource.bytes>32*1024**2 || environmentSource.sha256!==environment?.ibl?.source.contentHash.value)) throw new Error("HDR 来源身份或预算无效");
  const recipe = environment?.schemaVersion === 8 ? "deep-scene-static-compile-v13" : environment?.schemaVersion === 7 ? "deep-scene-static-compile-v12" : environment?.schemaVersion === 6 ? "deep-scene-static-compile-v11" : environment?.schemaVersion === 5 ? "deep-scene-static-compile-v10" : environment?.schemaVersion === 4 ? "deep-scene-static-compile-v9" : environment?.lighting?.localLights ? "deep-scene-static-compile-v8" : environment?.lighting ? "deep-scene-static-compile-v7" : environment ? "deep-scene-static-compile-v6" : RECIPE;
  const sourceAssets: Array<{ assetId: string; bytes: number; sha256: string }> = [];
  let loadedBytes = environmentSource?.bytes ?? 0;
  if (loadedBytes>(maxSourceBytes ?? 256*1024*1024)) throw new Error("HDR 资源超出场景预算");
  const compiled = await compileSceneRenderPacket(localized.scene, {
    ...(options.normalizeModel ? { normalizeModel: options.normalizeModel } : {}),
    ...(imageDecoder ? { imageDecoder } : {}), ...(signal ? { signal } : {}),
    auxiliaryGridOrigin: worldToLocal({ x: 0, y: 0, z: 0 }, localized.frame.origin, "environment.grid.origin"),
    ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
    async loadModel(assetId, loadSignal) {
      const loaded = await loadModel(assetId, loadSignal);
      loadSignal.throwIfAborted();
      loadedBytes += loaded.byteLength;
      if (loadedBytes > (maxSourceBytes ?? 256 * 1024 * 1024)) throw new Error(`模型资源 ${assetId} 超出场景预算`);
      const bytes = Uint8Array.from(loaded);
      sourceAssets.push({ assetId, bytes: bytes.byteLength, sha256: await byteHash(bytes) });
      loadSignal.throwIfAborted();
      return bytes;
    } });
  signal?.throwIfAborted();
  const dynamicRuntime = compileDynamicRuntime(localized.scene, { objectBindings: compiled.objectBindings, coordinateOrigin: localized.frame.origin });
  const runtimePackage = stage("package build", () => buildDeepRuntimePackage({ packageId, packageVersion, camera, ...(environment ? { environment } : {}), ...(dynamicRuntime ? { dynamicRuntime } : {}),
    renderPacket: { id: "scene.main", revision: 1, value: compiled.packet } }));
  const nonJson = findNonJson(runtimePackage); if (nonJson) throw new Error(`runtime package non-JSON at ${nonJson}`);
  const packageJson = serializeDeepRuntimePackage(runtimePackage);
  sourceAssets.sort((a, b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
  const compileGraphHash = runtimeContentSha256({ recipe, sourceSemanticHash, sourceAssets,
    packageId, packageVersion, maxSourceBytes: maxSourceBytes ?? 256 * 1024 * 1024,
    localCoordinates: localized.frame,
    ...(environment ? { environmentHash: runtimeContentSha256(environment) } : {}),
    ...(environmentSource ? {environmentSource} : {}),
    cameraHash: runtimePackage.resources.find(resource => resource.kind === "scene-camera")!.contentHash.value,
    renderPacketHash: runtimePackage.resources.find(resource => resource.kind === "render-packet")!.contentHash.value,
    ...(dynamicRuntime ? { dynamicRuntimeHash: runtimePackage.resources.find(resource => resource.kind === "dynamic-runtime")!.contentHash.value } : {}) });
  const targetArtifactHash = await byteHash(new TextEncoder().encode(packageJson));
  signal?.throwIfAborted();
  // 雾随 environment v7 编译，但 weather 字段只被部分消费（粒子/曝光因子未接），
  // 必须继续保留在 deferred 列表里，不能因雾已编译而从 deferred 移除。
  const physicsCompiled = Boolean(dynamicRuntime && scene.physics?.enabled);
  const compiledDynamicValue = dynamicRuntime?.value as { readonly animation?: unknown; readonly animationController?: unknown } | undefined;
  const animationCompiled = Boolean((compiledDynamicValue?.animation || compiledDynamicValue?.animationController)
    && !scene.animation?.models.some(frame => frame.animation));
  const orbitConstraintsCompiled = (camera.schemaVersion === 4 || camera.schemaVersion === 5) && camera.controls?.mode === "orbit"
    && scene.cameraConstraints !== undefined && hasOnlyCompiledCameraConstraintFields(scene.cameraConstraints);
  const cameraViewsCompiled = camera.schemaVersion === 5 && camera.cameraViews !== undefined
    && camera.defaultCameraViewId === scene.defaultCameraViewId;
  const compiledPhysicsBodyIds = new Set([...scene.models, ...scene.primitives]
    .filter(item => physicsCompiled && item.physics?.type !== "none" && item.physics !== undefined).map(item => item.modelId));
  const deferredSceneFields = collectDeferredSceneFields(semantic).filter(field =>
    !(environment && field === "environment")
    && !(environment?.lighting && field === "lighting")
    && !(animationCompiled && field === "animation")
    && !(physicsCompiled && field === "physics")
    && !(orbitConstraintsCompiled && field === "cameraConstraints")
    && !(cameraViewsCompiled && (field === "cameraViews" || field === "defaultCameraViewId"))
    && !(field === "clipping" && (camera.schemaVersion === 3 || camera.schemaVersion === 4 || camera.schemaVersion === 5) && camera.clippingPlane));
  const deferredObjectFields = collectDeferredObjectFields(scene).map(item => ({ ...item,
    fields: item.fields.filter(field => !(field === "physics" && compiledPhysicsBodyIds.has(item.nodeId))) }))
    .filter(item => item.fields.length > 0);
  return { runtimePackage, packageJson, evidence: { schemaVersion: 1, scope: "static-render-packet", recipe,
    localCoordinates: localized.frame, maxSourceBytes: maxSourceBytes ?? 256 * 1024 * 1024,
    sourceSemanticHash, compileGraphHash, targetArtifactHash, sourceAssets, ...(environmentSource ? {environmentSource} : {}),
    objectBindings: compiled.objectBindings, compiledSceneFields: [{ field: "camera", capability: "deep.scene.camera.v1", resourceId: camera.id },
      ...(orbitConstraintsCompiled ? [{ field: "cameraConstraints", capability: "deep.scene.camera.v1", resourceId: camera.id }] : []),
      ...(cameraViewsCompiled ? [
        { field: "cameraViews", capability: "deep.scene.camera-views.v1", resourceId: camera.id },
        { field: "defaultCameraViewId", capability: "deep.scene.camera-views.v1", resourceId: camera.id },
      ] : []),
      ...(animationCompiled ? [{ field: "animation", capability: "deep.scene.dynamic-runtime.v1", resourceId: dynamicRuntime!.id }] : []),
      ...(physicsCompiled ? [{ field: "physics", capability: "deep.scene.physics-runtime.v1", resourceId: dynamicRuntime!.id }] : []),
      ...((camera.schemaVersion === 3 || camera.schemaVersion === 4 || camera.schemaVersion === 5) && camera.clippingPlane ? [{ field: "clipping", capability: "deep.scene.section-plane.v1", resourceId: camera.id }] : []),
      ...(environment ? [{ field: "environment", capability: environment.schemaVersion===6 ? "deep.scene.hdr-environment.v1" : "deep.scene.solid-environment.v1", resourceId: environment.id }] : []),
      ...(irradianceProbes ? [{ field: "irradianceProbes", capability: "deep.scene.probe-grid.v1", resourceId: environment!.id }] : []),
      ...(environment?.lighting ? [{ field: "lighting", capability: environment.schemaVersion === 6 ? "deep.scene.hdr-lighting.v1" : environment.schemaVersion === 5 ? "deep.scene.point-shadow.v1" : environment.schemaVersion === 4 ? "deep.scene.spot-shadow.v1" : environment.lighting.localLights ? "deep.scene.multi-light.v1" : "deep.scene.directional-light.v1", resourceId: environment.id }] : [])],
    deferredSceneFields, deferredObjectFields } };
}

/**
 * F3:探针网格烘焙结果 → 运行包环境 irradianceProbes 载荷。
 * 先把 origin 从作者坐标局部化(与相机/几何同一 frame),再用 Native 打包器
 * `packNativeProbeGridRecords`(96B 记录合同,与 Rust probe_gi_grid 逐字对齐)先行校验:
 * 网格越界/数量与网格体积不符/探针字段越界都会在写包前 fail-closed 抛出可读错误;
 * 载荷随后还会经 buildDeepRuntimePackage → validateRuntimeEnvironment 的
 * irradianceProbes 校验路径二道把关(与 staticLightmap 同款验证路径)。
 * 缺省/null 输入返回 undefined,环境载荷完全不写该字段。
 */
function compileSceneIrradianceProbes(bake: SceneIrradianceProbeBake | null | undefined,
  frameOrigin: { readonly x: number; readonly y: number; readonly z: number }): RuntimeIrradianceProbeGrid | undefined {
  if (!bake) return undefined;
  const local = worldToLocal({ x: bake.origin[0], y: bake.origin[1], z: bake.origin[2] }, frameOrigin,
    "environment.irradianceProbes.origin");
  const origin: readonly [number, number, number] = [local.x, local.y, local.z];
  const gridSize: readonly [number, number, number] = [bake.gridSize[0], bake.gridSize[1], bake.gridSize[2]];
  const grid: RuntimeIrradianceProbeGrid = Object.freeze({
    schema: "deep-engine.probe-grid", schemaVersion: 1,
    origin, spacing: bake.spacing, gridSize,
    probes: Object.freeze(bake.probes.map(probe => Object.freeze({ ...probe }))),
  });
  stage("environment irradianceProbes", () => packNativeProbeGridRecords(grid, grid.probes));
  return grid;
}

async function byteHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
