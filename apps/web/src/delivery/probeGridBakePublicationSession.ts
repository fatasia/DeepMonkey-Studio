import type { SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import type { SceneIrradianceProbeGridBake } from "./compileSceneRuntimePackage";
import { sceneCompilationSource } from "./sceneCompilationSource";

/**
 * F3 探针网格烘焙结果的发布会话态（页面内存承载点）。
 *
 * == 为什么是会话态而不是快照字段（决策台账）==
 * 1. 体量：单层网格最大 64^3 探针 × 96B ≈ 25MB，快照要走服务端 JSON 持久化与
 *    发布历史记录，塞进去会同时撑爆存储、传输和既有历史版本兼容三处；
 * 2. 生命周期：bake 由本页 GPU 会话产出（requestDevice 的独立 device），绑定当前
 *    场景语义；发布编译（prepareNativeSceneClientPayload）恰好在同一浏览器会话内
 *    完成，会话态天然覆盖"烘焙→发布"的端到端链路；
 * 3. 一致性：以编译器严格源投影哈希（sceneCompilationSource + runtimeContentSha256，
 *    与 packageIdentity 同一投影）为键，场景语义一变 bake 自动失配——发布时取不到
 *    就不带（包语义与历史一致），绝不携带陈旧烘焙数据。
 *
 * 诚实边界：会话态刷新即失（用户需重新烘焙）；服务端 Native 发布候选
 * （api.createNativeSceneCandidate）不经本模块，服务端编译产物不含 UI 烘焙探针。
 */

/** 会话内一次成功烘焙的证据条目。 */
export interface ProbeGridBakeSessionEntry {
  readonly bake: SceneIrradianceProbeGridBake;
  /** 网格 cell 总数（= probes 长度）。 */
  readonly probeCount: number;
  /** 捕获覆盖的 cell 数（validity 1）。 */
  readonly coveredCount: number;
  readonly bakedAt: string;
}

/** 会话态上限：只保留最近若干个场景的烘焙结果，防长会话内存膨胀。 */
const MAX_SESSION_ENTRIES = 4;

/**
 * 与烘焙结果语义无关的快照顶层键：发布动作（publishScene）会把发布决策写入快照，
 * exportSceneClientPackage 携带的正是 publication.snapshot——这些键必须从会话键里
 * 剔除，否则"烘焙→发布"会因发布决策字段静默失配而丢探针。updatedAt/publishedAt
 * 已由 sceneCompilationSource 剔除，这里只补发布决策三元组。
 */
const BAKE_IRRELEVANT_KEYS = ["publicationMode", "publicationPerformance", "publicationToolbarVisible"] as const;

const entries = new Map<string, ProbeGridBakeSessionEntry>();

/** 烘焙结果的会话键：编译器严格源投影哈希，再剔除发布决策字段。 */
export function probeGridBakeSourceHash(scene: SceneSnapshot): string {
  const source = sceneCompilationSource(scene);
  for (const key of BAKE_IRRELEVANT_KEYS) delete source[key];
  return runtimeContentSha256(source);
}

/** 存入最近一次烘焙结果；同场景覆盖，超上限淘汰最旧。 */
export function storeProbeGridBake(scene: SceneSnapshot, entry: ProbeGridBakeSessionEntry): void {
  const key = probeGridBakeSourceHash(scene);
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_SESSION_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** 读取当前场景的烘焙结果；场景语义已变化（哈希失配）时自然返回 undefined。 */
export function lookupProbeGridBake(scene: SceneSnapshot): ProbeGridBakeSessionEntry | undefined {
  return entries.get(probeGridBakeSourceHash(scene));
}

/** 发布透传入口：当前场景有有效烘焙结果时返回 bake，否则 undefined（不带，包语义与历史一致）。 */
export function probeGridBakeForPayload(scene: SceneSnapshot): SceneIrradianceProbeGridBake | undefined {
  return lookupProbeGridBake(scene)?.bake;
}

/** 显式清除（场景关闭/作者放弃时调用；不调用也不影响正确性，只是白占内存）。 */
export function clearProbeGridBake(scene: SceneSnapshot): void {
  entries.delete(probeGridBakeSourceHash(scene));
}

/** 仅测试用：清空全部会话态。 */
export function resetProbeGridBakeSessionForTest(): void {
  entries.clear();
}
