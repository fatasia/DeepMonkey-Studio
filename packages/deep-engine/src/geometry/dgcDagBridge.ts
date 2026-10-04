/**
 * `.dgc` → `MeshletDag` 桥:把 decodeDgc 产物补齐成完整 MeshletDag(生产消费面形状)。
 *
 * DgcDag 与 buildMeshletDag 返回值字段级同构(dgcLoader.test 钉住),唯二差异:
 * 1. 缺 `childrenSpans`/`children` 占位字段 —— 补空 Uint32Array(0),与 buildMeshletDag
 *    运行时同值(父子语义已迁移至 parentsByLevel,meshletDag.ts 同注释);
 * 2. `MeshletDag.parentsByLevel` 的类型声明是单 Uint32Array,运行时实为逐层
 *    Uint32Array 数组(buildMeshletDag 与消费面均经 unknown 收窄到真实形状,
 *    漂移由 meshletDag.test/dgcDagBridge.test 钉住)—— 本桥同样收窄,零换算透传。
 * DGC_NO_PARENT(4294967295)哨兵原样保留:F2 孤儿根语义在 compileVirtualGeometryDagPages
 * 内消费,桥不做任何映射。fail-closed:非 decodeDgc 产物的结构性违规直接抛 DgcFormatError。
 */
import { DgcFormatError, decodeDgc, type DgcBytes, type DgcDag } from "./dgcLoader.js";
import type { MeshletDag } from "./meshletDag.js";

/**
 * DgcDag → 完整 MeshletDag。零拷贝:levels/parentsByLevel 的 typed array 视图
 * 原样透传(decodeDgc 的零拷贝性质保持)。仅做 O(levels) 结构守卫,不复读 payload
 * (逐字节校验是 decodeDgc 的职责,输入应来自 decodeDgc)。
 */
export function dgcDagToMeshletDag(dag: DgcDag): MeshletDag {
  if (dag.levels.length === 0) throw new DgcFormatError("dgc bridge: zero levels (decodeDgc never produces this; input must come from decodeDgc)");
  if (dag.parentsByLevel.length !== dag.levels.length - 1) {
    throw new DgcFormatError(`dgc bridge: ${dag.parentsByLevel.length} parent tables for ${dag.levels.length} levels, expected levels-1`);
  }
  for (let k = 0; k < dag.parentsByLevel.length; k++) {
    const fine = dag.levels[k]!.meshletCount;
    if (dag.parentsByLevel[k]!.length !== fine) {
      throw new DgcFormatError(`dgc bridge: parent table ${k} has ${dag.parentsByLevel[k]!.length} entries, fine level has ${fine} clusters`);
    }
  }
  return Object.freeze({
    levels: Object.freeze(dag.levels),
    parentsByLevel: Object.freeze(dag.parentsByLevel),
    childrenSpans: new Uint32Array(0),
    children: new Uint32Array(0),
  } as unknown as MeshletDag);
}

/** `.dgc` 字节 → 完整 MeshletDag:先过 decodeDgc 全校验链(损坏即 DgcFormatError)再桥接。 */
export function meshletDagFromDgc(bytes: DgcBytes): MeshletDag {
  return dgcDagToMeshletDag(decodeDgc(bytes));
}
