# 西门子 PS/PD/Plant 真实功能对照矩阵(2026-09-26)

基准来源:西门子官方产品页(2026-09-26 抓取),非二手转述:
- Plant Simulation:siemens.com/en-us/products/tecnomatix/plant-simulation-software/
- Process Simulate X Standard:siemens.com/en-us/products/tecnomatix/offerings/process-simulate-x-standard
- Teamcenter Manufacturing:siemens.com/en-gb/products/teamcenter/solutions/manufacturing-process-planning-data-management/

状态口径:**平替**=功能存在且经测试证据;**部分**=核心子集可用,缺关键子项;**缺失**=无实现。
证据格式:文件/数据路径。本矩阵是"持续优化直至平替"的权威待办清单,按差距排序。

## 一、Plant Simulation

| 官方功能 | 我们的状态 | 证据 / 差距 |
|---|---|---|
| 瓶颈自动检测 | **平替**(基础) | `plant-lite-simulation/metrics.ts` bottleneckNodeId + 瓶颈频率置信(golden-01 断言) |
| 吞吐/机器/资源/缓冲利用率分析 | **平替**(基础) | NodeRunMetrics/ResourceRunMetrics + 95% CI(modelTypes.ts) |
| 能耗与成本分析 | **平替**(基础) | energy95(含电费/碳排/峰值需量,energyRuntime) |
| Experiment Manager(实验管理) | **部分→平替进行中** | 本批 experimentDesign(sweep/grid/LHS+CRN+显著性)实现中;缺:实验树 UI、跨实验报告对比视图 |
| 图形化输出 Sankey / 甘特图 | **缺失** | 无实现;数据层有 trace 事件流可支撑 |
| 神经网络 + 遗传算法自动优化 | **缺失** | 无;实验层(参数扫描)是前置已补 |
| 面向对象分层建模(对象含对象、类库继承、改类即改实例) | **缺失(结构性大项)** | plantLiteModel 是平面节点列表;无类/继承/嵌套子模型 |
| 3D 建库 + JT 大模型加载 | **部分** | 场景预制体+转换链;jt-reader L2(LOD0 网格,缺法线/UV/B-rep) |
| 离散+**连续**制造流程 | **部分** | 仅 DES;无连续过程(流体/速率)对象 |
| 开放接口(COM/C/JSON/MQTT/ODBC/OPC UA/SQL/Socket) | **部分** | JSON 全线、OPC UA(虚拟调试合同层);无 MQTT/SQL/Socket 服务出口 |
| 生态集成(TIA Portal/PLCSIM Advanced/SIMIT/NX/HEEDS/Opcenter) | **缺失**(定位差异:我们走本地离线自研栈) | 虚拟调试走 OPC UA/虚拟 IO,不依赖 SIMIT/PLCSIM |
| 规模档位(500/4000/全厂对象) | **未标定** | 性能已证 60 工位 32k ev/s(优化 16.5×);对象容量上限未测 |
| VSM 价值流图库 | **缺失** | 无 |
| Runtime 档(运行/参数/实验,不建模) | **部分** | operations 页+Study 投影;无权限分档的 Runtime 产品形态 |

## 二、Process Simulate X Standard

| 官方功能 | 我们的状态 | 证据 / 差距 |
|---|---|---|
| 运动路径规划、节拍优化、机器人仿真 | **部分→平替基础进行中** | kinematics(FK/IK/梯形速度节拍/限位)实现中;已有 trajectoryEngine+auditWorkcell |
| OLP 离线编程(上传/下载机器人程序、cyclic event evaluator、emulated robot controllers、**多机器人同步**) | **缺失(结构性大项)** | 无控制器后处理、无程序往返、无多机器人互锁调度(合同层 robot.ts 仅有资产形态) |
| 虚拟调试(真实 PLC 逻辑) | **部分** | virtual-commissioning:信号/命令/故障注入/断言/套件(golden-08);**缺:真实 OPC UA 服务器连接(Live 模式)、PLC 程序导入** |
| 碰撞检测 + 2D/3D 剖切验证 | **部分** | 碰撞对+最小间距(collisionPairs、kinematics 逐点间距复用);剖切在场景编辑器已有 |
| 事件驱动仿真(logic blocks、信号、传感器、物料流控制) | **部分** | VirtualDebugScenario commands/faults/assertions;无 logic block 图形编程 |
| 人因仿真(reach/visibility/clearance/movement,MTM 标准工时) | **部分** | ergonomics.ts 工效筛查;**缺:数字人体模型、MTM 工时库、可视性分析** |
| 远程协作评审 | **部分** | 发布/公开链接/发布审计;无多人实时协同 |
| VR/动作捕捉/AI Copilot/点云插件 | **缺失**(点云格式路线已规划) | 定位为后续增值,非首版承诺 |

## 三、Teamcenter Manufacturing / Process Designer

| 官方功能 | 我们的状态 | 证据 / 差距 |
|---|---|---|
| MBOM + BOP 管理(what to make & how) | **部分**(轻量平替) | ppr.ts:PprBopVersion/PprOperation/PprComponent + ppr-lite-engine |
| MBOM 零件分配到工序 + BOE 资源指定 | **部分** | PprOperationComponentRef/PprOperationResourceAssignment 数据结构在;分配工具链弱 |
| EBOM-MBOM 对账/变更影响(accountability check) | **部分(机制刚落地)** | digitalThread:版本/冻结/基线漂移/断链诊断(golden-09);缺:设计变更自动传播闭环 UI |
| 工时估算(MTM/TiCon)+ **线平衡**(Takt 目标优化) | **部分**(初版勘误:线平衡已有确定性实现) | `ppr-lite-engine/lineBalancing.ts`:targetTakt/工位负载/理论最少工位数(与西门子 Capacity=takt×工人数 同型);缺:MTM 工时库、约束检查器、交互式平衡闭环 |
| EWI 电子作业指导书(2D/3D 可视化、版本自动更新) | **部分**(轻量平替) | workInstructions.ts + PprElectronicWorkInstruction(workInstructions 测试) |
| 跨工厂工艺复用 | **部分** | 模板/资产库/项目复制 |
| 工艺资源库 MRL(切削刀具/NX CAM 连接) | **缺失** | 无 CAM 域 |
| 车间连接(CNC/CMM/机器人下发) | **缺失(结构性大项)** | 无执行端下发;发布包仅只读查看 |
| SaaS 云部署/Share 协作 | **定位差异** | 我们坚持本地离线内置(工作区硬门槛),不做 SaaS 主张 |

## 结论:真实差距的优先级(修正后)

1. **P0-A Plant 类库与层级建模**(对象继承/嵌套/改类即改实例)——Plant Simulation 的建模根基,当前完全缺失,是"平替"叙事的最大单点风险。
2. **P0-B 线平衡增强**(MTM 工时接入+约束检查器+平衡闭环;基础求解已在 `lineBalancing.ts`)+ Sankey/甘特(Plant 标配输出)。
3. **P0-C OLP 与多机器人同步**(PS 核心)——先做确定性 emulated controller + 少数品牌程序往返。
4. **P1 真实 PLC Live 连接**(现有确定性回放层之上)、人体模型与可视性分析、Gantt/Sankey 渲染。
5. **P1 规模标定**(对象数 500/4000/更多档位的容量与性能曲线,补官方档位对照)。
6. **P2 连续过程对象、MQTT/SQL 出口、VSM 库**。

今晚在跑的三路(实验矩阵/机器人运动学/X_T-JT 质量)分别命中:Experiment Manager 基础、PS 机器人基础、JT 加载——与真实功能清单方向一致,颗粒度按上表继续校准。

## 来源

- [Tecnomatix Plant Simulation(官方)](https://www.siemens.com/en-us/products/tecnomatix/plant-simulation-software/)
- [Process Simulate X Standard(官方)](https://www.siemens.com/en-us/products/tecnomatix/offerings/process-simulate-x-standard)
- [Teamcenter Manufacturing(官方)](https://www.siemens.com/en-gb/products/teamcenter/solutions/manufacturing-process-planning-data-management/)
- [Process Simulate fact sheet(Emixa)](https://www.emixa.com/hubfs/Emixa/.../Siemens%20SW%20Process%20Simulate%20fs.pdf)
- [Xcelerator Academy Process Simulate 学习地图](https://assets.new.siemens.com)
