import { buildDeepRuntimePackage, type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileDynamicRuntime } from "./compileSceneRuntimePackage";
import type { CompileScenePhysicsRuntimeOptions } from "./compileScenePhysicsRuntime";
import { DynamicAnimationControllerPlayer } from "./dynamicAnimationControllerPlayback";

export interface SceneViewerDynamicPlaybackHost {
  startDynamicRuntimePlayback(
    runtimePackage: DeepRuntimePackage,
    options?: {
      readonly loop?: boolean;
      readonly onFramePresented?: (frame: { readonly timeMs: number; readonly presentationMs: number }) => void;
    },
  ): () => void;
  getModelAnimationPlaybackState?(id: string): { readonly autoplay: boolean; readonly loopMode: "once" | "loop" };
  setModelAnimationPlaybackState?(id: string, state: { readonly autoplay: boolean; readonly loopMode: "once" | "loop" }): void;
  controlAnimation?(id: string, control: { readonly action: "play" | "stop"; readonly clipId?: string }): boolean;
  transitionAnimationClip?(id: string, fromClipId: string, toClipId: string, durationSeconds: number): boolean;
}

export interface SceneViewerPhysicsRuntimeOptions {
  /**
   * 冻结 render packet 的 nodeId → instanceIds 绑定，与坐标原点。
   * 传入后发布查看器消费编译出的 physics 通道（与 Native 同源下译），
   * 不传时物理仍走作者态 `scene.physics` 的本地 Rapier 路径。
   */
  readonly objectBindings: CompileScenePhysicsRuntimeOptions["objectBindings"];
  readonly coordinateOrigin: CompileScenePhysicsRuntimeOptions["coordinateOrigin"];
}

/** Minimal viewer-side host for the published dynamic channel. The delivery
 * viewer already materializes geometry from the frozen publication; the
 * carrier package only has to carry the lowered v7 dynamic payload, so its
 * render packet is empty by construction. This package is a playback input
 * derived from the frozen snapshot — it is never presented as the publish
 * artifact or as a Native-ready package. */
export function compileSceneDynamicRuntimePackage(
  input: SceneSnapshot,
  options: {
    readonly packageId: string;
    readonly packageVersion: string;
    /** 发布查看器消费 physics 通道所需的冻结绑定与坐标原点。 */
    readonly physics?: SceneViewerPhysicsRuntimeOptions;
  },
): DeepRuntimePackage {
  const dynamicRuntime = compileDynamicRuntime(input, options.physics);
  if (!dynamicRuntime) throw new Error("发布快照没有可播放的动态运行通道");
  return buildDeepRuntimePackage({
    packageId: options.packageId,
    packageVersion: options.packageVersion,
    renderPacket: { id: "scene.dynamic-carrier", revision: 1, value: { geometries: [], materials: [], instances: [] } },
    dynamicRuntime,
  });
}

/** Production wiring for the read-only scene viewer: when the frozen
 * publication snapshot carries object TRS animation, start clock-driven
 * playback of the compiled dynamic runtime on the engine's presentation
 * frame scheduler (WebGL and WebGPU hosts alike). Returns the idempotent
 * stop function, or undefined when the snapshot has no playable dynamic
 * channel — a missing channel must stay silent, not fake a playing scene. */
export function startSceneViewerDynamicPlayback(
  engine: SceneViewerDynamicPlaybackHost,
  scene: SceneSnapshot,
  options: { readonly packageId: string; readonly packageVersion: string; readonly physics?: SceneViewerPhysicsRuntimeOptions; readonly onFramePresented?: (frame: { readonly timeMs: number; readonly presentationMs: number }) => void },
): (() => void) | undefined {
  const animation = scene.animation;
  const timelineEnabled = Boolean(animation?.models.length);
  const controllerEnabled = Boolean(animation?.stateMachine?.enabled);
  // 物理通道与动画通道同源：快照启用物理时，即使没有动画也要编译（否则发布后物理失效）。
  const physicsEnabled = scene.physics?.enabled === true && options.physics !== undefined;
  if ((!animation || (!timelineEnabled && !controllerEnabled)) && !physicsEnabled) return undefined;
  const runtimePackage = compileSceneDynamicRuntimePackage(scene, options);
  const stops: Array<() => void> = [];
  // 物理通道由同一个 presentation 时钟驱动：即使没有动画轨道，只要发布包带物理
  // 也必须启动播放，否则发布后物理静止（B3-a 修复的正是这条静默失效路径）。
  const playbackEnabled = timelineEnabled || physicsEnabled;
  if (playbackEnabled) stops.push(engine.startDynamicRuntimePlayback(runtimePackage, {
    loop: animation?.loop ?? true,
    ...(options.onFramePresented ? { onFramePresented: options.onFramePresented } : {}),
  }));
  if (controllerEnabled) {
    if (!engine.controlAnimation || !engine.transitionAnimationClip || !engine.getModelAnimationPlaybackState
      || !engine.setModelAnimationPlaybackState) throw new Error("场景播放器不支持动画状态机宿主");
    const activeModels = new Set<string>();
    const configureLoop = (modelId: string, loop: boolean) => {
      const current = engine.getModelAnimationPlaybackState!(modelId);
      engine.setModelAnimationPlaybackState!(modelId, { ...current, loopMode: loop ? "loop" : "once" });
      activeModels.add(modelId);
    };
    const player = new DynamicAnimationControllerPlayer(runtimePackage, {
      playClip(modelId, clipId, loop) {
        configureLoop(modelId, loop);
        return engine.controlAnimation!(modelId, { action: "play", clipId });
      },
      transitionClip({ modelId, fromClipId, toClipId, durationMs, loop }) {
        configureLoop(modelId, loop);
        return engine.transitionAnimationClip!(modelId, fromClipId, toClipId, durationMs / 1_000);
      },
    });
    if (!player.start()) throw new Error("发布动画状态机的活动片段不可用");
    player.evaluate();
    stops.push(() => { for (const modelId of activeModels) engine.controlAnimation!(modelId, { action: "stop" }); });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops.reverse()) stop();
  };
}
