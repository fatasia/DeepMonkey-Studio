import type { SceneSnapshot } from "@bim-studio/contracts";
import { planIncrementalPlayRestore, type IncrementalPlayRestorePlan } from "@bim-studio/deep-engine/scene";

/**
 * C25 · Play 会话恢复调度器（增量域重载的 web 薄层，T30 host.applyScene 的替换件）。
 *
 * 语义与 T30 完全一致：退出 Play = 把"进入前快照"恢复为现场事实；差别只在执行路径——
 * - fast：退出差分判定四个重建域（模型/图元/测量/标注）缓存直通，走 applyScene 的
 *   incrementalPlay 分支（跳过 clearSceneModels 与重建，仅重放逐实例状态 + 廉价 setter 域）。
 * - full：与现状逐位一致的全量 applyScene（requireComplete 严格语义原样保留）。
 *
 * 判定 fail-closed：live 快照缺失、差分判 full、快速路径任何一次失败（含恢复代际
 * 未完成）都会当场降级——本会话后续退出全部走全量，保证可重试性不弱于 T30。
 * 依赖经 getter 注入（engine/project/应用闭包每渲染重建，与 App 绑定语义一致，
 * 不冻结首渲染闭包）；degraded 状态独立于渲染存活在控制器实例上。
 */

/** 每次退出时从 App 读取的最新应用面（全部是既有生产链路，不新增引擎能力）。 */
export interface PlaySessionRestoreDeps {
  /** 播放恢复用的引擎最小面；undefined = 引擎未挂载（走全量路径由其原样拒绝）。 */
  readonly engine: () =>
    | { getAuthorRendererBackend(): string; hasRestoredSceneSnapshot(sceneId: string): boolean }
    | undefined;
  /** 项目上下文；undefined 时全量路径原样抛出（T30 报错语义不变）。 */
  readonly project: () => unknown | undefined;
  /** 退出时刻实况快照（与撤销栈同一工厂）；undefined = 场景未就绪 → 全量路径。 */
  readonly captureLive: () => SceneSnapshot | undefined;
  /** 全量恢复：T30 host.applyScene 原闭包（requireComplete + 恢复代际校验）。 */
  readonly applyFull: (scene: SceneSnapshot) => Promise<void>;
  /** 快速恢复：persistence.applyScene(..., incrementalPlay=true)。 */
  readonly applyIncremental: (scene: SceneSnapshot) => Promise<void>;
}

export type PlaySessionRestoreOutcome =
  | { readonly path: "incremental"; readonly plan: IncrementalPlayRestorePlan }
  | { readonly path: "full"; readonly plan: IncrementalPlayRestorePlan | undefined };

export interface PlaySessionRestore {
  /** T30 host.applyScene 同签名：exitPlay 退出时以进入前快照调用。 */
  restore(scene: SceneSnapshot): Promise<PlaySessionRestoreOutcome>;
  /** 诊断：本会话是否已降级为全量（快速路径失败后为 true，且不会自动恢复）。 */
  isDegraded(): boolean;
}

export function createPlaySessionRestore(readDeps: () => PlaySessionRestoreDeps): PlaySessionRestore {
  let degraded = false;

  async function restore(scene: SceneSnapshot): Promise<PlaySessionRestoreOutcome> {
    const deps = readDeps();
    const engine = deps.engine();
    // 引擎缺失/项目缺失/WebGPU/已降级 → 一律全量（T30 host 闭包原语义，含原报错信息）。
    if (!deps.project() || !engine || engine.getAuthorRendererBackend() === "webgpu" || degraded) {
      await deps.applyFull(scene);
      return { path: "full", plan: undefined };
    }
    const live = deps.captureLive();
    const plan = live ? planIncrementalPlayRestore(scene, live) : undefined;
    if (!plan || plan.mode === "full") {
      await deps.applyFull(scene);
      return { path: "full", plan };
    }
    try {
      await deps.applyIncremental(scene);
      // 与 T30 P1 同一守卫：本次恢复必须真实完成（同场景恢复代际就绪）才算退出成功。
      if (!engine.hasRestoredSceneSnapshot(scene.id)) {
        throw new Error("场景恢复尚未完成，请待模型加载结束后重试退出播放");
      }
    } catch (reason) {
      // 快速路径一旦失败立即降级：重试退出走全量重载，恢复语义不弱于 T30。
      degraded = true;
      throw reason;
    }
    return { path: "incremental", plan };
  }

  return { restore, isDegraded: () => degraded };
}
