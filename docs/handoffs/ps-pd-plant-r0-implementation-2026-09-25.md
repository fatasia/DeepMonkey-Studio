# PS/PD/Plant R0 实施记录(2026-09-25 夜间批次)

权威规格:`docs/specs/ps-pd-plant-full-replacement-upgrade-plan-2026-09-25.md`。
本文件是 R0(合同和证据底座)的首批实施记录,含现状核查结论、设计取舍与验证证据。

## 现状核查(六步,2026-09-25 完成)

1. **全仓 grep**:`SimulationEnginePort`、数字线程统一对象、golden 样例体系全仓无定义——真实缺口;
   `Worker`/`worker_threads` 已有 13 处使用,Plant Lite 已有 API 端 Worker 执行器。
2. **契约层**:`contracts/src/` 已有 `plantLiteModel`(节点/分布/班次/故障/换型/能耗/订单)、
   `plantTransportNetwork`(多车 fleet/conflictZone/封路窗口)、`industrialStudy`(fingerprints/lineage/
   reproduction)、`simulationEntities`(场景绑定局部)、`ppr`(最小 BOM/工序/EWI)、
   `virtualCommissioning`、`workcellValidation`。**这些是既有真值,只收敛不重建。**
3. **依赖**:contracts 零运行时依赖(纯类型+纯函数);plant-lite 仅依赖 contracts;vitest 4.1 全包统一。
4. **消费方**:`plantLiteWorkerExecutor.ts`/`plantLiteWorker.ts`(apps/api)消费 PlantLiteStudyRecord,
   带超时/取消/协议校验——Worker 路径已通,收敛对象必须兼容它。
5. **测试与证据**:plant-lite 10 个测试文件、factory-flow 4 个、两个验证插件各有覆盖;
   `test-output/` 有 babylon-web/bevy/dashboard-text/native-shadow/picking 等历史基准证据。
6. **规格文档**:R0 权威要求=统一领域模型、时间协议、坐标帧、单位、Study 版本、一条 API、
   10 个黄金样例、性能/确定性/断点/取消/权限门禁;退出条件=同输入同 seed 跨端一致、失败不污染旧版本。

### 核查结论

- **已有(不重建)**:Plant DES 内核(`runPlantLiteExperiment`,deterministic=true)、Worker 执行器、
  Study 指纹投影、运输网络合同、场景规范坐标系(右手 Y-up 米,`vision.ts:102` 已声明)、
  path-safe ID 工具(`resourceId.ts`)。
- **真实缺口(本批新建)**:
  a. `SimulationEnginePort` 统一端口合同(validate→prepare→run→progress→cancel→result→trace);
  b. 数字线程收敛层对象头(stableId/版本/来源/单位/坐标帧/状态/变更记录/断链诊断);
  c. 跨端一致的 canonical JSON 指纹(仓内无,Node crypto 在 web 侧不可用,需纯 JS);
  d. 10 个黄金样例与确定性断言;
  e. 进程内 vs worker_threads 一致性门禁、取消/校验失败路径测试;
  f. plant-lite 性能基线实测(供报告与后续门禁)。

## 设计取舍

1. **端口异步统一**:Plant Lite 内核是同步纯函数;端口统一为异步边界
   (浏览器 Worker / node worker_threads / 服务端都是异步协议),适配器内部包 Promise,
   progress 以 replication 为粒度(内核增强:每轮 replication 后回调,不改变任何既有语义)。
2. **指纹用 FNV-1a 64 纯 JS**:同步、零依赖、浏览器/Node/Worker 三端位级一致;
   sha256 需要异步 WebCrypto 或 node:crypto,不适合合同层同步指纹。
3. **时间/单位协议冻结为常量合同**:仿真时间=分钟(浮点)、长度=米、速度=米/分钟(运输轨道)、
   功率=kW、能耗=kWh、货币=人民币;与 plantLiteModel/plantTransportNetwork 既有注释口径一致,只集中声明。
4. **数字线程对象是收敛层不是第二套模型**:9 个对象(规格第 3 节)以引用方式挂接既有合同
   (PprComponent/VirtualDebugScenario/PlantLiteModel/IndustrialStudyRecord 等),
   新增的只有对象头、生命周期与断链诊断;不复制任何既有字段。
5. **黄金样例中"死锁"边界**:当前内核具备封路窗口与冲突区,死锁**检测与恢复算法**属 R1;
   本批 golden-06 固化"环形占用场景可建模、可校验、可运行且产生可观测阻塞证据",
   不冒充死锁恢复已实现。
6. **golden-07/08 走既有插件**:机器人碰撞用 `workcell-validation`(auditWorkcell),
   PLC 互锁用 `virtual-commissioning`(VirtualDebugSuite),样例固化输入→输出→指纹证据链。

## 本批交付物

| 交付物 | 位置 | 状态 |
|---|---|---|
| 端口/协议合同 | `packages/contracts/src/simulationEngine.ts` | 新建 |
| 数字线程收敛层 | `packages/contracts/src/digitalThread.ts` | 新建 |
| canonical 指纹 | `packages/contracts/src/fingerprint.ts` | 新建 |
| Plant Lite 端口适配器 | `packages/plant-lite-simulation/src/enginePort.ts` | 新建 |
| 内核 replication 进度回调 | `packages/plant-lite-simulation/src/engine.ts` | 增强(向后兼容) |
| 10 个黄金样例 + 断言 | `packages/plant-lite-simulation/src/golden/` + 两插件 | 新建 |
| 跨端一致性 + 失败路径门禁 | plant-lite / apps/api 测试 | 新建 |
| 性能基线脚本与实测数据 | `packages/plant-lite-simulation/scripts/bench.ts` | 新建 |
| 性能与能力升级分析报告 | `docs/reports/performance-and-capability-upgrade-analysis-2026-09-25.md` | 新建 |

## 验证证据(2026-09-25 夜间批次回填)

### 合同与样例
- contracts:`pnpm typecheck` 通过;`pnpm test` **365 passed**(含 fingerprint 16 用例、digitalThread 10 用例、digitalThreadPropagation 4 用例 golden-09)。
- plant-lite:`pnpm typecheck` 通过;`pnpm test` **61 passed**(48 既有 + golden 13 用例,指纹断言全绿)。
- golden-07(workcell-validation):**31 passed**;golden-08(virtual-commissioning):**8 passed**。
- 跨端门禁(apps/api plantLitePortCrossBoundary.test):**4 passed**;同 experiment+seed 进程内与
  node:worker_threads 的 inputFingerprint/resultFingerprint **逐字相等**;空模型抛 SimulationPortError;
  shouldCancel 首查即终止 → termination="cancelled"。
- 黄金样例首跑即抓出一个真实端口缺陷:端口层 seed 未合并进内核实验输入(random.ts "seed is not
  iterable"),已修复并锁定测试。

### 性能基线与优化(夜间追加批次)
- bench 数据(test-output/plant-lite-bench-20260925.json before / plant-lite-bench-after-20260925.json after):
  同输入同 seed,事件吞吐小模型 318k→**795k ev/s(2.5×)**,60 工位大模型 1,956→**32,280 ev/s(16.5×)**,
  墙钟中位 255.6s→**15.5s**;completedItems 前后逐位一致(8165/4200/1445/300),语义零漂移。
- 优化手段:Runtime 模型级预计算索引(findNode/resourceDefinition O(1)、effectiveCapacity/
  requiredResourceIds/operatingAvailability 启动期一次推导),热路径消除每事件 linear-find、
  全量过滤与重复数组分配;不动任何流转顺序与随机数消耗顺序(黄金指纹锁定验证)。

### 剩余(移交 R1)
- 死锁检测/恢复算法(golden-06 仅固化封路可观测)。
- 性能锚点表(规格审阅意见 #5):建议 DES ≥100k ev/s/核——当前小模型已达标,大模型 32k 达标。
- Live/Replay 模式拆分、权限最小合同(规格审阅 P0 #3/#4)。

