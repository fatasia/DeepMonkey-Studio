# DCIR v2 扩展设计稿（2026-09-20 凌晨，主线程）

状态：设计稿。实现排在 R4 万灯采样 / A3 GI 探针 compute / G7 体积 GPU 版三线共用时启动。
前置：DCIR v1（只读 storage buffer + buffer-load，`shaderCompute/`，HiZ 三方逐位认证）。

## 1. 为什么需要 v2

| 需求方 | v1 能力缺口 | v2 对应 op/资源 |
|---|---|---|
| G7 体积 GPU 版 | 3D 纹理读写、步进循环（动态次数）、多光源采样 | `texture-3d-load/store`、`loop-range`（定次循环，边界静态） |
| A3 GI 探针 compute | 探针网格读写、球谐系数更新、脏域 | storage read-write（f32 数组）、barrier-free 单 pass 更新 |
| R4 万灯采样 | 虚拟灯列表 buffer 读写、重要性采样随机数、时序复用 | buffer store、`hash-rng`（确定性伪随机 op） |
| R4 消费链二期 | scan 输出直接驱动 indirect 的字段写 | 部分 buffer store 已可由 v1 read-write 扩展覆盖 |

## 2. 确定性合同（延续 v0/v1，不放松）

- 循环只允许**静态次数**（编译期常量边界，如 fixed step count），禁 while/数据依赖退出；
- 归约定序：固定方向累加；浮点禁 min/max 之外的未定序原语；
- 随机数：`hash-rng` 用整数 hash（PCG 风格），种子来自 uniform+invocation id，逐位可复现；
- 3D 纹理：坐标量化 0.5°/1e-3 同族纪律；`-0→+0` canonicalize 全节点生效；
- GLSL 侧：SSBO/3D 纹理/WebGL2 缺失能力**整体 fail-closed**（WebGPU/Native 专用内核，不做静默降级）。

## 3. 落地顺序（建议）

1. `buffer store`（read-write storage，f32/u32）→ 解锁 R4 消费链二期与 A3 探针写入；
2. `loop-range`（静态定次）→ 体积步进与灯采样循环；
3. `texture-3d-load/store`（r32float，WebGPU/Native）→ G7 体积与 GI 探针体；
4. `hash-rng` → 重要性采样/时序复用。

每步：golden 测试（WGSL 文本 + IR hash）→ WebGPU/Native 双端逐位对照（复用 r2 harness）→ 消费点接一根真实管线 → 才算关闭。

## 4. 风险与边界

- wgpu 30 storage read-write 在 vertex 阶段不可用（仅 compute/fragment），R4 消费全在 compute，无影响；
- Native wgpu 与 Dawn 的 storage buffer 对齐默认值差异需在 binding 布局显式声明（`min_binding_size`）；
- GLSL 侧 v2 能力整体 absent：涉及 v2 op 的内核必须在内核元数据声明 `backend: ["wgsl"]`，v1 的 GLSL fail-closed 机制原样扩展。
