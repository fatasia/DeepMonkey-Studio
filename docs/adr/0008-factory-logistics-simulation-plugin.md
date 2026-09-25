# ADR-0008: 以插件实现轻量工厂物流仿真

## Status

Accepted

## Context

Deep Monkey Studio 在 M8 需要参考 Siemens Tecnomatix Plant Simulation（下称 Plant Simulation）的工厂物流仿真主线，支持节拍、时间和分析等基本能力。用户已有 `external IoT prototype workspace` 原型，其中包含离散事件物料流、预热、重复实验、固定随机种子、吞吐/周期/WIP、利用率、瓶颈、置信区间、多品种、资源池、故障、路由、死锁、AGV 路网和真实数据校准。

现有原型也混合了 IoT、维护、AI、交通安全、成本能源优化、巨型 Vue Store 和大量 Tauri command。直接合并会让 2D/3D 编辑器失去主体地位，并复制场景、数据、资产和运行时能力。完全重写又会浪费已经验证的算法、测试夹具和产品经验。

Plant Simulation 的范围非常广，包括层级对象、开放接口、大规模模型、实验设计、统计、能耗成本、工厂/仓储物流和各种行业库。M8 的目标不是兼容 SimTalk 或复制完整产品，而是让 Deep Monkey Studio 用户在现有 3D 场景中快速完成可信的生产线物料流研究。

## Requirements

### Functional

- 从现有场景对象和连接创建可运行的物流网络，不建立第二套 3D 编辑器。
- 表达物料到达、加工、装配、缓存、输送、分流合流、资源、故障、班次、多品种和路由。
- 以离散事件推进仿真时间，支持动画预览、暂停、倍速、复位和确定性回放。
- 运行带预热期、随机种子和重复次数的正式实验。
- 分析吞吐/产量、Takt/Cycle/Lead Time、WIP、队列、阻塞/饥饿、资源利用率、瓶颈、停机和分产品完成量。
- 比较方案并导出包含模型版本、输入、随机设置、统计和校准证据的报告。
- 从 M3 Data Hub 读取历史/实时样本，校准吞吐、周期和 WIP。
- 用户可安装、禁用和卸载插件；非仿真项目不加载仿真引擎。

### Non-functional

- 相同模型、输入和随机种子必须产生相同统计结果与确定性哈希。
- 正式实验不依赖渲染帧率，切换页面、后台运行或禁用 3D 动画不改变结果。
- 仿真在 Worker/隔离进程执行，错误、死循环、大模型或取消不得阻塞编辑器。
- 默认 TypeScript 仿真引擎由浏览器 Worker、Tauri WebView Worker 和服务器 `worker_threads` 复用，并通过黄金样本一致性测试；实现可经 `SimulationEnginePort` 替换。
- 插件不得深层导入 `ViewerEngine`、React feature、Data Hub 实现或具体渲染后端。
- 插件文档和结果可随应用版本迁移、审计和回滚。

## Decision

### 1. 插件边界

建设一个可选 `FactoryFlowPlugin`，而不是在 Studio Core、Scene Runtime 或 Data Hub 中增加物流特例：

```text
FactoryFlowPlugin
├── manifest + permissions
├── SimulationStudyDocument schema/migrations
├── logistics object library
├── study editor + experiment/analysis panels
├── scene/topology/data adapters
├── SimulationEnginePort
│   ├── default TypeScript Worker engine
│   └── optional native/WASM accelerator
└── fixtures, benchmarks, examples and reports
```

Core 只提供插件注册、稳定对象 ID、文档命令/撤销、仿真时钟接口、事件、任务、数据产品和 Scene Capability SDK。FactoryFlowPlugin 使用这些公共 API；插件禁用时只把 `SimulationStudyDocument` 作为未知但可保留的扩展数据处理，不破坏项目其他内容。

首版离散事件引擎使用纯 TypeScript 实现，不依赖 DOM、Three.js、Node.js 或 Tauri API。浏览器和 Tauri 在 Web Worker 中运行，服务器使用 `worker_threads` 适配器。`SimulationEnginePort` 只暴露 validate、run、cancel、progress 和 result/trace 协议；若持续基准证明 TypeScript 无法满足性能门槛，可另装 Rust/WASM/原生实现，但不能改变研究文档、统计语义或结果协议。

### 2. 文档模型

`SimulationStudyDocument` 是应用扩展文档，主要包含：

```text
SimulationStudyDocument
├── metadata: id/name/version/status/goal
├── model
│   ├── objects[]: type + sceneObjectRef + parameters
│   ├── connections[]: from/to/transport/routing
│   ├── products[]: mix/batch/process plan
│   ├── resources[]: capacity/calendar
│   ├── calendars[]
│   └── rules[]
├── experiment: start/end/warmup/replications/seed/parameters
├── calibration: datasetRef/metrics/tolerance/fingerprint
├── visualBindings[]
└── resultRefs[]
```

场景对象只保存通用 Transform、资产、动画和数据能力。仿真参数保存在研究文档中，二者通过稳定 ID 引用；删除被引用场景对象时由引用系统报告影响并提供解除绑定，不进行隐式级联删除。

### 3. 首批物流对象库

- 流入/流出：`Source`、`Sink`。
- 加工：`Process`、`ParallelProcess`、`Assembly`。
- 存储/输送：`Buffer`、`Store`、`Conveyor`、`Transfer`。
- 路由：`Merge`、`Split`。
- 资源：`ResourcePool`、`Worker`、`AGV`、`Forklift`。
- 运行约束：`ShiftCalendar`、`Failure`。

对象由少量正交语义组合：容量、加工时间、缓冲、批量、换型、资源占用、可用日历、故障和路由。默认库不为每种行业设备创建专用引擎类型；行业模板通过预配置组合或额外插件提供。

### 4. 离散事件与时间

- 引擎使用优先事件队列，只处理到达、开始、完成、故障、修复、班次、资源和路由等状态变化，不按渲染帧逐步计算生产逻辑。
- 支持固定、均匀、正态、对数正态、指数和经验分布；所有随机流由研究种子派生，记录各随机流名称，便于方案间使用共同随机数。
- 明确区分 `Takt Time`（需求节拍）、`Cycle Time`（工序/实体周期）和 `Lead Time`（端到端通过时间），界面不得混称“节拍”。
- 支持预热期、测量期、重复实验、暂停/继续、倍速和可取消批量运行。
- 动画预览消费带时间戳的事件轨迹，通过 Scene SDK 做插值；预览可采样或跳帧，但不得反向改变逻辑结果。

### 5. 物流语义

- 队列规则首批支持 FIFO 和优先级；路由支持加权、轮询、最短队列、优先级和按产品路由。
- 支持有限/无限缓冲、阻塞、饥饿、并行容量、批处理/拆批、换型时间、共享资源 seize/release、班次可用率和 MTBF/MTTR。
- 多品种声明产品配比、批量、各工位处理时间因子与工艺路由。
- 循环网络必须声明最大等待与死锁策略；引擎记录检测、恢复和被丢弃实体，不能悄悄吞掉死锁。
- AGV 首期只作为容量受限的运输资源和可选路由动画，不建设完整交通物理、人员安全或仓储 WMS 仿真。

### 6. 实验与分析

编辑体验固定为：

```text
定义研究目标
  → 建模并校验
  → 配置时间、分布、资源和场景参数
  → 动画预览
  → 正式重复实验
  → 结果分析/校准
  → 方案比较与报告
```

正式实验最少输出：

- 吞吐/产量及 95% 置信区间；
- Takt、Cycle、Lead Time；
- 平均/最大 WIP 与队列；
- 工位/资源工作、等待、阻塞、饥饿、故障占比；
- 自动瓶颈候选与判定依据；
- 各产品完成量、换型次数和停机；
- 死锁、恢复、丢弃和数据质量警告。

可视分析首批只提供关键 KPI、状态堆叠条、队列/利用率排行、直方图、时间序列和方案对比。Sankey、Gantt、遗传算法、能耗成本和高级实验设计保留为后续可选分析插件，不进入 M8 核心。

### 7. 校准与可信度

- 通过 Data Hub 选择具有时间、吞吐、周期和 WIP 字段的数据产品，不在插件内另做连接器。
- 校准记录数据集版本/指纹、样本范围、完整率、研究版本、实验哈希、指标误差和容差。
- 低质量或误差超限只允许标记“未校准/有条件”，不能生成“验证通过”的结论。
- 报告必须区分动画预览、单次试跑和正式重复实验，不以视觉逼真代替统计可信。

### 8. 旧 IoT 原型迁移

抽取并重构：

- `src-tauri/src/material_flow.rs` 的离散事件语义、算法思路、黄金输入输出和单元测试；首版按 `SimulationEnginePort` 重构为 TypeScript Worker，不直接把旧 Tauri/Rust 模块并入核心；
- `src/logistics/experiment.ts` 的场景到实验模型转换思路；
- `src/logistics/calibration.ts` 的样本指纹、校准指标与测试样例；
- 预热、重复实验、置信区间、确定性、瓶颈和报告的交互经验。

不直接迁移：

- `src/stores/studio.ts` 与巨型页面状态；
- `LogisticsWorkbenchPanel.vue` 的整体组件结构；
- IoT 协议、Edge Agent、维护、AI、CAD/PLM、虚拟调试等其他模块；
- 交通安全、成本能源多目标优化和未经过独立验证的自动建议。

迁移代码先形成输入输出明确的纯引擎包和黄金样本，再接 UI；不得把旧工程复制进仓库后继续耦合修改。

## Performance and quality gates

- 100 节点/100 万事件标准模型必须在基准机上持续运行，报告吞吐而非只设一次性硬件绝对值；任何版本相对已接受基线退化超过 15% 阻止发布。
- 用户发出取消后 5 秒内必须停止正式实验；编辑器输入响应 p95 不超过 100 ms。
- 动画状态推送默认不超过 20 Hz，批量实验不生成逐实体完整动画轨迹，避免结果文件和内存失控。
- 默认单次研究内存预算 512 MB；超过预算时停止对应任务并保留诊断，不影响编辑器。
- 正式方案默认建议至少 10 次重复；少于 3 次显示强警告，所有置信区间必须同时记录重复次数和种子策略。
- 浏览器 Worker、Tauri Worker 和服务器 Worker 使用相同黄金样本，对完成量、事件计数、指标和确定性哈希做严格一致性检查；若以后增加原生/WASM 加速器，它必须通过同一套合同测试，浮点统计另声明可接受误差。
- 插件包体、引擎和对象库按需加载；非仿真项目的首屏包不包含它们。

## Security and operations

- 仿真脚本只使用声明的模型查询、随机流、事件和统计 capability，默认无网络、DOM、文件、令牌或数据库访问。
- 服务器批量实验继承用户/项目/发布权限并有并发、CPU、内存、时间和存储配额。
- 结果与报告按项目隔离；导出不包含 Data Hub 凭据或未授权的样例行。
- 引擎崩溃只失败当前任务；任务状态、进度、最后事件和诊断可观测，可安全重试。

## Explicit non-goals

- SimTalk 语言、Plant Simulation 文件格式或完整对象库兼容；
- 完整物理/机器人仿真、碰撞动力学和 PLC 虚拟调试；
- APS/MES/WMS、生产排程或企业经营优化平台；
- 通用仓储、交通、人因工程、能耗成本和遗传算法优化套件；
- 分布式超大规模仿真集群；
- 把行业对象或仿真引擎写进 Studio Core/Scene Runtime。

## Failure modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| 场景引用失效 | 逻辑对象无可视绑定 | 引用影响分析、保留逻辑对象、重新绑定向导 |
| 网络无 Source/Sink 或不可达 | 实体无法完成 | 运行前图校验、定位断边和不可达对象 |
| 循环等待/死锁 | 实验不收敛 | 最大等待、检测指标、显式恢复策略 |
| 分布或输入不合理 | 结果误导 | 范围检查、单位、样例、敏感性警告 |
| 重复次数/预热不足 | 统计不可信 | 强警告、置信区间、实验模板 |
| Worker/WASM 崩溃 | 当前实验失败 | 任务隔离、取消、诊断、安全重试 |
| 多宿主或加速器漂移 | 不同运行环境结果不一致 | 同一 TypeScript 引擎优先、合同测试、黄金样本、确定性哈希 |
| 3D 预览掉帧 | 视觉卡顿 | 事件采样、插值、逻辑与渲染解耦 |

## Consequences

### Positive

- 用户在熟悉的场景编辑器内完成物流研究，不学习第二套平台。
- 复用数据、模型、时间、任务、发布和插件能力，核心保持精简。
- 旧原型的可靠算法和经验被保留，巨型应用耦合不会被带入。
- 结果具有随机设置、置信区间、校准和版本证据，比纯动画演示可信。

### Negative

- M8 只能覆盖 Plant Simulation 的基础物料流研究，不能替代其完整行业生态。
- TypeScript 在超大实验上的吞吐上限可能低于原生实现，需要用持续基准决定是否增加可选加速器。
- 可信模型仍需要业务人员提供正确节拍、分布、资源和校准数据。

### Neutral

- 高级对象、优化器和行业库根据真实项目以独立插件增加，而不是承诺统一进入主产品。

## Alternatives considered

**把旧 IoT 工程整体并入 Deep Monkey Studio**：拒绝。它包含重复编辑器、巨型 Store 和超出物流范围的模块，会破坏当前架构。

**在 Three.js 帧循环中直接模拟物流**：拒绝。结果依赖帧率，无法快速实验、确定性回放或统计验证。

**把仿真做成 Studio Core 内置功能**：拒绝。行业能力会污染所有项目和默认包体，也无法独立演进/卸载。

**完全复制 Plant Simulation**：拒绝。对象、语言、接口和分析范围过重；目标是覆盖常见工厂物流研究闭环。

**只做动画而不做实验统计**：拒绝。不能支撑产能、节拍、缓冲和瓶颈决策。

## References

- [Deep Monkey Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
- `external IoT prototype workspace` 旧版原型（当前工作区外部参考，不作为仓库依赖）
- [Siemens Plant Simulation](https://www.siemens.com/en-us/products/tecnomatix/plant-simulation-software/)
- [Siemens Plant Simulation X Advanced](https://www.siemens.com/en-us/products/tecnomatix/offerings/plant-simulation-x-advanced/)
- [Siemens Plant Simulation step-by-step](https://www.plm.automation.siemens.com/en_us/Images/PlantSimulation_Step-By-Step_ENU_tcm1023-143387.pdf)
- [ADR-0003 分级场景扩展运行时](./0003-tiered-scene-extension-runtime.md)
- [ADR-0007 内嵌式数据中台](./0007-embedded-data-hub.md)
