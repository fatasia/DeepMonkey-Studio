# SIM-001 仿真并入 3D 编辑器·结合方案设计

状态：设计 v2 + SIM-0 能力桥接已实现（2026-09-04，GLM-5.3 初稿，Codex 补齐状态边界并落地）
触发：用户反馈"仿真相关功能不能结合到 3D 场景编辑器中作为一个插件面板吗？"+"可以参考西门子的实现"。

## 1. 参照与首要原则（提炼规律，不复制品牌与视觉）

**用户定调（2026-09-04）：交互高效轻量，功能全量同级——拖连播是快速通道，不是功能阉割；对标平台有的能力都要有。**

- **能力基线（全量保留，不得削减）**：Plant 级离散事件（工位/队列/缓冲/输送/AGV/班次/故障维修/随机实验/置信区间）、PS 级工位验证（碰撞对/机器人轨迹/关节约束/时序/节拍/故障矩阵/回放/证据）、PD 级 PPR/BOP、What-if 与统一 Study。引擎与既有功能零删减，`/operations` 全部能力不回退。
- **Visual Components 的交互规律（快速通道）**：拖预制体进场景即仿真元件（参数/数据端口已带）；点两个对象即建立流程连接；按 play 即出吞吐/瓶颈/利用率。零学习成本起步。
- **渐进披露（专家深度）**：分布、调度策略、班次表、故障模型、实验矩阵、置信设置全部可达——藏在检查器"高级"区与面板二级页，不占快速通道。
- **西门子结构规律（工程严谨性）**：单工作台不切页；仿真实体与几何对象同树；上下文检查器；一处播放控制；结果就地呈现 + 深度报告另开；Study 变体归档。

**冲突裁决：交互层取 VC 的高效（少点击、少概念、即时反馈），能力层取西门子的全量（对标功能一项不少）。**

## 2. 结合形态总览（目标图景）

编辑器内完成"选中场景对象 → 配仿真 → 跑 → 看结果 → 存证"全闭环：

```
3D 编辑器（AppStudioShell）
├─ 左：场景目录树 ──新增「仿真」域节点（路径/队列/碰撞对/信号映射，随场景保存）
├─ 中：3D 视口 ──仿真覆盖层（路径线/热力/AGV 轨迹/碰撞闪红/KPI 悬浮）
├─ 右：上下文检查器 ──选中仿真实体即切换为对应配置面板（Inspector=当前上下文）
├─ 工具坞「仿真与开发」组 ──新增：物流仿真 / 工位与机器人 / 虚拟调试 / What-if
│    （与既有 动画/行为/物理/XR 同级，同一开合交互）
└─ 底部：时间线面板 ──复用为仿真播放控制（play/倍速/吸附/关键帧），一处控制一切
```

`/operations` 不删除，转型为**证据工作台**：谱系对比、批量结果表、跨 Study 分析（对应西门子的报表/对比视图）。同一 Study 数据，两个视图；编辑器管"做仿真"，/operations 管"看证据"。

## 3. 架构设计

### 3.0 权威状态与首期落地边界

不能把“面板搬进编辑器”误做成第二套仿真产品。三类状态的权威来源固定如下：

| 状态 | 权威来源 | 生命周期 | 禁止事项 |
|---|---|---|---|
| 仿真建模输入 | `SceneSnapshot.simulationEntities`（SIM-1a 起） | 随场景保存、版本化 | 不在面板 localStorage 另存副本 |
| 运行会话 | 面板运行控制器 | `idle → running → cancelling/completed/failed`，关闭即释放 | 不把临时热力、播放头写回场景 |
| 正式结果与复现 | 统一 `IndustrialStudyRecord` | 不可变结果 + 修订谱系 | 不建编辑器专属结果表 |

并发与离开语义：同一项目同一仿真类型只允许一个权威运行；重复点击不重复发起。可取消引擎必须暴露取消动作并保留已完成 Study；场景切换或面板卸载会中止本地可取消请求，服务端已落盘结果不得回滚。不可取消的短请求在运行期间禁用重复动作，完成后按当前项目 ID 校验再回填，避免跨项目串写。

引用完整性：所有场景对象引用使用稳定 `sceneId + modelId/primitiveId/layerId`；打开场景时检测断链，显示“目标已删除/场景已不存在”，禁止静默改绑到第一个对象。历史 Study 保持原始引用，复现时若源版本缺失则明确阻断并给出迁移入口。

**SIM-0 已落地的能力桥接**：工具坞已通过注册表提供物流、工位与机器人、虚拟调试、What-if 四个入口；插件宿主在 3D 视口内懒加载现有 `OperationsCenter`，隐藏全局页头/页签/历史区，直接复用原引擎、API 与 Study 存储。当前场景与已选对象会预填工位/信号映射，结果定位可回到视口；“查看运营证据”可逆跳转 `/operations`。SIM-0 不宣称已完成仿真实体、覆盖层或统一时间线，它只先消除“必须切页才能运行”的割裂。

### 3.1 仿真面板注册表 `sceneSimulationRegistry.ts`（新，≤150 行）

```ts
export interface SceneSimulationPanelDescriptor {
  id: "plant-logistics" | "workcell-robot" | "virtual-commissioning" | "what-if";
  title: { zh: string; en: string };
  icon: ComponentType;
  /** 面板主体（懒加载），挂到右侧检查器区 */
  Panel: LazyExoticComponent<ComponentType<SceneSimulationPanelProps>>;
  /** 是否对当前场景可用（如无机器人则工位面板提示空态） */
  availability: (ctx: SceneSimulationContext) => "available" | { reason: string };
}
export interface SceneSimulationPanelProps {
  sceneId: string;
  /** 当前选中：场景对象（modelId/layerId）或仿真实体 */
  selection: SimulationTargetRef;
  engine: ViewerEngineLike;            // 沿用行为脚本的引擎注入边界，不直接 import 引擎
  overlay: SimulationOverlayController; // §3.3
  onStudyRecorded: (studyId: string) => void;
}
```

- 工具坞"仿真与开发"组新增一个「仿真」入口组，枚举注册表面板（SceneToolDock 只加枚举渲染，不写任何面板逻辑——守住 441 行红线）。
- 面板开启状态与其它开发面板一致随工作区保存恢复。

### 3.2 仿真元件 = 工业预制体 + 全量实体（快速通道 + 完整建模能力）

- **预制体即元件（快速通道）**：78 个工业预制体已带参数/动作/数据端口；传送带 `speed/capacity`、机器人 `speed/payload` 直接映射为离散事件/节拍参数。角色（源/汇/工位/缓冲/AGV）在检查器"仿真"页签一选即成。
- **全量实体同时保留（完整建模）**：需要 VC/Plant 级显式建模时，左侧树「仿真」域可直接创建：
  - `{ kind: "flowLink"; fromModelId; toModelId }` 连接（点两对象即成，自动生成沿地面的路径线）
  - `{ kind: "path"; targetModelId; points; loopMode; speed }` 路径（自动生成后可手调）
  - `{ kind: "queue"; anchor; capacity; discipline }`、`{ kind: "buffer"; ... }` 队列与缓冲（含调度策略）
  - `{ kind: "source" | "sink"; arrivalDistribution; ... }` 显式源汇（分布可配：常数/指数/均匀/经验）
  - `{ kind: "collisionPair"; a; b; tolerance }`、`{ kind: "signalMap"; bindings }`、`{ kind: "shiftCalendar"; ... }`、`{ kind: "failureModel"; ... }` 班次与故障
- 合同扩展在 contracts `scene.ts` 沿 SceneSnapshot 可选字段模式新增 `simulationEntities?`，全部实体入树、入保存。
- 引用一律稳定 modelId/layerId；断链黄牌不静默（沿 Study 歧义防护原则）。

### 3.3 仿真覆盖层 `viewer/simulationOverlay.ts`（新，≤250 行）

- 引擎无关的薄层：`showPath(entityId, points)`、`showHeatField(...)`、`flashCollision(pairId)`、`showKpiHud(metrics)`；内部用引擎既有 annotation/label/line 能力实现，不改引擎核心（Interaction/Rig mixin 不动）。
- 生命周期：面板关闭或切换运行时自动清理；随场景保存的只有实体数据，覆盖层不持久化。

### 3.4 播放控制统一

- 时间线面板（SceneTimelinePanel）新增"仿真轨道"模式：当前面板产生的运行（物流 tick、机器人路径回放、虚拟调试时序）注册为一条轨道，共用 play/pause/倍速/吸附控件。
- 多仿真同时运行时按轨道独立启停，不引入全局调度器（明确非目标）。

### 3.5 Study 链路不变

- 面板运行的每次正式执行（非预览）照旧写入统一 Study：权威输入、执行版本、场景/模型证据、结果指纹、基线谱系、复现入口。
- 面板内"复现"直接调 Study 复现 API；"看证据"跳 `/operations` 对应条目。**不建第二套结果存储。**

## 4. 面板分期与范围

| 期 | 面板 | 内容（能力全量，交互走快速通道） | 不做 |
|---|---|---|---|
| SIM-0（已完成） | 注册表 + 嵌入宿主 | 四入口、懒加载、当前场景/对象上下文、原运营引擎与 Study 复用、证据工作台可逆跳转 | 不新增算法，不复制数据层 |
| SIM-1a | 面板框架 + 物流仿真 | 拖预制体→选角色→点连 flowLink→play 出吞吐/瓶颈/利用率；检查器"高级"= 分布/班次/故障/队列策略全参数；AGV 轨迹、队列热力、KPI HUD 覆盖层；随机实验与置信区间入口；全部入 Study | 不做新仿真算法，Plant Lite 引擎原样全量接入 |
| SIM-1b | 工位与机器人 | 选中机器人→表面拾取路径点教学→轨迹预览→碰撞对（含矩阵）→回放标红→节拍与故障矩阵；证据入 Study | 不做 OLP、认证动力学、控制器矩阵（§28 排除延续） |
| SIM-1c | 虚拟调试 | 信号映射实体+运行时序轨道+证据链（复用既有引擎），编辑器内完成信号绑定与回放 | 不做现场下发 |
| SIM-1d | What-if + PPR/BOP 轻入口 | 参数扫描与对比表入 Study 谱系；PPR 工序/前置/资源在面板内可查可跳 /operations 深编 | 不做完整 PLM |

每期独立规格（SIM-1a 先行，含文件计划与测试），本文件只锁结合方式。

## 5. 红线与边界

- AppStudioShell.tsx（647）、SceneToolDock.tsx（441）只加注册枚举与开关，不写面板逻辑；各面板文件 ≤400 行。
- 面板与引擎解耦：只经 props 注入（engineLike + overlay），不 import viewer 内部模块。
- `/operations` 现有功能不删不改坏；本方案只加编辑器侧视图。
- PD Lite（PPR/BOP）不进编辑器面板（非场景绑定），保留在 /operations。
- 竞品名与西门子视觉不进产品；术语用"仿真面板/工位验证/虚拟调试"。

## 6. 验收标准（SIM-1a 起）

- [ ] 不切页完成"选对象→建队列/源汇实体→运行→看覆盖层→Study 存证→复现"闭环
- [ ] 仿真实体随场景保存/刷新恢复；引用断链有黄牌不静默
- [ ] 面板开关随工作区记忆；无机器人/无场景时空态明确
- [ ] 时间线一处控制仿真播放；面板关闭覆盖层自动清理
- [ ] Study 记录与 /operations 中同一运行完全一致（同一数据源断言）
- [ ] 聚焦测试 + typecheck + source-size + 双主题浏览器截图

## 7. 下一步

SIM-1a 下一步聚焦“可编辑仿真实体合同 + 场景树节点 + 物流覆盖层 + 播放适配器”，沿 SIM-0 宿主增量实现，不再新建第二套物流表单。完成实体引用迁移测试后再进入 SIM-1b 路径教学和碰撞回放；统一时间线必须经运行适配器接入，禁止让各面板直接操纵时间线内部状态。

## 8. 2026-09-05 核验回填

- 已完成：实体合同/树/检查器已有实现本轮打通 controller；snapshot 保存（含清空数组）、请求中编辑合并、导入对象引用重绑定、静态 path/flowLink 覆盖层与关闭清理；真实 QA 保存刷新可恢复路径参数。
- 已完成：面板可拖动/缩放/折叠，折叠不卸载当前表单；窄容器工位/机器人布局与局部双主题。
- 本轮待办：源汇/队列快速创建、实体参数驱动既有运行器、实时轨迹/热力/KPI、统一时间线、实体与正式 Study 的完整往返。静态覆盖层不计作上述运行能力完成。
- 已完成：切换 tab 的物流/PLC 未提交状态保留，OperationsCenter 改按 project.id 挂载；场景上下文与导航 stage 分开，四组真实浏览器反例验证。关闭窗口仍卸载。
- 本轮待办：停靠/autohide、关闭后恢复策略；不把跨 tab 保留扩大成全部生命周期已完成。
- 证据/代码索引：`../codex-glm53-handoff-2026-09-05.md`；分析比较使用 Siemens Plant 手册作为停靠参考，不冒充当前 Process Simulate 精确 UI。
