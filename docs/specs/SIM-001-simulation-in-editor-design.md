# SIM-001 仿真并入 3D 编辑器·结合方案设计

状态：设计 v1（2026-09-04，GLM-5.3 依据西门子 Process Simulate 单工作台模型规划）
触发：用户反馈"仿真相关功能不能结合到 3D 场景编辑器中作为一个插件面板吗？"+"可以参考西门子的实现"。

## 1. 西门子参照（提炼规律，不复制品牌与视觉）

Process Simulate 的可借鉴结构：

1. **单工作台**：3D 视口即仿真环境，配置、运行、验证同一画面，不切页。
2. **仿真实体一等公民**：路径点、操作序列、碰撞对、信号映射与几何对象同树管理（对象树里既有机器人也有焊点路径）。
3. **上下文检查器**：选中什么，右侧面板就配置什么——选中机器人出现路径编辑器，选中路径点出现点位参数。
4. **全局播放控制**：主工具栏一处 play/pause/倍速/时间轴，驱动任何仿真运行（机器人回放、节拍序列、物流）。
5. **结果就地呈现**：碰撞标记、可达性、KPI 计数直接叠在 3D 画面；深度报告另开标签页。
6. **Study/变体**：what-if 与基线共享同一工厂模型，结果归档可对比。

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

### 3.2 仿真实体入目录树（左树「仿真」域）

- 合同扩展（contracts `scene.ts`，沿 SceneSnapshot 既有可选字段模式）：`simulationEntities?: SimulationEntity[]`，判别联合：
  - `{ kind: "path"; id; name; targetModelId; points: Vec3[]; loopMode; speed }`（机器人/人物/AGV 路径）
  - `{ kind: "collisionPair"; id; name; a: TargetRef; b: TargetRef; tolerance }`
  - `{ kind: "queue"; id; name; anchor: Vec3; capacity }`、`{ kind: "signalMap"; id; name; bindings: [...] }`
- 引用一律用稳定 modelId/layerId；被引用对象删除时实体标记"断链"并黄牌提示（不静默失效——沿 Study 歧义防护原则）。
- 树节点选中 → 检查器切配置面板（§1 规律 3）；未选中时面板显示引导空态。

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

| 期 | 面板 | 内容（复用既有引擎） | 不做 |
|---|---|---|---|
| SIM-1a | 面板框架 + 物流仿真（Plant Lite/factory-flow） | 在场景中点选 Source/Process/Buffer/Sink 锚点成实体；跑离散事件；AGV 轨迹与队列热力覆盖层；KPI HUD；入 Study | 不做新仿真算法，引擎原样 |
| SIM-1b | 工位与机器人 | 选中机器人→路径点教学（3D 拾取表面点加入路径）→轨迹预览→碰撞对配置→回放标红；节拍摘要入 Study | 不做 OLP、认证动力学、控制器矩阵（§28 排除延续） |
| SIM-1c | 虚拟调试 | 信号映射实体 + 运行时序轨道 + 证据（复用 VirtualCommissioning 既有引擎与证据格式） | 不做现场下发 |
| SIM-1d | What-if | 参数扫描面板（选输入域→批量运行→结果对比表→全部入 Study 谱系） | 不做自动调参 |

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

SIM-1a 详细实现规格（面板框架 + 物流面板 + 覆盖层 + 树节点合同）由白天模型在 EX/S1 队列消化后编写；夜间按 UF-001→EX→S1 顺序不受影响。
