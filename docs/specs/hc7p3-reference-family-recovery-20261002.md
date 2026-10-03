# H-C7-P3 引用消费第六批同族补缺（2026-10-02，主线程）

## 现状核查

六步已读实际源码/未跟踪与第六批规格、contracts SceneAnimationState/SimulationEntityState、依赖与消费方、现有43正式回归、CLI receipt与54主线程复核。复用SceneReferenceRegistry和既有加载解析门，不改SceneTimelinePanel、公共contracts、浏览器原删除语义或新建第二图。

**已有（不重建）**：selection/root引用逆算子、asset绑定拒绝、动画轨道/状态机/仿真清理与加载悬空拒绝。

**真实缺口**：
- 未知仿真kind只要夹带targetModelId便被当已知类型，违背新增类型不匹配fail-closed声明。
- 仅时间线帧被删除、没有状态机状态命中时，clip事件清理完全不运行，加载门随后拒自己生成的悬空clip。
- 同clipId仍被其他对象引用时，事件被一并删掉，静默误伤正常剩余行为。

## 最小方案

- simulationEntityModelReferences按原四种kind判别与所需形态取refs；未知kind先拒，不用存在某字段替代判别联合。
- clip事件消费集合由被删对象的状态与帧的clipId减去仍被剩余对象引用的clipId；独立于statesConsumed是否空，在检查阶段算定，消费阶段应用。
- 保initial/active锚拒绝、任意错误全变更前发生、before深恢复不变。新增三负控/正控formal短叶，不重写超过千行既存driver测试。
- 无UI/按钮/操作步骤增加，仅后台安全正确性。禁GPU/cargo/no commit/push。

## 验证

- 修前三反例 **0/3通过**，保 `test-output/hc7p3-reference-family-20261002/before.json`。
- 修复只动既有registry：判别kind先于target字段；消费clips去掉剩余状态/时间线仍引用的ID；timeline-only事件与statesConsumed解耦；检查阶段全量规划后才写容器，初始/活动锚与before深恢复不变。
- 实际本次commands＋所命中真实删除族 **108/108**，Web完整tsc0；`after.json`、`web-typecheck.log`。第六批旧130同族口径非本次runner全集，不沿历史数伪报133。既有SDK取消/rollback/重开43例一起实跑，未重写复杂driver测试。
- 全部UI/工具栏/TimelinePanel零改动，没有用户步骤增加；Native/浏览器主作者引用同步仍P3后继。归本子集修复，不加61行完成数。
