# C8 双后端统一着色器首刀

C8 首刀统一输出色彩库的选择接口，并用真实 WebGPU / WebGL2 浮点读回约束 WGSL / GLSL 数值漂移。compute 沿用 DCIR，surface 不另建 IR。本刀是可运行 POC，不代表完整材质与渲染器跨后端迁移完成。

## 现状核查

2026-09-30 核查源代码、未跟踪文件、契约、依赖、消费方、测试证据和规格。交接 `docs/handoffs/gpt-handoff-20260930.md` 将 C8 记为无产出；本批实现与证据补齐后按实际范围更新。

| 核查项 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源代码与未跟踪文件 | `shaderCompute/{types,kernel,emitWgsl,emitGlsl}.ts`；`shader/{types,compiler}.ts`；J2-B2 三份 WGSL 草稿 | surface 输出色彩库缺双语言选择接口与实机数值门 |
| 契约 | DCIR 已含类型化 DAG、uniform、texture / buffer、guard、哈希与后端能力边界；surface 已含 vec3 / 矩阵、阶段、资源、状态与关键字合同 | DCIR 数学白名单尚不能直接表达色彩库；contracts 无既有显示色彩双端库合同。本刀包内导出，不复制底层类型 |
| 依赖 | Three.js 0.185.1、esbuild 0.28.1、Chrome / playwright-core；native wgpu 30.0.1 | POC 无依赖缺口，不新增运行依赖 |
| 消费方 | `webgpu/hiZPyramidReduceKernels.ts` 使用 DCIR；`lab/r2ShaderIrProbe.ts` / `r4HiZWiringProbe.ts` 已发射两语言；PBR 输出与直出使用显示色彩 WGSL | C8 新选择器由 `lab/displayBackendParityProbe.ts` 消费；GLSL 当前为探针 POC，尚未接产品 WebGL 材质链 |
| 测试与证据 | DCIR HiZ、buffer、subgroup 单测与三端 GPU 探针；`test-output/native-hiz-20260920-r1`；J2-B2 单源 checksum 门；`scripts/lib/pixelParity.mjs` | 首刀需补源身份 / 缓存边界测试及可拦截真实坏输出的负例 |
| 规格 | `docs/specs/interrupted-engine-tasks-20260930.md`；交接 C8 允许双真源 + 漂移门路线 | 本文补三路线取舍、推广标准与 POC 验证范围 |

## 三路线取舍

| 路线 | 成本与收益 | 判断 |
|---|---|---|
| A：复用 DCIR 扩 surface | 可共用确定性展开、哈希、能力检查和既有两语言发射器。需要扩 vec3 / mat3、浮点算术、pow / log2 / exp2、函数调用与 surface ABI；现有 compute 的 texture、workgroup、guard 不能直接作为 fragment 入口合同。还需维持 HiZ / buffer / subgroup 回归 | 中期适合高复用数学核。当前小型色彩库不足以证明扩大白名单与宿主适配的收益，本刀不扩 IR |
| B：WGSL 权威 + GLSL 成对实现 + 数值漂移门 | 保留生产 WGSL、共享输出设置与数学语义；GLSL 同公式。源摘要定位版本，真实浮点 target 逐通道比较，不以文本相似证明等价。一次加载缓存，选择后端无每帧编译 / 哈希 | 当前采用。维护双语言成本局限在显示色彩库；改任一源必须跑 GPU 门，不能用刷新 snapshot 放过漂移 |
| C：离线转译（Naga / TSL） | Naga 接受 WGSL 并输出 GLSL ES 300+；可在构建期产出镜像。TSL 基于 Three.js 节点系统，可向 WGSL / GLSL 编译；需要把函数与输出宿主换成对应节点/renderer 语义。两者都需验证绑定映射、入口、精度与真实 target 行为 | 保留为后续对比实验。固定工具版本、离线产物、无新运行依赖是进入条件；本刀不安装转译工具，不引入 Three.js 到引擎运行路径 |

Naga 的 GLSL 输出属于次级支持，GLSL 输入仅覆盖 GLSL 440+ / Vulkan 语义；不能据此认定现有 GLSL ES 源可双向无损转换。[Naga 官方 README](https://github.com/gfx-rs/wgpu/blob/trunk/naga/README.md)。TSL 的双端能力建立在节点系统和 renderer 后端上，移植成本需按实际宿主评估。[TSL 官方指南](https://threejs.org/tsl/)、[WebGPURenderer 官方说明](https://threejs.org/manual/pages/webgpurenderer)。上述页面于 2026-09-30 核查；仓内 Three.js 固定 r185，不能把在线 r186 文档当成本机能力证据。

成本为基于现有代码边界的工程判断，未做 A / C 全量迁移或性能实验。

## 首刀范围与接口

- `wgsl/displayColor.wgsl` 是生产 WGSL 权威，J2-B2 同步器生成 TS 镜像与 sidecar。
- `src/shader/displayColorGlsl.ts` 是同语义 GLSL ES 300 库，包含 ACES 两档、曝光、temperature / tint、contrast / saturation 与 linear → sRGB。
- `displayColorLibrary("webgpu" | "native-wgpu" | "glsl-es-300")` 返回冻结的 `{ language, code, sourceHash, entryFunction }`。两种 wgpu 宿主共享同一 WGSL 对象；GLSL 分支选择语言目标，纯库无需 WebGL 宿主。未知后端及 `webgl2` 宿主别名报错。
- 返回的是函数库；texture、uniform / bind group、vertex / fragment 入口由宿主组成。`native-wgpu` 选择器不表示 native 生产端已消费全部色彩设置。
- 不改用户参数范围，不强制只用某个后端。后端能力与数值门服务于结果质量和排障；高级配置与脚本仍由用户选择。

冷加载计算两份摘要，后续只选已有对象。首刀未改生产帧循环，也未测得吞吐提升；不写性能提升百分比。

## 数值门与证据

统一 fixture：`packages/deep-engine/fixtures/display-parity-v1.json`。禁止事后按结果调阈值、曝光拟合、重采样或白名单兜底。

| 比较 | 输入与目标 | 预注册阈值 | 当前结果 |
|---|---|---|---|
| C8 色彩库 WebGPU / WebGL2 | 32×32，8 色条，4 组曝光 / tone mapping / grading，RGBA32F，逐通道读回 | 最大绝对浮点差 ≤ 0.00002；非有限 / 坏尺寸拒绝，不能用两个全黑输出过门 | 两轮最大差 1.1920928955078125e-7 |
| J3 Gate D 生产输出共同子集 WebGPU / native wgpu | 同一线性 HDR 色条，生产 output shader；native 固有 Narkowicz、中性曝光 / grading，RGBA8UNORM | 最大通道字节差 ≤ 1；8×8 分块最低 SSIM ≥ 0.999；有效非黑像素超过一半 | 两轮最大字节差 0；最低 SSIM 1；非黑像素 896 / 1024 |

运行命令：`node scripts/j3-display-parity.mjs`。证据目录：`test-output/interrupted-0930/display-parity/`，包含 `evidence.json`、原始双端输出、native 日志与两轮截图。两轮原始输出稳定、GPU error 为空。

native 经实际 `OutputPass` 分别渲染各个 HDR 色块，取每个色块读回首像素组成共同色条；本刀曝光 / grading 中性且关闭空间效果，因此只验证逐像素输出公式。浏览器直接读取同色条纹理。它不是整场景 RenderPacket 黄金包对拍。

`RGBA8UNORM` 至多一档量化差是唯一登记的合法差异。几何、深度、阴影、bloom、fog、SSR、TAA 与 native 非中性色彩设置均不在本门认证范围。C8 库四设置覆盖不能替代 native 生产端四设置认证。

8 色条覆盖黑、低亮度、灰、白、彩色与 HDR，4 设置覆盖 ACES 两支及中性 / 非中性 grading，足够本刀基础 POC。每行重复，不能发现行翻转；源输入在 0.0031308 附近不等于 tone mapping 后正好落在线性 → sRGB 分界。它也不能证明超亮 / 负输入 / 全参数边界或两源同方向错误的正确性。上述缺口在扩大范围时补独立参考点与非对称二维输入，不把首刀升级成新编译器工程。

## 推广标准

下一家族只在已存在真实两端消费方时推广；先补缺口，再判断 A / B / C。满足以下条件后才扩大认证范围：

1. 明确权威源、同语义参数、ABI、资源与能力差异；禁止把功能缺席写成合法画面差异。
2. 每条公开分支与参数边界有真实 GPU 对拍；加入非对称二维输入、色域极值和独立期望点，以区分翻转、共同错误与局部色偏。
3. 负例能拒绝坏尺寸、非有限、全黑、单通道色偏、alpha 漂移、局部 SSIM 失败与超容差。两端同时黑仍应失败。
4. 双轮稳定、摘要可追溯，生产消费链可定位；新增编译 / 资源步骤在创建或更新阶段完成，帧期无编译、字符串拼接或哈希。
5. 选择 A 或 C 前，先用同一 fixture 与两端宿主验证、测冷构建及热路径；若只减少源码行数却增加宿主耦合或运行成本，则继续 B。

## 验收记录

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run src/shader/displayColorBackends.test.ts`（`packages/deep-engine/`） | 12 / 12 通过：WGSL 权威身份、独立 SHA-256、GLSL 语言目标选择、冻结缓存、未知后端与 WebGL 宿主别名拒绝 |
| `node --test scripts/j3DisplayParity.test.mjs` | 13 / 13 通过：尺寸、全黑、有效像素边界、单通道色偏、alpha、局部最低 SSIM、异常字节、浮点非有限与容差边界 |
| `pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.lab.json`（`packages/deep-engine/`） | core / lab 均通过 |

审核发现 `compareDisplayLibraries` 曾允许全黑对全黑通过；主线补入两端有效 RGB 像素超过一半的判据，上述负例已证实拒绝，alpha=1 不能掩盖黑帧。

C8 最初使用 `webgl2` 作为纯库选择别名，触发既有 `runtimePurityPolicy` 的 WebGL 宿主字符串禁令；已改为语言目标 `glsl-es-300`。浏览器 lab 的 WebGL2 编译 / 浮点读回保持原样，purity policy 保持原样。

按既有 policy 扫描 928 份 TypeScript 运行源：C8 无错误，剩余五处 `performance` 错误均在 HEAD `a4c12e100250dcfc4ed1a31fac2295ccc37a6c17` 复现。`pipelineCache.ts` 为 100:17、100:55、101:7；`virtualTextureFrameBridge.ts` 为 167:19、194:59。两文件工作树与 HEAD 的 LF 归一化 SHA-256 相同；证据见 `test-output/interrupted-0930/c8-runtime-purity-baseline.json`。该检查只执行 TypeScript policy，不等于完整 runtime purity gate 通过。

已加载 `design-taste-digitaltwin`，本刀对标 Unity / Three.js 输出色彩一致性。GPU 双轮与截图已由主线生成，审查已目视浏览器第 1 轮与 native 第 2 轮色条一致。产品视觉体验认证需实际场景截图，本次数值探针仅记录色条一致性。
