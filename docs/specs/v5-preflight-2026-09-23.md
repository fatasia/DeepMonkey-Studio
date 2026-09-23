# V5 全量门禁预检（2026-09-23）

> 这是预检，不是最终发布放行。所有结论都引用实际命令或已有实证；未执行项明确列为 SKIP。自研 WebGPU/Native XR 不在 V5 范围内；仅验证现有 Three WebGL + WebXR 不回归。

| 维度 | 状态 | 真实命令/证据 | 结论 |
|---|---|---|---|
| Web TypeScript | PASS | `pnpm exec tsc --noEmit -p apps/web` | 最近多轮均为 0 错误 |
| API tests | PASS | `apps/api` vitest 全量既有报告 | 235 文件/1538 测试通过 |
| deep-engine tests | PASS | `packages/deep-engine` vitest 全量既有报告 | 3935 通过/0 失败 |
| contracts tests | PASS | contracts vitest 全量既有报告 | 340 通过/0 失败 |
| Native lib | PASS | `cargo test --lib --no-fail-fast` + `cargo check` | 543 passed / 0 failed / 1 ignored；音频探测与容器校验已包含 |
| Native bin | PARTIAL（定向媒体集成已复跑） | `cargo test --test dashboard_video_media_foundation --no-fail-fast` | 5 passed / 1 ignored；全量 bin 与正式 EXE 仍待终验 |
| plugin-runtime | PASS | `pnpm exec vitest run --no-cache` | F6 收口后 40/40，tsc 0 |
| source-size | PASS/存量 | `pnpm quality:source-size` | 6009 文件通过；另有 Native 800/300 行存量告警，非本轮新增 |
| V1 三端 | PASS（首轮） | `npx tsx scripts/verify-v1-tri-endpoint-matrix.mts` | 3/3 端，8/8 帧，hash/GPU clean；另有 SSIM+轨迹基线 |
| V2 Native release | PASS（首轮） | `verify-scene-native-window.mjs` + release/portable evidence | 三路实窗验证通过；dashboard 错入口已 fail-closed |
| V3 Unity WebGL | PASS（首轮） | `npx tsx scripts/verify-v3-unity-webgl-e2e.mts` | Unity 6000.0.52f1，加载/材质/输入/资源/发布 5/5 |
| V4 benchmark | PARTIAL | a01x evidence + `a01x-paired-adapter.mjs` + `paired-summary.mjs` | 结构/适配/内存短跑/P99 有证；正式 30min 未跑，Babylon visual 0.8376<0.92，排名 withheld |
| V5 formal build | PARTIAL | V2 release evidence、V3 Unity build evidence | Native/Web/Unity 局部正式构建有证，最终统一重建未执行 |
| Visual regression | SKIP | 需真实浏览器/双主题/多分辨率全矩阵 | 局部 headless/截图证据存在，未跑全矩阵 |
| Fault injection | PARTIAL | Native RT fallback/device recovery/occlusion fail-closed tests | Native 关键路径有证，Web/API/发布回滚统一矩阵未完成 |
| Accessibility | SKIP | 无统一可复跑全站 a11y 命令 | 局部组件语义测试存在，未形成全站证据 |
| Offline startup | PASS（局部） | F6 npm offline + Native portable/V2 evidence | Node/Browser 离线安装与 Native portable 有证，Three 完整下载链未重验 |
| Publish rollback | PARTIAL | Native LKG/发布依赖路由/场景冻结测试 | 局部回滚与冻结包有证，V1-V5 总回滚矩阵未执行 |

## 最终全量验证门禁（V5 发布前必须全部通过）

预检通过不等于发布通过。最后一个验证阶段必须以冻结工作树和同一版本产物为输入，完成下面所有类别；任一类别缺证据、出现失败或只跑局部，都不得标记 V5 完成。

| 类别 | 必须覆盖 | 放行条件 |
|---|---|---|
| 构建与合同 | Web/API/contracts/deep-engine/plugin-runtime 全量 typecheck、Vitest；Native lib/bin/integration、fmt、clippy、release EXE；运行包 schema、hash、旧包兼容 | 0 编译错误、0 测试失败；允许的 ignored、既有 warning 和明确存量告警单独列出 |
| 性能与稳定性 | WebGPU/WebGL/Native 三端固定场景；CPU/GPU 帧时、内存、资源上传、首帧、P50/P95/P99；30 分钟长稳、窗口 resize、设备丢失恢复、连续播放/seek | 各端达到规格中的帧预算和内存预算；无持续增长、无未回收资源、无 GPU/控制台错误；长稳期间交互与画面不漂移 |
| UI 与视觉 | 深色/浅色主题、1920 基准及窄窗/高 DPI、多分辨率、响应式裁切、a11y、关键页面截图、三维编辑器属性面板 | 关键页面无截断/重叠/空白；视觉基线在既定阈值内；键盘焦点、语义、对比度和 reduced-motion 检查通过 |
| 交互与连贯性 | 鼠标、触控、键盘、IME、拖拽、选择/钻取、相机导航、时间线、物理/导航、粒子告警、音视频播放暂停音量 seek | 确定性轨迹可重放；状态变化、撤销/重做、保存/重开、发布/预览前后一致；无卡死、竞态、重复触发或丢输入 |
| 跨端与媒体 | WebGPU↔WebGL↔WebView↔Native 的同场景加载、颜色/相机/资源语义、MP4/AAC、静音/有声、默认设备与恢复 | 已实现能力结果一致；降级字段和原因码一致；媒体音画同步与错误提示有真实证据 |
| 故障与发布 | API 断连、坏包/篡改、资源缺失、设备不支持、GPU reset、取消/重试、LKG 回滚、离线启动、增量包等价性 | 失败均 fail-closed 且保留旧可用状态；恢复、回滚和重新发布可重复；离线包不访问外网 |

最终证据目录必须同时保存命令、版本/commit、设备与浏览器矩阵、原始日志、截图/视频、性能 JSON、失败复现和结论。未取得真实设备或正式 EXE 证据的项目继续保持 PARTIAL/未验证，不用局部单测替代。

## 计数

- PASS：11
- PARTIAL：5
- SKIP：2
- FAIL：0（本预检没有把未执行项伪装成失败）

## 真实剩余阻塞

1. V4 正式 30 分钟长稳与四对手完整指标合同；
2. V5 最终统一构建/视觉/双主题多分辨率/a11y/故障注入/回滚矩阵；
3. Native 音频代码已接入 MP4/AAC + rodio；默认设备、EXE 出声和音画同步证据仍是发布前 blocker；
4. V1 逐像素已建立基线，但不设置胜负线；
5. 并行工作树中存在 Native 既有改动，正式终验前需先冻结/分批收口，不能直接把当前树当发布树。
6. 自研 XR 不再排队；V5 只对现有 Three WebGL + WebXR 做回归检查，不为 Deep WebGPU/Native XR 增加实现或验证分母。
