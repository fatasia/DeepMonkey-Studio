# TS 侧 `.dgc` 加载器合同(待接)

> 现状核查结论(2026-10-04):`packages/deep-engine/src` 全仓 grep 无 `.dgc` 读取器;
> 现有虚拟几何消费链(`virtualGeometryDagPages.ts` / `virtualGeometryPages.ts` /
> `assetBakeResidency.ts`)走的是自有 JSON/bake 管线,与 `.dgc` 无交集。
> **本刀不越界写 TS 侧**,本文件是 TS 加载器实现所需的精确合同。

## 读取路径总览

```text
File/ArrayBuffer
  └─ parseHeader(bytes: ArrayBuffer): DgcFileHeader     // 64B,小端 DataView
  └─ parseSections(): SectionHeader[]                    // 88B × (level_count + parent_pair_count)
  └─ decodePayload(section): ArrayBuffer                 // flags&1 ? inflate(stored) : stored
  └─ views: Float32Array / Uint32Array                   // 直接在 payload 上建视图,零拷贝
```

## 精确字节布局

见 [`dgc-format-spec.md`](dgc-format-spec.md)(字节级权威)。TS 侧实现要点:

1. **全部 LE**:用 `DataView#getUint32(offset, true)` / `#getFloat64(offset, true)`
   解析头;段 payload 整段用 `new Float32Array(buffer, byteOffset, count)` /
   `new Uint32Array(...)` 建视图。**前提:payload_offset 8 字节对齐(格式已保证,
   `Float32Array` 的 `byteOffset` 要求 4 对齐,`f64 error` 要求 8)——不要在
   `SharedArrayBuffer` 之外的任意切片上建视图前忘记校验。**
2. **payload 对齐独立于数组槽位**:8 个数组槽位在 payload 内紧凑拼接,槽位间的
   `byteOffset` 是 `4 × 前面槽位 counts 之和`,天然 4 对齐,可直接建 `Float32Array`/
   `Uint32Array` 视图(positions/bounds 是 f32,其余是 u32;不能跨槽位建一个混合视图)。
3. **zlib**:payload 逐段压缩。TS 侧用项目内已有的 inflate 实现或 `fflate`(纯 JS);
   解压目标尺寸锁定为 `raw_size`(防炸弹,超出即抛错)。
4. **CRC32C**:`read_dgc` 的校验 TS 侧应至少对 header 做尺寸锁定校验;逐段 CRC32C
   可选(Castagnoli 反射,`0x1EDC6F41`,init/xorout `0xFFFFFFFF`;表驱动 8 位实现
   直接抄 `src/dgc.rs::crc32c`)。

## TS 侧目标类型(与 Rust `MeshletDag` 同构)

```ts
interface DgcDag {
  readonly levels: readonly {
    readonly level: number;            // 0 = 原始
    readonly error: number;            // f64,顶点最大位移累计(世界单位)
    readonly positions: Float32Array;  // 紧凑 XYZ
    readonly indices: Uint32Array;     // 三角形
    readonly meshletCount: number;
    readonly maxVertices: number;      // 簇上限(≤64)
    readonly maxTriangles: number;     // 簇上限(≤126,DAG 路线 64)
    readonly descriptors: Uint32Array;        // [vertexOffset, vertexCount, triangleOffset, triangleCount] × n
    readonly vertexRemap: Uint32Array;        // 局部→全局顶点
    readonly localTriangleIndices: Uint32Array; // 低 24 位打包局部三角形
    readonly bounds: Float32Array;            // 16 f32 × n
    readonly sourceTriangles: Uint32Array;    // 输出三角形 → 源三角形
    readonly clusterSourceSpans: Uint32Array; // [start,end) × n
  }[];
  readonly parentsByLevel: readonly Uint32Array[]; // [k]: 层 k 每簇的父(层 k+1 索引);0xFFFFFFFF = 无父
}
```

该结构**与现有 TS 权威实现 `buildMeshletDag` 的返回值同构**
(`packages/deep-engine/src/geometry/meshletDag.ts` 的 `MeshletDag`),因此
G1/F2/T26 既有消费面(簇剔除、HLOD 决策、draw 批)拿到后无需换算——
唯一新增语义是 `0xFFFFFFFF` 无父哨兵(TS 侧原 `parentsByLevel` 用 `-1`)。

## bounds 记录布局(16 f32,与现有消费侧字段序一致)

```text
word 0..3   sphere [cx, cy, cz, r]      // r 为保守 f32(向上 1 ulp)
word 4..7   aabbMin [x, y, z, 0]
word 8..11  aabbMax [x, y, z, 0]
word 12..15 cone [nx, ny, nz, cutoff]   // cutoff = -1 → 锥剔除禁用
```

## localTriangleIndices 解包

```ts
a = packed & 0xff; b = (packed >>> 8) & 0xff; c = (packed >>> 16) & 0xff;
```

## fail-closed 检查清单(TS 加载器必须全部实现)

按 `dgc-format-spec.md` §校验链;最小集(不做的每一项都是漏洞):
magic/version/flags 白名单、`total_file_size` 锁定、段顺序合同、payload 越界、
CRC(至少 header 级)、counts 不变量、`source_*_count` 与 level 0 一致。

## 与编译器的互证路径(实现后接)

1. `geometry_dag build tests/fixtures/synthetic50k.obj out.dgc`(CLI,已在仓内);
2. TS 加载器读 `out.dgc`,与 `buildMeshletDag(loadObj(...), { levels: 4 })` 逐字段
   深比较(descriptors/bounds/parents 逐位,error 用 `Object.is`);
3. 对拍测试放 `packages/deep-engine/src/geometry/dgcLoader.test.ts`(fixture 用仓内
   `geometry_dag/test-output/synthetic50k.dgc` 的 sha256 钉版)。
