# Deep Monkey Studio 极致交付最终阶段报告

日期：2026-09-21  
分支：`dev-studio`  
基线：`6699892`  
当前最新本地提交：以工作树最新提交为准，**未 push**。

> **2026-09-22 复盘说明**：本文是 9 月 21 日阶段快照，不再作为当前完成度依据。其第 5、6 节中的 300 行门禁、LPAC 环境限制、Array texture 外部消费等结论已有后续变化：当前统一源码门禁为 800 行且 5924 个源文件通过；LPAC 静态 CRT 路径已通过；独立 Deep Engine SDK 与 Array texture 的仓外消费和真实 WebGPU 证据已补齐。当前权威状态以 [`active-task-recovery-ledger.md`](../active-task-recovery-ledger.md)、[`deep-rendering-closure-audit-2026-09-22.md`](deep-rendering-closure-audit-2026-09-22.md) 和文档中心的“引擎性能与画质基准”为准。动态 GI 的真实一跳辐射、多反弹 GI、正式光追消费者、Native 自动遮挡、三端最终打包与同画质配对基准仍未完成，不能从本文标题推断为全部交付完成。完整后处理系统、完整材质系统与 Shader 系统只做价值/成本评估，不属于本轮实现范围。

## 1. 最终结论

本轮已完成并固化：

- R12 GPU readback / Source Map / Studio 诊断入口
- MCP 草稿镜像、浏览器写事务、诊断快照目录与字节按需拉取
- Native annotation frame-aware v2 持久化
- R10 Native 动画状态机宿主
- P5/P7 空间分析与 QTO 规则持久化、定位回跳
- XR 会话健壮性、select/squeeze 输入、能力分级与 UI 说明
- 自适应画质 shadow/residency 预算接线
- R1 ProbeClipmap 正式 PBR 生命周期接入与 relocation 更新侧闭环
- GPU-driven / meshlet / cluster LOD 合同、真机选层与间接计划
- RayBackend CPU 参考、WGSL 软件光追、TLAS 两级实例追踪、SSR/软阴影/probe 三个消费者合同
- Nanite 路线的 visibility buffer、软光栅 CPU/WGSL 路径
- Native 真多线程级联阴影 command encoding
- bindless 级 1 Web texture array 双轨合同与 bindless 级 2 Native identityGolden
- DeepMonkey 品牌全局替换、登录页布局、多行副标题、性能/运行状态设置页搬迁
- 批次 E A/B/C/D 验收证据
- 批次 F 启动证据、P50/P95/P99 统一统计、bundle budget 与全量门禁 runner

在用户要求的主战场上（Native 引擎、打包客户端、开放世界能力），核心路线已经形成可验证的工程闭环。仍有少数门禁边界与后续真机视觉/性能证据需要单独补齐，见第 7 节。

## 2. 关键工程成果

### 2.1 RayBackend / Lumen 等效路线

- CPU BVH：中位数分裂、显式 `rightChild`、Möller–Trumbore、栈式遍历。
- WGSL 软件 RayBackend：真实 WebGPU dispatch→readback，Chrome 153 + NVIDIA 真机通过。
- TLAS→BLAS 两级追踪：实例 mask、world→local 仿射、方向缩放 t 修正、多 BLAS 全局缓冲布局。
- 真实 GPU 证据：
  - 单 BLAS：fan、轴平行、tMax、单三角等案例通过。
  - TLAS：近远实例、平移、缩放、mask 过滤等 9 案例通过。
  - t 相对误差约 `1e-7` 至 `1e-6`，符合 f32 量化预期。
- 消费者：SSR 屏外反射、聚光软阴影、probe 遮挡射线合同完成；SSR/probe 具备真机消费者证据，软阴影视觉整帧证据后置批次 F。

### 2.2 Nanite 路线

- cluster LOD DAG 合同与 CPU deterministic bake。
- GPU 屏幕误差选层：近距细层、远距粗层、混合 frontier、阈值单调扫描真机通过。
- visibility buffer：`rg32uint`，slot + triangleLocalIndex 位布局，默认关闭、透明/动态/骨骼 forward 回退。
- 软光栅：CPU 参考与 WGSL kernel 双路径；修复了真实 GPU 暴露的 `isFinite`、WGSL 保留字、uniform/storage 声明和 z-test 竞态。最终改为两阶段 `atomicMin` 深度键→确定性回写。
- 真机软光栅：8 个固定案例全通过，slot/packed/depth 与 CPU 逐像素一致，最大相对深度误差约 `1.5e-7`。

### 2.3 Native 多核

- Native 不再以 Promise 冒充并行。
- 级联阴影按 cascade 作为独立编码单元，使用 scoped executor 线程并行，固定节点序收集、错误取消与 panic 转失败。
- CPU 证据：8 单元，4 executor 加速 `3.39x–3.71x`。
- GPU 证据：RTX 4060 Vulkan，串行/并行/时间戳路由三级深度读回约 6700 万字节逐位一致。
- 小 fixture GPU encode wall-clock 只有 `0.74x–0.81x`，如实记录线程派发开销交叉点；重场景才预期获益。

### 2.4 Bindless / 纹理数组

- Web 级 1：按格式×宽×高分箱，字典序分配 array layer，超设备上限显式 overflow 回退。
- 默认关闭：现有 shader 字符串逐字节不变。
- Native 级 2：同一索引合同、固定 golden fixture、Rust 逐值比对；Native wgpu texture array 绑定合同已就位。
- 尚未把数组绑定接入全部生产 PBR pipeline；这是后续正式接线/真机性能证据项，而不是假装已完成。

## 3. 批次 E 客户端验收

证据目录：`test-output/batch-e-20260921-r1/`、`test-output/batch-e-20260921-r2/`。

### A 组：历史失败重放

- A1 缺 EXE：PASS
- A2 长时间无反馈：PASS；Deep Native 首帧约 `680–733ms`，WebView 约 `3.1s`
- A3 云 Worker/token 误依赖：PASS；进程树外连审计为 0
- A4 悬空引用：PASS；精确提示
- A5 控制台窗口：首轮 FAIL，已修复；产物级复验 PASS
  - 修复：Tauri release `windows_subsystem="windows"`
  - PE 子系统由 `CONSOLE(3)` 变为 `GUI(2)`
  - 控制台窗口差分 0，无 conhost/OpenConsole/WindowsTerminal
- A6 重复开关/双标题栏/崩溃：PASS
- A7 980×700 / 1200×800 缩放：PASS
- A8 缺失依赖/篡改包诊断：PASS

附带 A4 遮挡缺陷也已修复：发布头栏 fixed 浮层占用 56px 内容让位，1440×900 与 1200×800 产物级探测 `overlap=0`，三点 `elementFromPoint` 全命中内容组件，返回导航真实可点击。

### B 组：真实功能操作

22 项：`17 pass / 4 by-design-unavailable / 1 observed / 0 fail`。

通过项包括：

- 旋转：像素差分约 271,640（58.11%）
- 缩放：像素差分约 99,192
- 平移：像素差分约 173,807
- 拾取选择：OutlinePass 轮廓出现/消失
- 显隐：隐藏后蓝像素降为 0，显示后近乎完全恢复
- 图表 hover tooltip、图表点击、总览↔详情往返
- Tab 焦点、Enter/Space 激活

4 项 by-design-unavailable 是只读发布页不提供的编辑能力；1 项双击悬空页时序被记录为 observed，没有伪装成 pass。

### C 组三端视觉/效果一致性

同场景、同页面、1200×800：

| 对比 | SSIM | 分级 |
|---|---:|---|
| Deep Native ↔ Three WebView | 0.7983 | diverged |
| Three WebView ↔ Web | 0.6434 | diverged |
| Deep Native ↔ Web | 0.5669 | diverged |

该结果没有放宽阈值。根因是：宿主布局、覆盖层、DPR 1.25 vs 1、相机初始位、Native 与 Three 的渲染实现差异。

二级诊断：WebView 纯视口 ↔ Web canvas 对齐后 SSIM `0.8754`。几何/材质/光照语义一致，残差主要是覆盖层、纵横比 3.4% 拉伸与 DPR 光栅化。下一步应在同 DPR、同 viewport crop、同 camera pose 下重拍，而不是用降画质掩盖差异。

### D 组三端性能

> 2026-09-21 复盘勘误：D1 脚本实际启动的是 `a4-product-verify/studio-desktop.exe`（Tauri 工作台），原表将它标成 Deep Native 有误。该项不是 Rust/wgpu `deep-native.exe` 的性能。下表已更正；C 组使用的 Native 产物需按各自证据独立判断。完整产品接入与升级检查见 [本轮复盘](product-reaudit-2026-09-21.md)。

环境：RTX 4060 Laptop、1920×1080@144Hz、系统缩放 125%、Chrome 153。

| 端 | 轮次 | 启动/可见中位 | 渲染就绪中位 |
|---|---:|---:|---:|
| Web Chrome | 冷 1 + 热 4 | load 161ms | interactive 167ms，evidence 5/5 |
| Tauri 工作台（原误标 Deep Native） | 3 次全新 profile | 主窗 2378ms | 2434ms |
| Three WebView | 3 次 | 主窗 1660ms | 1709ms |

Web 三维场景拖拽 2×10 秒：

- avg FPS：144（vsync 锁定）
- 帧间隔 P50/P95/P99：`6.9 / 7.1 / 7.2ms`
- max：`7.8ms`
- 长帧（>100ms）：0
- 总样本：2966

口径差异已写入 `d-group-result.json`：Web t0 是导航发起；EXE t0 是进程创建前；EXE 内部帧率无法外部采样，使用内容就绪时长替代。

因此这组数据不能得出三端渲染性能排名，也没有提供 Deep Native 的同口径启动成绩。EXE 内容就绪来自外部画面探测，Web interactive 来自页面口径，两者不能直接计算引擎快慢倍数。

## 4. AI 助手升级

`79a75f8` 已落地：

- 主备模型 failover：402/429/5xx/网络/超时可切换；401/403 不切换
- 备用配置：`.env` 的 `AI_FALLBACK_*`（localhost:46037 / gpt-5.6-sol）
- 模型列表拉取与 5 分钟缓存
- 模型切换
- 思考深度 minimal/standard/deep 映射
- 流式首 delta 前 failover
- 最近 50 条遥测、provider/model/延迟/token/状态
- Agent 上下文预算压缩（摘要最旧轮次，不硬截断）
- 设置中心渐进增强 UI，既有 AI 面板交互零回退

验证：API AI 相关 167 测试、Web AI 相关 15 测试、双侧 typecheck（当时版本）通过。

## 5. Final Gate 最新状态

最新正式门禁序列：`test-output/batch-f-gate-20260921061816/gate-run-summary.json`

| Gate | 状态 |
|---|---|
| repository | PASS |
| source-size 800 | PASS（5559 文件，无超限） |
| public-brand | PASS（DeepMonkey Studio，ICO 全尺寸） |
| typecheck | PASS |
| test | FAIL（deep-engine 尾部严格 300 行历史 gate，非测试断言失败） |
| build | PASS |
| deep-p0 | FAIL（同 deep-engine 严格 300 行尾部 gate） |
| scene-client | PASS |
| product-browser | PASS |
| webgpu | PASS |
| production-artifact | PASS |

汇总：`9 pass / 2 fail`。两个 FAIL 的实质是 deep-engine 严格 300 行历史/并行 WIP 门禁，不是业务测试失败；后续应把严格 300 行门禁从普通 `pnpm test` 依赖链拆为独立质量门，或对历史大文件建立明确豁免清单，避免“测试全绿但质量尾门令 test 红”的混合语义。

## 6. 已知剩余项

1. deep-engine 严格 300 行历史/并行 WIP 门禁口径治理（非业务失败）
2. lab:isolation 已更新为生产导出面审计并 PASS
3. Array texture 生产 PBR pipeline 完整接线与真机性能证据后置
4. TLAS/soft-raster/visibility buffer 的完整生产帧接线与批次 F 视觉证据后置
5. XR 真机（Quest/Visor）未覆盖
6. C 组三端像素级完全对齐需同相机、同 DPR、同 viewport crop 重拍
7. Native LPAC 测试受本机 `0xc0000022` 环境限制

## 7. 交付边界

- 本轮所有修改均未 push。
- 未使用 reset/clean/checkout 破坏工作树。
- 未把未验证的真机/视觉结果宣称为已通过。
- 批次 E A/B/C/D 已有真实证据；批次 F 已完成 9/11 gate，剩余 2 项属于质量门治理而非业务测试失败。
