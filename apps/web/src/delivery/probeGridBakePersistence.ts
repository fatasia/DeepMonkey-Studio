import type { SceneSnapshot } from "@bim-studio/contracts";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { api } from "../api";
import { probeGridBakeSourceHash, type ProbeGridBakeSessionEntry } from "./probeGridBakePublicationSession";
import type { SceneIrradianceProbeGridBake } from "./compileSceneRuntimePackage";

/**
 * F3 探针网格烘焙结果的服务端持久化桥（刷新/换会话恢复）。
 *
 * == 与发布会话态的分工 ==
 * - 会话态（probeGridBakePublicationSession）仍是发布链的唯一事实来源：
 *   发布编译只读会话态；本模块只负责"烘焙成功后异步上送"与"场景加载时回填会话态"。
 * - 回填 = 按（场景当前语义哈希）GET 服务端持久化文档，命中后调用方
 *   storeProbeGridBake 写回会话态；失配（场景语义已变化）自然 404，不命中不报错。
 *
 * == 降级语义（与台账一致）==
 * - PUT 失败：静默降级=维持会话态，console.warn，不影响烘焙/发布可用性；
 * - GET 失败/404：返回 undefined，加载中 bake 不可用不是错误，绝不阻塞渲染。
 *
 * == 一致性语义 ==
 * 服务端按 (sceneId, sourceHash) 内容寻址存储；sourceHash 与会话态同源
 * （probeGridBakeSourceHash），场景语义一变即失配，陈旧烘焙不可能被回填或注入。
 */

/** 服务端持久化文档（与 apps/api probeGridBakeRoutes 的 PUT body / GET 响应同形）。 */
export interface ProbeGridBakePersistRecord {
  readonly sourceHash: string;
  readonly bake: SceneIrradianceProbeGridBake;
  readonly probeCount?: number;
  readonly coveredCount?: number;
  readonly bakedAt?: string;
}

/** 烘焙成功后异步上送；失败静默降级（维持会话态），只 console.warn，永不 reject。 */
export async function persistProbeGridBake(scene: SceneSnapshot, entry: ProbeGridBakeSessionEntry): Promise<void> {
  const record: ProbeGridBakePersistRecord = {
    sourceHash: probeGridBakeSourceHash(scene),
    bake: entry.bake,
    probeCount: entry.probeCount,
    coveredCount: entry.coveredCount,
    bakedAt: entry.bakedAt,
  };
  try {
    await api.saveProbeGridBake(scene.id, record);
  } catch (reason) {
    // 静默降级：会话态仍在，发布链不受影响；仅留诊断痕迹。
    console.warn(`[probe-bake] 持久化烘焙结果失败（本次会话内发布不受影响）：${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

/** 场景加载时读取服务端持久化烘焙；404/失败/失配一律 undefined（不报错、不阻塞渲染）。 */
export async function fetchPersistedProbeGridBake(scene: SceneSnapshot): Promise<ProbeGridBakeSessionEntry | undefined> {
  const sourceHash = probeGridBakeSourceHash(scene);
  try {
    const record = await api.loadProbeGridBake(scene.id, sourceHash);
    if (!record || record.sourceHash !== sourceHash || !record.bake) return undefined;
    return {
      bake: record.bake,
      ...(record.probeCount !== undefined ? { probeCount: record.probeCount } : {}),
      ...(record.coveredCount !== undefined ? { coveredCount: record.coveredCount } : {}),
      ...(record.bakedAt !== undefined ? { bakedAt: record.bakedAt } : {}),
    } as ProbeGridBakeSessionEntry;
  } catch (reason) {
    // 404=该场景语义哈希下没有持久化烘焙（正常路径，静默）；其余错误同样降级只留诊断。
    if (!(reason instanceof ServerRequestError && reason.status === 404)) {
      console.warn(`[probe-bake] 读取持久化烘焙结果失败（按未烘焙处理）：${reason instanceof Error ? reason.message : String(reason)}`);
    }
    return undefined;
  }
}
