# geometry_dag 交接记录(Nanite M2 子 A:Rust 离线编译工具链)

> 2026-10-04 完成。本刀为 `docs/specs/ue-class-b2-task-briefs-20261004.md` Brief-Nanite
> 第 1 条(离线工具)的 Rust 域交付。

## 已完成

1. **黄金对拍全绿**:Rust 实现与 TS 权威实现(`buildMeshlets`/`buildMeshletDag`)在
   `tests/fixtures/{quick_sphere(528 tris,2 层), synthetic50k(49500 tris,4 层)}.golden.json`
   上**逐位一致**(positions/indices/descriptors/vertexRemap/localTriangleIndices/bounds/
   sourceTriangles/clusterSourceSpans/error f64 bits/parentsByLevel)。
   fixture 由 `scripts/gen_fixture.mjs` 从 `dist/geometry` 导出。
2. **完整编译管线**:OBJ 解析 → 贪心簇划分 → 逐层聚类简化 DAG(父子单射投票)→
   `.dgc` 流式格式(64B 文件头 + 88B 段头 × N + 8 对齐 payload + 逐段 CRC32C + zlib)。
3. **CLI**:`geometry_dag build|info|verify`(`src/bin/geometry_dag.rs`)。
4. **测试**:61 项全绿(lib 53 + CLI 参数 4 + golden 3 + doc 1),debug 与 release
   双模式;clippy `--all-targets` 零警告(含 `--features dbg_dropped` 配置)。
5. **性能**(release,998K 三角形):全 DAG 编译 **140.7ms(≈7.1M tri/s)**,
   纯簇划分 78.6ms,.dgc 序列化(zlib-6)1.2s。远优于"数秒"预算。

## 关键实现语义(对拍踩坑实录,改 TS 行为前必读)

1. **V8 Math.hypot 是 max 缩放算法**(`src/builtins/math.tq`):`max·sqrt(Σ(x/max)²)`,
   不是嵌套 hypot 也不是裸 sqrt(x²+y²+z²)。法向锥轴和值跨零时任何 1ulp 差异都会
   翻转符号(quick_sphere 全过、synthetic50k 单字段翻符号的实证)。`bounds.rs::js_hypot`。
2. **TS `clusterSimplify` 第四遍的面积判定用 f64 代表点**(未截断的 JS number 数组),
   `Float32Array.from` 只发生在函数返回;`simplify.rs` 因此维护 f64/f32 双表。
3. **TS 去重键不是排序序**:`!(a<b) && b<c` 分支无条件给 `${b}_${c}_${a}`,当 a<c 时
   非排序((242,240,274)→"240_274_242" 与 (274,240,242)→"240_242_274" 排序同键、
   字符串异键)→ 权威 golden 的去重比"完美排序去重"**多保留**某些面。
   `simplify.rs::ts_dedup_key` 逐字复刻,**不得"修正"为排序**。
4. **DAG 层簇三角形缺省 64**(`MeshletDagOptions`),非 buildMeshlets 的 126。
   `dag.rs::build_meshlet_dag` 在入口落定缺省。
5. 无覆盖细簇的父哨兵:TS `-1`(Int32),Rust/`.dgc` `0xFFFFFFFF`(`NO_PARENT`)。

## 下一步(本刀范围外)

1. **TS 侧加载器**:合同见 `docs/ts-loader-contract.md`(现 `packages/deep-engine`
   无 `.dgc` 读取器;结构与其 `MeshletDag` 同构,消费面零换算)。
2. Brief-Nanite 第 2 条运行时(DGC 资源槽/页调度/簇剔除/indirect 分组)。
3. QEM(Quadric)误差场替换聚类误差(TS 注释已声明"M2 计划,接口不变")。
4. `.dgc` 大资产分块流式(当前单文件;F3 页调度接入时需要按段驻留)。

## 运行方式

```bash
cd packages/deep-engine-native/geometry_dag
node scripts/gen_fixture.mjs            # 重新生成 golden(需先构建 deep-engine dist)
cargo test --offline                    # 全量测试
cargo test --release --test perf -- --ignored --nocapture   # 性能基线
cargo run --offline --release -- build tests/fixtures/synthetic50k.obj out.dgc
```
