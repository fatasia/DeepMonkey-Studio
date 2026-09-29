# J2-B7-prep：Frame ABI 统一规格（方案 C schema codegen）

> 2026-09-29 用户拍板方案 C 并写进任务清单（`deliverables/research-20260928/剩余任务清单.md` §J2-B7）。
> 本文档是 prep 件交付物：逐字段双端布局证据、核心段/扩展带边界、schema 选型与 codegen/迁移设计。
> 纪律继承：不大统一强制两端布局相同（数据需求真实不同）；迁移排独立批次，期间新 frame 字段仍按过渡纪律"各宿主各自追加+登记 J4"。

## 1. 三端现状（逐字段，带行号证据）

### 1.1 TS 活渲染 frame — 96f / 384B

- 布局常量：`packages/deep-engine/src/webgpu/pipelines.ts:14-18`（`PBR_FRAME_UNIFORM_FLOATS = 96`、`PBR_FRAME_FLOAT_OFFSETS`）
- 打包写入：`packages/deep-engine/src/webgpu/pbrFrameUniforms.ts:85-90`（`frameData.set(outputData, 88)`）
- WGSL 镜像：`packages/deep-engine/src/webgpu/pbrShader.ts:20-25`（`struct Frame`）
- output 段类型：`packages/deep-engine/src/webgpu/pbrDisplayColorWgsl.ts:2`（`struct DeepOutputSettings`）

| f32 偏移 | 行 | 字段 | 语义 |
|---|---|---|---|
| 0–15 | 0–3 | currentViewProjection | 当前帧 VP |
| 16–31 | 4–7 | previousViewProjection | 运动矢量用上一帧 VP |
| 32–47 | 8–11 | worldToView | 世界→视空间 |
| 48–63 | 12–15 | lightViewProjection | 主光阴影矩阵 |
| 64 | 16 | eye | 相机世界位置（C4 camera-relative 后=相机原点相关量） |
| 68 | 17 | background | 背景色/模式 |
| 72 | 18 | floor | 地面参数 |
| 76 | 19 | lightDirection | 平行光方向 |
| 80 | 20 | tuning | 调参向量 |
| 84 | 21 | sunColor | 太阳色 |
| 88–95 | 22–23 | output (DeepOutputSettings) | 曝光/vignette/tonemap + 调色 temp/tint/contrast/saturation（pbrFrameUniforms.ts:85-89 逐分量证据） |

TS 侧局部灯/多阴影矩阵**不在 frame 内**——经独立 lighting/cluster 绑定（lighting/ 域文件），这是两端结构性差异的根源。

### 1.2 Rust native frame v8 — 596f / 2384B（149 行）

- 布局常量：`packages/deep-engine-native/src/mesh_abi.rs:22-36`（`FRAME_ABI_ID = "deep.native.frame.v8"`、`FRAME_UNIFORM_FLOATS = 60 + 16*16 + 16*16 + 4 + 16 + 4`、`FRAME_UNIFORM_BYTES = 2384` 断言在 `mesh_abi.rs:207`）
- 行写入语义：`packages/deep-engine-native/src/scene_lighting.rs:67/80/87`

| 行 | f32 偏移 | 段 | 证据 |
|---|---|---|---|
| 0–14 | 0–59 | 固定 7 成员前缀（60f）：FRAME_MEMBER_BYTE_OFFSETS `[0,64,128,144,160,176,192]` = 4+4+1+1+1+1+3 行 | mesh_abi.rs:31 |
| 15–78 | 60–315 | 16 局部灯 × 4 行：灯 i 起 `15 + i*4`；第 4 行 `18 + i*4` 为阴影记账（`[2]`=castShadow 槽位、`[3]`=near*far/(far−near)） | scene_lighting.rs:67,80,87 |
| 79–142 | 316–571 | 16 阴影视图矩阵 × 4 行 | mesh_abi.rs:25-26 注释 |
| 143 | 572 | 雾投影行（2288B 断言） | mesh_abi.rs:32 + test:209 |
| 144–147 | 576–591 | 16 灯软度标量（2304B 断言） | mesh_abi.rs:33 + test:210 |
| 148 | 592 | 雾剖面 | mesh_abi.rs:34 |

Rust 侧固定前缀 7 成员与 TS 11 成员**名字与数量都不同**：native 是"已发布 camera/material 前缀"口径，无 background/floor/tuning/output 段。

### 1.3 语义对照结论

| 语义族 | TS 活渲染 | Rust native | 共同消费？ |
|---|---|---|---|
| 相机组（VP/prevVP/worldToView/eye） | 0–67 | 前缀内（camera 行） | **是**（核心段） |
| 平行光组（lightVP/direction/sunColor） | 48–63,76,84 | 前缀内 | **是**（核心段） |
| 输出/调色组（exposure/tonemap/grading） | 88–95 | 无（native 出图走 wgpu 后处理链） | TS 专属 |
| 场景组（background/floor/tuning） | 68–83 | 无 | TS 专属 |
| 局部灯阵列/多阴影矩阵/软度/雾 | 不在 frame（独立绑定） | 15–148 行 | Rust 专属 |
| 雾（投影+剖面） | 无独立段 | 143,148 行 | Rust 专属（TS 雾走世界着色参数） |

## 2. 核心段与扩展带边界（方案 C 的"不强制同布局"落法）

- **核心段（core）**：相机组 + 平行光组。schema 中单一定义，双端产物必须同名同语义同 f32 序；字段级单测锁定（同输入双端摘要一致）。
- **扩展带（extension bands）**：
  - `host: "ts"`：output 段、background/floor/tuning；
  - `host: "rust"`：局部灯阵列、阴影矩阵带、软度行、雾投影/剖面。
  - 扩展带字段也进 schema（带 `hosts` 标注），实现"单一真源记录一切"，但 codegen 只在对应宿主产物里生成。
- 材质块 48f 零填充先例（G-1 修复，2baaae18）作为扩展带对齐哲学的参照：允许布局不同，禁止语义漂移无记录。

## 3. Schema 格式选型（结论：JSON schema 单源 + node codegen）

候选对比：

| 方案 | 优点 | 缺点 | 判定 |
|---|---|---|---|
| **JSON schema 单源** | Rust/TS/WGSL 三产物生成器只需 node 读 JSON；B1 式 checksum 门直接钉 schema 字节；无 ts-node 依赖 | 无类型推导，需 codegen 补 TS 类型 | **采纳** |
| TS 定义单源 | 类型即文档 | 生成器要跑 TS 运行时；Rust 侧多一道工具链 | 弃 |
| 手写三份+对拍测试（现状） | 零基建 | 每次新增字段三处手改，漂移持续加深（本任务要偿还的债） | 弃 |

- Schema 位置：`packages/deep-engine/frame-abi/frame-abi.schema.json`（两端消费方都在 deep-engine 家族，contracts 不掺和渲染布局）。
- 版本字段沿用 `deep.native.frame.v8` 命名口径，schema 内 `abiVersion` 显式登记。

## 4. Codegen 基建（J2-B7-codegen 件设计）

- 生成器：`scripts/generate-frame-abi.mjs`（对齐 `syncSharedWgsl.mjs` 先例，构建期跑，非运行时）。
- 三产物（全部带生成头注释 + schema sha256 指纹戳）：
  1. `packages/deep-engine/src/frameAbi/generated/frameLayout.ts` — FLOATS/BYTES/逐字段偏移常量 + 布局类型；
  2. `packages/deep-engine-native/src/frame_layout_generated.rs` — 对应 consts（include! 进 mesh_abi.rs 或 mod 引用）；
  3. `packages/deep-engine/src/frameAbi/generated/frameStructs.wgsl.ts` + `packages/deep-engine-native/wgsl/frame_structs.wgsl` — 两端 struct 文本（Rust 侧 include_str!，与 J2 单源 WGSL 机制同构）。
- **指纹门**：schema sha256 写死在产物头；三端各一条测试断言"指纹戳 == 当前 schema 哈希"，手改产物或 schema 未再生即红（照 B1 checksum 模式双端红绿验证）。

## 5. 迁移策略（J2-B7-migrate 件设计）

1. 先立字节门：TS 侧以 `pbrFrameUniforms.test.ts` 现有输入产 384B dump 固化 golden；Rust 侧 `FRAME_UNIFORM_BYTES=2384` 与 `scene_lighting` 行写入断言保持——迁移前后字节逐位不变是硬门。
2. 手写常量替换为生成产物（import 路径切换，语义零变化）；WGSL struct 文本切换为生成文本。
3. 既有渲染全量回归（webgpu 1566+）+ cargo 全量双绿。
4. 同输入双端 frame 布局摘要（J3 对拍口径）入 J5 门。

## 6. Adopt 纪律（J2-B7-adopt 件）

- 此后任何 frame 语义字段必须改 schema 再生成（J5 双端门检查产物指纹+schema 联动）；
- J4 能力清单与 schema 变更联动：新增宿主字段必须同时登记能力清单条目；
- 过渡纪律（"新字段各宿主各自追加"）自 migrate 合入起废止。

## 7. 验收对照（清单原文逐条）

| 件 | 清单验收 | 本设计落点 |
|---|---|---|
| prep | 规格评审通过；逐字段有文件行号证据 | 本文档 §1（全部带 file:line） |
| codegen | 三产物生成稳定；双端编译通过；指纹门双端红绿验证 | §4 |
| migrate | 同输入双端布局摘要一致；既有渲染测试零回归；新增字段只改 schema | §5（字节门先行） |
| adopt | J5 双端门强制 schema 纪律 | §6 |

## 8. 现状核查声明（工作区六步纪律）

- 全仓 grep `FrameUniforms/frame ABI`：三端真源唯二（TS pipelines.ts + Rust mesh_abi.rs），无第三套实现；`pbrFrameUniforms.ts` 是 TS 打包器、`scene_lighting.rs` 是 Rust 写入器，均为消费方非第二真源。
- 依赖：无新增外部依赖（node:crypto/schema fs 均内置）。
- 消费方：TS frame 消费 = webgpu 全管线组（96f 绑定组 0）；Rust frame 消费 = native 前向管线（2384B UBO，规避 16KiB 限制绰绰有余）。
- 测试现状：`pbrFrameUniforms.test.ts`、`mesh_abi.rs tests`（2384 断言）已存在，字节门可直接挂靠。
- 冲突域：本任务只碰 frameAbi/generated 新文件 + 两端常量替换；不碰 lighting/（C2 在跑）、pbrTimedPassIds（B4 追加权）、contracts、apps/**。Rust cargo 串行由主线程独占（当前六路皆 TS）。
