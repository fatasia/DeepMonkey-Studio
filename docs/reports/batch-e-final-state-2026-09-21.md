# 批次 E 终态汇总（2026-09-21）

> A/B/C 组执行完毕；D 组部分就绪。证据根目录 `test-output/batch-e-20260921-r1|2/`。

## A 组：历史失败重放（8 项）

**7 pass + A5 修复后复验 pass**（r1 首轮 7 pass/A5 fail → 修复 `229a02c` → r2 复验 pass）。

| 项 | 结果 | 关键证据 |
|---|---|---|
| A1 缺 EXE | pass | NSIS 解压 EXE 存在、无参启动完整渲染（r1+r2） |
| A2 无反馈 | pass | Deep Native 首帧 680-733ms（打点）、WebView ~3.1s；3 轮无静默 |
| A3 离线误依赖 | pass | 进程树外连审计 0；操作后仍 0 |
| A4 悬空引用 | pass + 附带发现 | 悬空页跳转精确提示；**遮挡缺陷复现已修复并产物级复验 PASS** |
| A5 控制台窗口 | fail→**修复复验 pass** | 根因 Tauri 缺 windows_subsystem（`229a02c`）；r2 PE 子系统=2(GUI)、0 控制台、无 conhost |
| A6 窗口崩溃 | pass | Native 3 轮+WebView 5 轮启停，单主窗无崩溃 |
| A7 canvas 裁切 | pass | 五点缩放矩阵（r1）+1200×800 回归（r2）无裁切 |
| A8 依赖诊断 | pass | 破坏包精确报 overlay/payload-hash；404/409 精确文案 |

## B 组：功能操作矩阵（22 项）

**17 pass / 4 by-design-unavailable / 1 observed / 0 fail**；全程 0 console 错误。
旋转（差分 58%）/缩放/平移/拾取轮廓/显隐近全还原/图表 tooltip/Tab 焦点闭环/Enter-Space 激活。
含前置：经真实 API 给应用新增三维场景页（revision 3 发布）。
证据：batch-e-20260921-r2/b-group-result.json + 24 截图。

## C 组：三端一致性

SSIM 矩阵（1200×800 同场景）：Native↔WebView 0.7983、WebView↔Web 0.6434、Native↔Web 0.5669——
如实分级 **diverged**（未放宽）；二级视口对齐诊断 WebView canvas↔Web canvas **0.8754**（语义一致，
残差=覆盖层/DPR 1.25vs1/纵横比 3.4%）。收敛路线：对齐 DPR 与视口裁剪后重对拍。
证据：batch-e-20260921-r2/c-group/c-group-result.json。

## D 组：三端性能对拍矩阵（已完成）

**启动矩阵**（RTX 4060 Laptop 同机，口径差异已记录）：

| 端 | 轮次 | 主窗可见中位 | 渲染就绪中位 |
|---|---|---|---|
| Web（Chrome 5173） | 冷1+热4 | load 中位 161ms | interactive 中位 167ms（evidence 5/5） |
| studio-desktop.exe | 3（全新 profile） | 2378ms | 2434ms |
| three-webview.exe（A5 修复版） | 3 | 1660ms | 1709ms |

**Web 运行帧率**（三维场景页 rAF 2×10s 拖拽期间）：avgFps=144（vsync 锁定）、
帧间隔 P50=6.9ms / P95=7.1ms / P99=7.2ms、max 7.8ms、长帧(>100ms)=0、2966 样本同分布。

证据：batch-e-20260921-r2/d-group/d-group-result.json（口径差异与环境指纹全记录）。

**基建就绪**：启动采集器 `scripts/startupEvidenceCapture.mjs`（可复现多轮）、
证据组装器 `apps/web/src/startupEvidence.ts`（CDP 入口 `window.__deepStartupEvidence()`）、
统一口径 `packages/deep-engine/src/perf/latencyStats.ts`、
产物 SHA/包体（Deep Native 16.4MB、WebView EXE 33MB/NSIS 26.3MB）。

## 修复清单（本批次产出）

1. `229a02c` WebView 控制台窗口（Tauri windows_subsystem）
2. `b830708` 发布头栏遮挡（content 容器让位 56px）
3. `0bbbfae` 布局合同回归测试

## 诚实边界

- 无真实触摸/头显/XR；A3 未停共享 API（连接审计替代）；C 组 DPR/相机未逐位对齐（已记录）；
- B 组 4 项只读页设计不可用记 by-design；B4-1 双击时序如实 observed；
- three-webview EXE 编译期剪除 studio 入口（产物事实，A4 不适用）；
- 工作台 EXE 直载 /apps/ 需运行时配置绕过（产品既有行为，非本批次引入）。
