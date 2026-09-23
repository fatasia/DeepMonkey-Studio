# Deep Monkey Studio 收口交接（2026-09-23）

> 本文是当前工作区的收口交接，不等同于 V5 正式发布放行。Parasolid/X_T 工业格式 F7 按用户指令排除，不恢复。

## 一、已完成且有真实消费者/测试或证据

### F 组

- **F1/F2 动态 GI 与 RT**：场景辐射 producer、环境读回、能量/历史约束、RT BLAS/TLAS 驻留、RT fragment 消费、RT/栅格像素对拍 99.883%；设备恢复与无 RT 回退证据已完成。Native lib/bin 多轮全绿。
- **F3 探针 GI**：96B ABI → storage/bind → 最近探针 → 网格头 → 三线性 8-tap → 多层级联（细/次粗两层混合，Web smoothstep 1.5 格语义）→ CPU 对拍 → 真机 GPU 像素证据 → Web 打包器 → 运行包载荷 → Native init → UI 烘焙入口/发布会话态。GPU 烘焙 2×2×2 真机 gate TRUE：8/8 覆盖，GPU/CPU 最差差值 2.33e-4，两次 bake JSON 逐位一致。多层载荷 v2 双形态合同已落地。
- **F4**：逐字段矩阵 6 域 53 行；3 处静默丢失已修复：作者六通道分级随 v9 运行包贯通、spot shadowSoftness 显式 degraded、environmentIntensity 非 1 fail-closed。author-grading 旧 EXE 拒/新 EXE 接受+GPU 逐位证据。
- **F5**：Deep2D select-v1/文本输入/视频/UIA、看板多选、IME 组合输入、触控 Touch 与鼠标统一链、Web 音轨策略、Native 音轨探测。Native 真实 WASAPI/MF 出声和音画同步**明确放弃/保留 blocker**：`audio-output` fail-closed，不伪装支持。
- **F6**：`packages/deep-engine/src/host.ts` 五主题 facade + `./host` 发布子入口 + smoke；viewerEngineInteraction 动画控制域拆分且公开 API 不变；仓外 Node/Browser 独立消费示例离线安装链通过；plugin-runtime compatibilityMatrix 公开导出与并发/失败重试/能力缺失 fail-closed 测试 40/40。

### I 组

- I2 能力驱动显隐：发布查看器按快照编译字段隐藏 clipping，未冒用对象级 `degradedCapabilities` 清单；I5 AI 模型目录、失败切换、reasoning effort、上下文预算、checkpoint 恢复闭环；I6 SDK 文档与可运行示例已同步。
- I3 六项全部清零：样条分段、固定 seed、门位、贴地投影、坡度边界、T/十字等宽 junction 盖板、道路 fixed 分段 cuboid 碰撞接入；junction/碰撞边界已明确。
- I4 图层/多选/组织面板与统一选择语义已落地。I1 既有材质/灯光/后处理/GI/烘焙等面板链已接入，F4 矩阵补证。

### V 组

- **V1**：三端冻结 box runner 首轮 3/3 端真实加载/8 帧/包 hash/GPU clean；逐像素 SSIM 与输入轨迹基线已建立。Web vs WebView SSIM 0.9944/0.9986；Web vs Native 原始 0.4037/0.4091，线性校准后 0.4854/0.4838；只建立基线，不判画质胜负。
- **V2**：Native release EXE 三路真实窗口验证、portable 包、GPU clean、dashboard 错入口 fail-closed；dashboard 空场景 occlusion 挂起已修为快速拒绝，正式 `.dmda` 链可用。
- **V3**：Unity 6000.0.52f1 WebGL 真实 batchmode 构建，加载/材质/输入/资源/发布 5/5 PASS；SwiftShader 口径，Unity 控制台上传链未覆盖。
- **V4**：a01x Babylon 既有配对轨道已复用；适配层与聚合器完成，短跑内存/长稳出数：peak-host 1033.2MB、mean-host 953.8MB、Deep P99 4.90ms、Babylon P99 4.70ms。Babylon visual similarity 中位 0.8376 < 0.92，结果 invalid/withheld，不宣称领先。

## 二、最近聚焦门禁

- plugin-runtime：vitest 40/40，tsc 0。
- Web dashboardMedia/docs：23/23，tsc 0。
- deep-engine host/runtime/lighting/bake：本轮 227/0（5 skipped），tsc 0。
- Native 最近稳定基线：lib 542/0、bin 275/0；并行 Native 工作树有未提交改动，不能把当前树直接当最终发布树。
- V5 预检：12 PASS / 5 PARTIAL / 3 SKIP / 0 FAIL。正式最终门禁尚未宣称完成。

## 三、剩余任务（按优先级）

1. **V5 正式终验**：冻结并行工作树后，统一跑 Web/API/deep-engine/contracts/Native typecheck、全量测试、正式构建、离线启动、回滚、视觉/双主题/多分辨率、a11y、故障注入；当前 `docs/specs/v5-preflight-2026-09-23.md` 是预检，不是放行。
2. **V4 正式基准**：按 BENCH v2 合同跑 30 分钟长稳、输入延迟、GPU 时间戳/内存完备度；Babylon 视觉相似度先解决 0.8376<0.92 的合同抑制，不得用降画质绕过。
3. **Native 音频**：用户已决定放弃当前阶段真实音频输出；保留 `audio-output` fail-closed，未来若重启需单独设计 WASAPI/MF 输出与音画同步，不在本轮补丁式引入。
4. **F3 后续边界**：距离/方差供给、级联多层烘焙编排、UI 真机点击→GPU bake→包字段全链取证；基础烘焙链已完成。
5. **V1/V2 边界**：逐像素基线已建立但不判胜负；WebView 需用冻结 publication 重打包后再做同内容 EXE 复验；Native/浏览器曝光差异仍需统一色调映射后再讨论视觉阈值。
6. **F5 明确边界**：Native 真实音频出声放弃；触控真实硬件、IME 候选窗人工视觉、Web 无头真实音频解码仍未验。

## 四、并行工作区纪律

- 当前工作区存在 Native/V5/F4 等并行未提交改动及 `.tmp-*`、`scripts/benchmarks/babylon-web/` 留置文件；接手者不得 reset/clean/checkout，也不得把这些文件整批加入提交。
- 任何新切片必须先查本文、`deep-monkey-remaining-work-handoff-2026-09-22.md`、`engine-capability-expansion-plan-2026-09-22.md` 和最新台账，发现已有真实消费者立即复用。
- 正式终验前先按文件归属分批收口并复跑门禁；未验证项继续以未验证呈现，不把预检当终验。
