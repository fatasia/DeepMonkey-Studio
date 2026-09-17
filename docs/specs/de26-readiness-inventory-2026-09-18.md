# DE26 就绪盘点（2026-09-18，启动前置）

范围依据 [de26-high-value-scope-2026-09-17.md](de26-high-value-scope-2026-09-17.md)；权威清单 `deep-engine-execution-tasks-2026-09-16.json`（56 项，保留 19 项）。本盘点只校准"启动时每项的起点"，不产生完成度宣称。

## 保留项起点

| 组 | 项 | 启动起点（已核实的事实） |
|---|---|---|
| A | A01 | 已完成（五平台证据作历史输入；判定分母只算 Three/Babylon/Unity） |
| A | A02–A04、A08 | 待办：真实资产与交互轨迹冻结、统一采样、Web 成对 runner 复用（`apps/web/benchmarks/render-engine` 已有三WebGLRuntime 合同与基准骨架） |
| D | D01 | 待办：Native 实例空间索引（BVH/网格选择待定；three-mesh-bvh 为 Web 侧参照，不引入运行依赖） |
| D | D04–D06 | 待办：重基点稳定性、分区预取、LOD/meshlet 验证（Deep Engine 渲染后端层，GPU 证据设施已就绪：时间戳量化 65.5µs 口径） |
| F | F01、F04、F05 | 待办：动画 TRS 正式包（runtimePackage 已有动画位）、物理宿主接线、机械约束 |
| H | H02–H04、H07 | 待办：GPU 诊断 Inspector、帧 Profiler、材质调试、原子回滚（原子回滚与 H07 与 Dashboard 单 EXE 版本切换证据可互相参照） |
| I | I04、I05、I07 | 待办：点云+3D Tiles 混合园区（依赖工业 S3）、双骨 IK、可复现故障包 |
| B/C/E/G | — | 只保留既有能力之外的高价值工作，启动时逐项重估 |

## 依赖与顺序约束

1. I04 依赖工业 S3（点云/3D Tiles 空间运行时）——不能先于 S3 启动。
2. A02–A04 的资产与轨迹应复用固定资产口径（交接第 6 节：CPU prepare/GPU timestamp/present/输入延迟/上传字节/峰值 RSS 分开记录），不另造采样。
3. H07 与 Dashboard 候选抢占/热更新恢复证据（native-full-retry-reuse）共享状态机，不得建第二套回滚。
4. scene Native 链（SceneSnapshot→RenderPacket 消费者）由并行会话推进中——D 组与 H02/H03 大量消费该链，启动前必须等其实际消费者冻结，避免双写。

## 建议启动顺序（主流程收官后）

1. A02→A03→A04→A08（证据基座，最快闭环）
2. H03（帧 Profiler）→H02（Inspector）——测量先行，D/F 组受益
3. D01→D04→D05→D06（空间与 LOD）
4. F01→F04→F05、I05、I07、H04
5. I04 最后（等 S3）

## 已删除项回归防线

A05–A07、V01–V05、D02/D03/D07/D08、F02/F03/F06–F08、H01/H05/H06/H08、I01–I03/I06/I08 不得以别名、隐含依赖或验收前置回流；每次 DE26 提交的说明需自检不含删除项产物。
