# 西门子 Tecnomatix 三产品深度调研:功能语义与客户价值(2026-09-26)

> 定位:本文是 `siemens-pps-feature-parity-matrix-2026-09-26.md`(官方产品页对位矩阵)的**深度篇**,
> 把理解从"营销页功能清单"推进到"手册/教材/论文级"的工程语义。
> 纪律:每个论断标注来源;营销话术(标注 `[营销]`)与工程事实(标注 `[工程]`)分开;
> 查不到的如实写"未获取",禁止编造。

## 0. 信息源与可信度分级

| 级别 | 来源 | 用途 |
|---|---|---|
| S1 官方手册全文 | Teamcenter 2606《Manufacturing Process Planning ─ Usage》1024 页(经西门子 Documentation Server 镜像 siemens-docs.dev.mait-group.com 获取 PDF,SHA 见文末) | PD/MPP 全部语义 |
| S2 官方文档/学习路径 | Xcelerator Academy 学习路径 trackID=76;docs.sw.siemens.com 搜索索引(正文需登录,仅取课程结构与主题名) | PS 培训骨架 |
| S3 教材/大学教程 | Twente 大学《Simulation Modelling using Practical Examples: A Plant Simulation Tutorial》(Mes, 2017, v13, 192 页 CC BY-NC-ND PDF) | Plant 工作流/类库/继承/SimTalk/实验 |
| S4 同行评审论文 | Siderska 2016《Production Processes Management by Simulation in Tecnomatix Plant Simulation》(J.ECOPER);Baskaran et al. 2019《Digital Human and Robot Simulation in Automotive Assembly using Siemens Process Simulate: A Feasibility Study》Procedia Manufacturing 34:986-994;Dumitrașcu & Dincă《Virtual Commissioning of a Robotic Cell using Tecnomatix Process Simulate》(AOS Review, Technika 9(1)) | 真实用法与功能清单 |
| S5 学位论文/实施商 | CTU Prague 硕士论文(Konopa 2013,91 页,Process Simulate OLP+虚拟调试+真实 KUKA KRC4);Long-term Tec(PS 金牌代理)PS Essentials 5 天大纲;SimTool(合作伙伴)Bottleneck/Sankey 技术文章;Siemens 社区论坛帖 | OLP 细节、碰撞配置、培训大纲 |
| S6 搜索摘要/二手 | Siemens 玻璃/太阳能白皮书摘要、INOPROD 页、Dentsu Soken 页 | 仅作佐证,单独标注 |

本地留存原件:`D:\Download\pps-research\`(twente-tutorial.pdf / mpp-usage.pdf / ps-feasibility 相关研究全文 / ctu-thesis.pdf / aos-vc.pdf)。

---

# 第 1 章 Plant Simulation

## 1.1 用户角色与一天的工作流 [S3/S4]

角色:工艺工程师 / 仿真工程师(制造规划部门),输入是工厂/产线方案(布局、设备清单、节拍数据、故障率),输出是"决策证据"——吞吐量对比、瓶颈结论、方案投资建议。

典型一天(DES 仿真研究的标准循环,S3 第 1 章定义;每个环节的功能与输入输出):

| 步 | 动作 | 用到的功能 | 输入 | 输出 |
|---|---|---|---|---|
| 1 | 摸底与数据收集 | (模型外)现场调研 | 真实产线 | 节拍、故障率(MTTR/MTBF)、班次、物流规则 |
| 2 | 建骨架 | 拖 Class Library/Toolbox 中的 Source→SingleProc→Buffer→Drain 到 Frame,用 Connector 连接 | 设备清单 | 能跑的拓扑模型 |
| 3 | 参数化 | 双击对象对话框:Processing time(支持 Const/Negexp 等分布)、Failure(故障)、Setup | 步 1 数据 | 标定后的模型(时间格式 DD:HH:MM:SS.xxxx) |
| 4 | 校验/验证 | EventController(Start/Stop/Step 单步/Fast forward/统计起点),事件列表调试 | 模型 | "模型可信"的证据(S3 强调 verification 与 validation 是报告可信度的前提) |
| 5 | 运行分析 | 对象自带统计(利用率、阻塞、等待)+ Chart/Report | 多次运行 | 利用率表、瓶颈定位 |
| 6 | 实验 | ExperimentManager:输入变量→实验矩阵→N 次复制→置信区间对比 | 方案参数范围 | 显著性对比表+曲线,方案排序 |
| 7 | 优化 | GAWizard(遗传算法)/ExperimentManager 实验设计 | 适应度函数 | 近优参数组合 |
| 8 | 汇报 | Chart、Excel 导出、报告 | 全部结果 | 管理层决策建议 |

S3 第 1 章原话式要点:建模是**循环迭代**的("start with a first draft then refine"),仿真工程师永远要回答四个问题:要达成什么、在考察什么、得出什么结论、如何把结果转回真实系统。
关键纪律(S3 5.10/8.7):正式实验前必须确定 **warm-up period、run length、replications 数量**,用 KPI 曲线是否进入稳态来论证——这是"实验可信"的统计学骨架。

## 1.2 类库与继承:建模效率的根基 [S3,工程语义]

Plant Simulation 是**完全面向对象**的(S3 2.1 原话 "completely object-oriented")。核心机制(全部有教程任务背书):

- **类 vs 实例**:Class Library 中的是类;拖入 Frame 的是实例。类不表示个体,只声明属性(age、appointmentTime 这类 user-defined attribute);实例化后各实例属性值可以不同。
- **内置类层级**:默认 8 个文件夹(MaterialFlow 的 Source/SingleProc/ParallelProc/Buffer/Line/Sorter、MUs 的 Entity/Container、InformationFlow 的 Method/TableFile 等)。"GeneralPractitioner"例子:右键 SingleProc→Duplicate 得到类(不是实例!)——**Duplicate=派生但断开继承的复制**,教程明确区分 derive(保持继承)与 duplicate(同内容独立副本)。
- **改类即改实例**:在 Class Library 里把 GeneralPractitioner 的 Processing time 改成 15:00,模型里所有派生实例同步生效;反方向不传播——**改实例上的继承属性会自动"断开该属性的继承"**(教程任务:改了 Arrival 实例的 interval 后,回看 Source 类仍是 0)。粒度是**属性级**的覆写开关。
- **MU 也走同一套继承**:Patient 类派生 Adult/Child,加 isVaccinated 属性;图标(icon)也有独立的 Inherit Image 开关;TableFile 有 Inherit Format。
- **Frame 即组合类**:把多个对象+连接器+Method 装进一个 Frame,Frame 本身成为新类,可再派生(教程第 7 章"Frames as Building Blocks"造了 4 个同源工位)。改 Frame 类,所有实例传播;实例上动过的属性停止传播——教程专门用一节讲"继承在手动改过的 Frame 里部分失效"的排查(Show Inheritance 菜单可视化继承链)。
- **为什么是根基**(教程给出的理由):只创建配置一次而非每个实例配一遍;扩模型时省时间;改一处全局生效。500/4000 对象档位的产品价值就建立在这上面——没有类库,大模型维护成本指数上升。

对 MUs(移动单元)还有:**@.origin 指向父类**,运行期可查"我属于哪个类"。

## 1.3 实验/分析三件套的输出语义

### ExperimentManager [S3 9.2,S4-Siderska]
- 输入:Define Input Variables(把全局 Variable 拖进表);Define Experiments(矩阵:每行一个方案,勾选启用;支持 **Multi-level(下界/上界/步长全组合)、Two-level(2^k 因析)、Random(界内随机)**三种实验设计自动生成矩阵);Define Output Values(输出变量表);Observations per experiment(复制次数)。
- 处理:自动禁用 MU/图标动画提性能;每方案跑 N 次复制。
- 输出:Evaluation 页,Intervals=Confidence 置信区间;**自动收集输出变量均值、标准差、以及判定方案间差异是否显著的 p 值**;图表按输出变量画曲线。详细结果(逐复制)可导出为数据集表再进 Excel。
- 与我们 experimentDesign(sweep/grid/LHS+CRN+显著性)的对位语义一致:S3 的"实验=变量矩阵+复制+置信区间"就是产品级定义。

### Bottleneck Analyzer [S4-Siderska + S5-SimTool]
- 配置:作为对象放进模型层级,设定观测期、采样频率、瓶颈判定阈值;多次复制(不同随机种子)以区分"系统性瓶颈"与"统计噪声"[S5]。
- 观测:不只是利用率——**同时看 blocking(下游堵它)与 starvation(它饿着下游)**;真瓶颈=高占用 + 引发下游饥饿/上游阻塞的组合;能抓到随产品组合/换型/随机故障**迁移的瞬时瓶颈**[S5]。
- 输出:排序的瓶颈报告——利用率、阻塞时长、饥饿时长、综合瓶颈指数(index 同时加权直接占用与对系统的间接影响)[S5]。
- 决策:回答"约束来自产能不足、缓存摆放不当,还是上游波动"。
- 学术佐证:Siderska 论文与"Identification of production bottlenecks with the use of Plant Simulation"论文都把"最大利用率统计"作为瓶颈定位口径 [S4]。
- (注:S5-SimTool 的 config 细节是实施商口径,官方手册原文未获取;但与 S4 论文的机制描述一致。)

### Sankey / Gantt [S4-Siderska + S5-SimTool]
- Sankey Diagram(Plant Simulation 内置分析工具,Siderska 明确列出):**线宽∝物料流量**,显示各站点间流量的量化分布;瓶颈表现为可视化"收窄点"。可叠加多指标(件数、周期、WIP、增值含量),颜色编码超阈值利用率站点,支持动画观察瓶颈迁移 [S5]。决策价值:给非技术干系人沟通流向结论 + 为 buffer 重排/并行化/改路由的 what-if 提供直觉。
- Gantt:PD 侧有 Process Gantt(见第 3 章);Plant 侧甘特语义来自 VSM/资源日历场景,Siderska 列表未直接点名 Plant Gantt——**Plant 内"甘特"形态在已获取文档中未单独成节(未获取),以 chart/图表工具与班次日历为准**。
- Chart Wizard:识别"资源过剩"(resource excess)的工具 [S4]。

## 1.4 SimTalk 与 Method:什么场景必须写代码 [S3]

- 载体:InformationFlow 的 **Method 对象**;SimTalk 1.0(is/do/end 语法)与 2.0(类 Pascal:var 声明、F7 编译、`+=`、`~=`)可混用,2.0 默认。
- 传感器-执行器原则(sensor-actor theorem):物料流对象在**入口/出口触发控件**(Entrance/Exit control)上调用 Method;`@` 是触发 MU 的匿名游标,`?` 是触发对象本身。推(push)=Method 里 `@.move(目的地)`;拉(pull)=在设备 Exit control 里查询等待区并 `move` 下一个。
- 教程明确:模型越复杂,越要**删掉 Connector、让 Method 全权搬运 MU**(路由、驻留、优先级)。什么时候必须写代码(教程全部实例):
  1. 按 MU 属性分流(成人/儿童 → 不同等待室)——静态连线表达不了;
  2. 排序/优先级调度(Sorter 的 sorting Method 返回 real 排序值,支持 On Entry/On Access 两种重排时机);
  3. 跨对象联动(下工位空闲才叫料;Table 回收循环 ReturnTables);
  4. 自定义统计采集(把每个 MU 的等待/服务明细写进 TableFile,导出 Excel);
  5. 事件编程(向 EventController 事件列表加事件)。
- 工程含义:**对象库+控件钩子+SimTalk = DES 领域的"可编程行为层"**;没有它,只能表达串行流水线;有了它,才能表达真实车间的路由/调度/返工逻辑。

## 1.5 能耗与成本口径 [S4 + S6,部分未获取]

- Siderska 论文:成本计算基于**资源成本+物料+人工+管理费**分摊,可按对象/时段汇总 [S4]。
- 能耗口径:能源分析按**对象在各个运行状态(working/idle/blocked/failed 等)分别定义功率,仿真按状态×时长积分**得出单对象/单产品能耗 [S6,搜索摘要级佐证;具体属性名未在已获取原文中核对 → 精确字段名未获取]。班次经 ShiftCalendar 定义(见下),能耗统计窗口与统计起点(EventController 的 Statistics 时刻)对齐。
- ShiftCalendar 语义 [S3 8.4]:每个日历含多个班次(起止时刻、按星期勾选、休息段用分号分隔);**非人力对象靠拖拽进 Resources 页挂到日历**;班次结束时有未完成工序→暂停,设备进入 "Waiting for an Exporter" 状态(橙色 LED),资源回来续跑;Source 勾 Blocking 则跨班次攒批。
- Worker 体系(把"人"建成一等资源)[S3 7/8 章]:Worker 类(步行速度、提供哪些 Service、效率 %),WorkerPool 的 CreationTable 批量生成,Workplace 声明 Supported Services,Importer/Exporter 声明需要 Basic/Expert 服务——**人力是"按技能匹配的服务调度"**,不是简单占用。

## 1.6 与另两产品的数据流

- Plant Simulation 是**独立 DES 产品**,数据接口:Siderska 列出 Excel/Access/Oracle/SAP/AutoCAD 导入;官方生态叙事 [营销] 提 TIA Portal/Opcenter/HEEDS 集成。
- **PD→Plant 的直接 BOP 管道:未获取到文档证据**。实务上(未获取实施商证据,按接口推断)工艺工时/产品组合以 Excel/CSV/数据库导出方式进 Plant。PD 与 Plant 的关系是"分工":PD 管工艺结构与工时平衡,Plant 管物流/吞吐/库存/瓶颈的动态验证。

---

# 第 2 章 Process Simulate(PS)

## 2.1 用户角色与核心工作流 [S4/S5/S2]

角色:制造/机器人/人因工程师(工艺验证岗)。输入:产品 JT(从 NX/CAD 链)、工位资源模型、工艺操作定义(来自 PD)。输出:验证过的工艺(可行、无碰撞、节拍达标)、机器人程序、人因报告。

主工作流(五步,综合 S4 论文、S5 论文与 S2 课程大纲):

| 步 | 输入 | 处理(功能) | 输出 |
|---|---|---|---|
| 1 场景准备 | CAD(经 NX 转 JT)、资源库 | Import Component(定义组件类型、放置 placement)、define kinematics(关节/限位/位姿 pose)、装工具(tool mounting)、Smart Placement(按可达性摆机器人) | 有运动学的工位(workcell) [S2-LT 大纲 Day1] |
| 2 定义操作 | 工艺清单 | 在 Operation Tree 建 operation(分类见 2.2),compound operation 组层级,sequence editing 排序 | 工艺序列 |
| 3 路径规划 | 焊点/抓取点 | 建 target(weld point)、rob operation 下生成路径;joint limits/reach 校验;Tool Path/Swept Volume 检查;碰撞对设置;路径平滑与速度优化 [S2-LT Day2] | 无碰撞、节拍优化的运动路径 |
| 4 仿真验证 | 时序逻辑 | 时间仿真(Standard 模式)/事件仿真(CEE,Line Simulation 模式);信号+传感器+Logic Block+PLC 模块;碰撞/间隙检查 | 节拍报告、碰撞报告、事件时序 |
| 5 下发 | 验证过的路径 | OLP:机器人专用控制器包,生成程序文件下载到真机;真机调好的程序可上传回 PS 调优 | 机器人程序(.src/.dat/.olp/.log 等)、OLP round-trip [S5-CTU] |

数据入口 [S4 论文实录]:CAD→NX→**JT 兼容格式**→Process Simulate 导入;产品/资源/操作在 Teamcenter MPP 里以 study 为单位下发(见第 3/4 章)。

## 2.2 Operation:PS 的语义中枢 [S5-CTU 3.4.3,权威分类]

PS 的一切验证围绕 **operation 树**。类型与语义(CTU 论文逐条定义):

| Operation 类型 | 语义 | 挂靠对象 |
|---|---|---|
| Compound Operation | 层级容器,可嵌套 | 树结构 |
| Object Flow Operation | 把一个对象从 A 搬到 B | 物料 |
| Device Operation | 设备从 pose A 到 pose B(pose=一组关节值;如夹爪 OPEN/CLOSE) | 有运动学的设备 |
| Device Control Group Op | 一组同构设备一起做 pose 切换 | 设备组 |
| Gripper Operation | 抓取/释放 | 夹爪 |
| Pick and Place | 机器人+夹爪搬件 | 机器人 |
| Weld Operation | 机器人+焊枪,在零件上打焊点 | 机器人 |
| Continuous Operation | 激光焊/涂胶等连续轨迹 | 机器人+工具 |
| Non-Sim Operation | 空操作:占时间窗/作 CEE 迁移前置条件 | 树 |
| Robot Path Reference Op | Line Simulation 模式下微调机器人程序 | 机器人程序 |
| Swept Volume | 操作的扫掠包络(检查工作空间) | 分析对象 |
| Interference Volume | 两个 Swept Volume 的交集(检查双机工作空间冲突) | 分析对象 |

与 PD 的贯通:Siemens 社区帖显示 PD 的 LineProcess 下挂的子操作类型就是 ManualOperation、WeldOperation 这一套 [S5-社区]——**同一 operation 模型贯穿规划与仿真**。

## 2.3 OLP 真实流程:控制器、程序往返、CEE、多机同步 [S5-CTU,S2]

**控制器三层现实**:
1. **默认控制器**(PS 内置):适用于所有机器人,精度≈真机 80%——点位相同、路径形状可能不同;
2. **RCS 模块(Realistic Robot Simulation)**:机器人厂商提供的运动学/规划精确模型,按 RRS1 标准,精度≈95%;KUKA 实例:OLP 包(如 KUKA-Krc)+ RCS 模块(带 MADA 机器数据)+ TuneAddOn,从 Siemens GTAC 下载映射表安装;
3. **OLP 包内容**(以 KUKA 为例):仿真控制器、**示教器界面(Teach Pendant,可换关节解)**、程序下载器(生成 *.src/*.dat/*.olp/*.log)、**程序上传器**(真机程序回灌 PS 再调优)。

**RCS 的诚实边界**(论文列出):不模拟振动等动力学特性、不模拟机器人 IO、不模拟外力/惯量(夹持力/点焊反力)、不模拟柔性线缆 [S5-CTU]。

**信号体系**(CEE 事件仿真的控制平面)[S5-CTU 4.2.2]:
- 四类信号:**Key**(PS 内部用户输入)、**Display**(仅显示)、**Resource Input Signal**(从 PLC 视角是输入——如"操作结束"上报)、**Resource Output Signal**(从 PLC 视角是输出——触发操作开始);
- 每个操作默认带**操作结束信号**;Signal Generation 菜单可批量生成 robot/device/material-flow/non-sim 操作的触发信号;
- **设备信号自动生成**:选设备一键生成 pose 信号 + pose 间移动操作 + pose 传感器——焊枪/夹爪/灯堆不用逐个手工建;
- Signal Viewer 查看全部信号、编辑、过滤、映射到 OPC;Simulation Panel 监控选中信号。
- 传感器三类 [S5-AOS]:Proximity/Photoelectric(3D 表示+位置+**可探测对象白名单**,进入范围触发;也用于安全区停机)、Property Sensor(Property Projector 把条码/重量/颜色等属性投到零件上,按属性识别)、Joint Value Sensor(关节值进容差带→发信号,模拟真机到位反馈)。
- Smart Device + **Logic Block**:逻辑存在资源 JT 内;Logic Block 监听输入信号触发动作,支持 BOOL/INT/DWORD/Real;**LB 的输入=PLC 的输出,LB 的输出=PLC 的输入**,与 PLC 逻辑紧耦合 [S5-AOS]。CEE 里迁移(transition)用操作结束信号作默认条件;末操作结束→仿真复位 [S5-AOS]。

**多机器人同步**:机制=信号互锁。每台机器人的操作有触发/结束信号,信号经"中央控制信号表"与 PLC 通讯(CTU 论文表 4.7 "PLC communication with robot controllers");机器人间握手靠 Resource I/O 信号与传感器联动;人机协作仿真里,人体模型上的接近传感器也能触发机器人信号 [S4 论文 HRC 实例]。("多机器人同步"作为产品卖点词来自官方页 [营销];机制层的文档证据即上述信号互锁。)

**PLC/虚拟调试连接** [S5-CTU 4.2.2.6]:
- 仿真 PLC:SIMIT 或 PLCSIM。PLCSIM 走 PS 的 **COM 接口直连,免 OPC**;SIMIT/真 PLC 走 **OPC**(PS 是 OPC 客户端,Simatic.NET OPC server;OPC DA 读写实数据);
- 时延:客户端侧非实时同步,量级数百 ms——对虚拟调试可接受(论文原话);
- SIMIT 作为与 PS OPC 仿真同步的服务器,"虚拟时间内该做的事都做完才进下一步";
- 真机闭环:CTU 实例把程序下载到真实 KUKA KRC4,PLC 经 **PROFINET** 连真机器人,SFC(TIA Portal)写 PLC 逻辑,OPC server 桥接仿真。

## 2.4 碰撞检测配置语义 [S5-PS Basic 培训文档片段]

- **Collision Setup 工具箱**内创建 **collision list pairs(碰撞对)并设置 clearance(间隙)**;沿路径运动过程中对这些对做动态检查 [S5 原文引用]。
- 语义:碰撞检查是**白名单对集**而非全局两两检查——先声明"谁对谁敏感+最小间隙",运行期逐步长校验。Swept Volume/Interference Volume 提供空间级的粗筛(见 2.2)[S5-CTU]。
- "时序窗口"(只在某操作时段启用某碰撞对)语义:**未在已获取文档中找到**(未获取)。已证实的粒度是"路径上持续检查的对集+间隙值"。

## 2.5 人因仿真 [S4 论文,全文级证据]

- 人体模型:内置**人体数据库(ANSUR 美军人体测量库)**,按性别+身高/体重百分位实例化人体;任务原语三种:**Go(走)/Get(抓)/Put(放)**——每个任务定义起点、终点、时长、负载;
- 姿势调整:手动调姿态,或用预定义姿势库;
- 工效输出四件套(全部论文实测):
  1. **NIOSH 提举方程**:Recommended Weight Limit(RWL)与 Lifting Index(LI),评估搬运任务;
  2. **OWAS**:姿势分类与 action category(需否干预分级);
  3. **Lower Back Analysis(LBA)**:按第 4/5 腰椎(V4/V5)计算压力与力矩,对照 NIOSH 阈值(论文用 3.4 kN 压力 / 0.6 kN·m 力矩口径,即 22.5MN 与 0.6MNms 数值对应关系按论文图);
  4. **疲劳分析**:按关节输出恢复所需时间(recovery time per joint);
- 人机协作:人体与机器人共享信号(论文实例:抓具上的 proximity sensor 触发信号控制机器人);
- 论文指出的产品边界(工程事实,反营销):运动是**开环**的——无闭环反馈、无实时机器人数据交换、无接触力交换;
- 标准佐证:实施商页列 Jack/PS Human 工效分析=NIOSH/RULA/OWAS [S6-INOPROD];**EAWS 未在已获取 PS 文档中证实**(未获取;EAWS 是独立分析体系,常见的 PS 集成方式未验证)。

## 2.6 与另两产品的数据流

- **PD→PS**:study 承载仿真数据,Send To→Process Simulate / Tools→Open with Process Simulate;传对象+XML+JT 图形;isolated study 里可切换 event-based/time-based 数据 [S1-MPP 手册 9-47]。仿真用到的操作/资源/产品都来自 PD 的 BOP/资源库。
- **PS→PD/TC 回流**:MPP 手册确认 study 同步/发布机制存在("Synchronize to study or publish from study");**具体回流字段(如实测节拍写回 BOP 工时)未在已获取文档中展开(未获取)**。
- **PS→Plant**:无直接管道证据(未获取)。分工:PS 管"一个工位内的运动/程序/人因",Plant 管"整厂物流吞吐"。

---

# 第 3 章 Process Designer(PD,即 Teamcenter Manufacturing Process Planner)

> 依据:S1——Teamcenter 2606 官方手册《Manufacturing Process Planning ─ Usage》(1024 页)逐节阅读。PD 的载体是 Teamcenter 富客户端中的 Manufacturing Process Planner(MPP)应用。

## 3.1 PD 是什么、不是什么

- 官方定义 [S1 第 1 章]:"让设计与制造工程师**并发**开发产品与制造规划"的协作框架;目标是设计/工艺/工厂/供应商进一个虚拟企业;在概念规划早期评估替代制造方案、最大化资源利用、优化产出。
- 载体形态:不是独立 3D 软件,而是 Teamcenter 里的**视图(perspective)+ 协作上下文(Collaboration Context, CC)**系统:三大主结构视图 Product/Process/Plant + 数十个次级视图(见 3.2),选择联动(selection synchronization)贯穿全部视图 [S1 3 章]。

## 3.2 三大对象与 PPR 三元组实例化 [S1,精确语义]

PD 的数据模型是 PPR(Product/Process/Resource):

| 对象 | 结构视图 | 精确定义(手册原文口径) |
|---|---|---|
| **Product** | Product 结构 / EBOM / MBOM | 要造的产品层级树;EBOM(CAD 分解)→MBOM(按制造需求重组);EBOM-MBOM **必须持续对账**(accountability check)以反映设计与制造变更 [S1 3 章] |
| **Process** | Process 结构 / Product BOP / Plant BOP / Generic BOP | "有单一目的的操作有序序列";子过程+操作;可含并行/替代流程;**final assembly 中一个 process 通常 5-10 个操作**;每个 process 有输出(装好的子系统)[S1 12-2] |
| **Operation** | 同上 | **可分配到工厂的最小工作单元**(例:取尾灯/拧螺丝);可分解为 **activities(动作)**;可消耗零件(consume)、可指定资源 [S1 12-2] |
| **Resource/Plant** | Plant 结构 / BOE | 厂区→work area→work station 层级的物理位置树;Plant BOP 展示装配所需的资源 [S1 3 章] |

**企业 BOP(EBOP)三层结构** [S1 12-1]:
- **Generic BOP**:产品族级通用工艺(例:任何型号皮卡的通用造法),用标准工序搭,排除型号特有内容;
- **Product BOP**:某型号在任意工厂的通用工艺,派生自 generic BOP;
- **Plant BOP**:某厂/某工站的工艺,**从 Product BOP 分配(allocation)而来**,用于时序分析、线平衡、仿真、工具与技能需求派生;
- **Partition**:组织工序分组的容器(非 process 本身),**无版本化**(内容不跟踪修订,配置条件不该挂在 partition 上),可嵌套;
- **Logical Designator(逻辑标识符)**:跨 BOP 映射同一用途对象的键(例:装大灯 process 在所有 BOP 里同一个 LD);operation 的 LD 通常从所属 process 的 LD 派生;**人工与自动化两条替代工艺共用同一 LD**。

**分配(allocation)机制** [S1 12-42]:把 product BOP 的 process/operation 分配到 plant BOP 时,**TC 创建克隆(clone)挂进 plant BOP,并维护 origin link**;分配 process=连带其全部子操作、消耗零件、操作间流(flow)、更深层级、上下文配置数据。变更后用 accountability check 找差异→propagate 传播到 plant BOP。**拆分工艺的坑**(手册明示):一个 process 横跨两个工站时,应分配其子操作而不是分配整个 process 再删——删掉的子操作会在每次传播时回来。**新型号自动分配**:按 logical designator 匹配参考 product BOP 的既有分配,一次性动作,带 CSV 预览。

## 3.3 线平衡:工时从哪来、Takt 怎么算、怎么解 [S1 12-88~12-110]

**定义** [S1 12-88]:"把装配线任务均分到工站与资源,减少闲置/过载的工人时间以提高生产率";解法手段=最小化工站间周期、最少工站数、优化工站人员分配。

**工作流七步** [S1 12-89]:
1. 建 Product BOP 并链接(link)Plant BOP(放在一个 CC 里);
2. PERT 视图定 plant BOP 的**工站顺序**;
3. Product BOP 里定义**优先约束**(precedence constraints);
4. 定义各工站的 **Process Resource(=工人或机器)**与 cycle time;
5. 把操作从 product BOP 分配到 plant BOP;
6. 补厂内特有时间(非增值时间);
7. 平衡 process 与资源。

**工时来源**(回答"工时从哪来") [S1 12-94~96 与 7 章]:
- 手工:在 plant BOP 表格直接填 **Allocated Time**(逐操作/逐工站);
- 标准:Time view 里挂 **activities**——每条 activity 含 **Code(工时标准编码)/Unit Time(单元时间)/Frequency(频次)/Work Time(=unit×freq)/Category(时间类别,如 Value Added)**;
- 标准+TiCon:MTM data card(内置 MTM 数据卡,选任务即带名称+unit time+code)或 **TiCon Search 视图**(经 web service 查外部 TiCon 时限系统,取时间元素建 activity 或覆写现有 activity,可同步 TiCon 侧变更)[S1 3-9/7-120];
- 结构规则:activity 树父节点时间=子节点累计;有时间的节点不能再加子节点(防双重计)。

**Takt 与 Capacity 公式** [S1 12-93/96]:
- 不用 process resource:**Capacity = takt time × 工人数**;
- 用 process resource:**Capacity = Σ(takt × 该资源 capacity%)**(capacity% 是资源上的 0-100 属性);
- 图中红线=产能线;各工站 cycle time 不同时,灰线=首个非零周期工站周期的整数倍;**计算取结构顶部工站的周期**为全线周期;
- 前置条件:必须定义 production program(链接的 product BOP)才能定义约束/变体/查约束。

**视图与决策闭环** [S1 12-90/12-105~110]:
- Line Balancing Chart station view:横轴=工站,纵柱=该站分配的操作/过程耗时;details view:再按 process resource(工人/机器)细分;**未分配操作高亮蓝色**,已分配灰色,拖拽即重分配;
- 约束:操作可"必须并行"(例:两部件须同时装完才能合装)、"必须顺序"(例:先装螺栓再拧紧——顺序组应定义成 manufacturing process 以保序)、"特定工站限定"(专用工具所在)、"合并成本约束"(工人走动过长→闲置+疲劳) [S1 12-89];
- Line Balancing Constraints view 定义顺序;**Constraints Consistency 检查**找约束成环;**Constraints Violation 检查**找"分配顺序违反工站流"的违例;点违例联动高亮相关操作 [S1 12-110];
- 偏好开关:MELBChartProcessOperationTypes(OP/Process 切换只看操作或只看过程)、MELBChartStationTypes=Mfg0MEProcStatn 等(实施细节层,证明这套东西是配置驱动的企业软件)。

## 3.4 变更管理:ECN→工艺→回归→EWI 链路 [S1 13 章]

- **MCN(Manufacturing Change Notice)= 面向制造场景的 ECN**:用来自动跟踪并更新跨视图的 MBOM/BOP 变更,并且**只把变化部分发给 ERP** [S1 13-1]。
- 完整链路(手册流程图逐条) [S1 13-1~13-11]:
  1. 上游(董事会/ERP)决定制造变更,通知 lead planner;
  2. Lead planner 在 My Teamcenter 建 MCN:描述、**release status(MEMCN_release_statuses 偏好定义,经 workflow process 模板驱动)**、**生效期(effectivity date range)**、指派 process planner;
  3. Process planner 在 MPP 里 **Set Change Notice 到 BOP/MBOM 结构**(生效期必须与结构 revision rule 配置匹配,否则设不上)→ 之后的一切编辑被自动捕获(新增/修订的行进 MCN 的 Solution Items;旧修订进 Impacted Items);
  4. Add/Remove to Change Notice(可含子层级 Include subhierarchies;自定义对象要进 closure rule 偏好才被跟踪);
  5. Lead planner **Review**(Change Tracker:按 unit/date effectivity 列出变更,可标记处理、可传播到目标结构、可查某 item revision 影响哪些结构)→ 验证数据 → **发送变更后的 BOP/MBOM 数据到 ERP**(可导出带生效 MCN 的自定义工作流);
- **增量变更(Incremental change)是高级工具,手册原话警告部署前咨询西门子代表** [S1 13-1];
- 结构级防线:MBOM/BOE 行可整体替换;EBOM-MBOM accountability check 常规化(Advanced 版可比较多类结构、可"修复一结构到另一结构"、可设偏匹配准则——比如忽略"派生结构里新建的、无 origin 的厂内专用操作")[S1 3-229];
- **EWI 链路**:文本类 work instruction 由 **Standard Text 库(文件夹+元素)组装**,促进跨厂标准化;ProcessOperation 报告、baseline/PDI/dry run 支撑发布审批 [S1 10/11 章 TOC]。"EWI 随版本自动更新"的机制基础=WI 元素挂在 BOP 行上,行随 MCN/版本走(具体 WI 自动重发布流程**未在已获取章节展开,未获取**)。

## 3.5 与另两产品的数据流 [S1 9-47]

- **PD→PS**:study 存仿真数据;Send To→Process Simulate(每次开新实例)或 Tools→Open with(并入当前会话);传递对象+XML+JT;isolated study 支持事件/时间两套数据切换;Study 视图也用于工具设计包;
- **PD→车间/ERP**:MCN 差量下发(见 3.4);
- **PD→Plant**:无直接文档管道(未获取,同 1.6)。

---

# 第 4 章 三产品数据线程全景图(文字版)

以"一个焊装工位的生命周期"串起(每件东西在哪创建、流向哪、谁消费):

1. **EBOM**(工程 CAD,如 NX)——源头。经 NX→**JT** 成为一切 3D 的载体。
2. **MBOM**(PD/TC 内):从 EBOM 派生、按制造重组;accountability check 与 EBOM 对账;MCN 管它的变更。消费者:PD 全流程、ERP。
3. **工艺结构**(PD):Generic BOP→Product BOP(型号工艺)→Plant BOP(厂内工艺,clone+origin link);Partition/LD 组织与映射;**工时挂在 Time view 的 activities 上(MTM/TiCon/手填)**。
4. **资源结构**(PD):Plant/BOE(work area→station);工位内设备资源(机器人/焊枪/夹具)3D 模型在资源库,JT 形态。
5. **分配与平衡**(PD):allocation 产生 plant BOP 实例;线平衡图上拖拽调载;约束一致性/违例检查守序。
6. **Study 下发**(PD→PS):一个 CC/study 打包 产品+资源+操作+3D → Process Simulate。
7. **工位仿真**(PS):定义运动学/路径/信号/Logic Block;时间仿真验证节拍;CEE 事件仿真验证互锁;碰撞对+间隙验证安全;人因任务+NIOSH/OWAS/LBA 验证人站。结果(节拍、可行性)属于 study。
8. **程序下发**(PS→真机):OLP 控制器包生成程序→下载;真机微调→上传回 PS(回路)。
9. **EWI**(PD→车间):BOP 行+标准文本→作业指导;版本随 MCN 走。
10. **变更回环**:EBOM 变→accountability check 发现 MBOM 漂移→MCN 捕获 BOP 修改→重平衡/重仿真(PS 回归)→差量发 ERP。
11. **Plant Simulation** 在线程中的位置:**旁路并行**——拿产品组合+节拍+布局(经 Excel/DB 接口)做全厂吞吐/瓶颈/库存/能耗动态验证,验证结论反哺布局与缓存决策,而不是直接消费 BOP 对象。(此为已获取文档的口径;若某客户实施中打通 BOP→Plant 管道,未获取证据。)

一句话:**PD 是工艺数据的唯一真源(single source of truth for process),PS 是它的运动/事件验证器与程序生成器,Plant 是旁路的工厂级动力学沙盘。** 三者共享的对象词汇只有两套:PPR/operation(PD↔PS)与时间/班次/成本(Plant↔PD 的报告口径)。

---

# 第 5 章 对 Deep Monkey Studio 的功能级启示

> 格式:该功能解决的真实决策 → 我们对位该做什么 → 现有代码最接近的结构(已核查 `packages/`)。
> 现状核查已确认(2026-09-26):`plant-lite-simulation`(engine/metrics/energyRuntime/experimentDesign/operatingCalendar/transportNetwork)、`ppr-lite-engine`(lineBalancing/workInstructions/comparison/variantProjection)、`workcell-validation-plugin`(kinematics/trajectoryEngine/ergonomicsScreening/collisionPairs)、`contracts/src/ppr.ts`、`virtual-commissioning-plugin`。

1. **类库与继承是 Plant 平替的合法性前提**
   - 决策:客户维护 4000 对象模型时,"改一处全部生效"是每天省几小时的事;没有它,大模型不可维护。
   - 对位:plantLiteModel 目前是平面节点列表(parity 矩阵已判"缺失")。最小正确语义=**类模板(节点类型+属性默认)+实例(属性级覆写开关)+改模板传播(仅未覆写属性)+嵌套 Frame(子图作为可实例化模板)**。不必上 SimTalk,但要有"行为钩子"等价物(入口/出口/故障回调)。
   - 最近结构:`packages/plant-lite-simulation/src/modelTypes.ts`(节点定义)+ `templates.ts`(可扩展为类模板层)。

2. **实验管理器 = 变量矩阵 + 复制 + 置信区间 + 显著性,一个都不能少**
   - 决策:"两条线哪种布局好"必须是统计答案,不是单次运行答案;客户会被咨询顾问用 p 值和 CI 质询。
   - 对位:experimentDesign(sweep/grid/LHS)+CRN+显著性已实现(已核查 `experimentDesign.ts`/`experimentAnalysis.ts`);缺口是**实验树 UI 与跨实验对比视图**(矩阵 P0 已列)。补齐时对齐 S3 的三个纪律:warm-up 判定、run length、replications——把这三个做成实验向导的强制步骤,就是超平替差异点。
   - 最近结构:`experimentDesign.ts` + `statistics.ts`。

3. **瓶颈判据要"利用+上下游拥堵"复合,不是单看利用率**
   - 决策:真瓶颈=高占用且制造下游饥饿/上游阻塞;瞬时瓶颈随产品组合迁移。
   - 对位:现有 `metrics.ts` bottleneckNodeId + BottleneckFrequency(基于堵塞频率)方向正确;补"复合指数":对每节点并行采集 blocked/starved 时长(上游因它满、下游因它空),输出排序报告。trace 事件流(`trace.ts`)已有原料。
   - 最近结构:`metrics.ts` + `trace.ts`;Sankey 用 trace 的流量对 +甘特用 timeline 已有数据层(矩阵判 Sankey/Gantt 缺失,数据层可支撑)。

4. **能耗口径=状态×功率,不是均值电耗**
   - 决策:客户要回答"这台炉子待机一小时多少钱""换班次表省多少电"。
   - 对位:energy95 已含电费/碳排/峰值需量;对位西门子应显式建**每状态功率表**(working/idle/blocked/down 各自 kW),并与 operatingCalendar(班次)和 EventController 统计起点对齐;输出按对象/按产品单耗两张表。(精确属性名官方文档未核对到,但状态×功率口径有多源佐证[S6]。)
   - 最近结构:`energyRuntime.ts` + `operatingCalendar.ts`。

5. **PS 对位:operation 是树,不是任务列表**
   - 决策:工位验证的本质是"操作序列在设备/人/信号约束下的可行性",compound/device/weld/pick&place 的类型差异决定验证器行为(设备 op 查 pose 切换,焊 op 查焊点可达+焊枪开合)。
   - 对位:workcell-validation 已有 kinematics/trajectoryEngine/collisionPairs;应把 `contracts/src/operations.ts` 的操作模型升级为**带类型判别联合的 operation 树**(compound 容器+叶子类型+每叶子的验证语义),并实现 Swept Volume/Interference Volume 两个低成本高价值的分析输出(采样轨迹做包络、两包络求交)。
   - 最近结构:`workcell-validation-plugin/src/trajectoryEngine.ts`、`contracts/src/operations.ts`。

6. **碰撞=显式碰撞对集+间隙值+沿路径检查,克制而诚实**
   - 决策:全局两两碰撞在大装配上既慢又全是噪声;客户要的是"机械手 vs 夹具"这种受控对。
   - 对位:现有 collisionPairs+最小间距已是同一语义(parity 矩阵"部分");补两件事:对集 UI(命名集合+每对 clearance)+**沿轨迹的分步检查报告**(哪一步、哪两件、间隙多少)。"时序窗口"无官方文档证据,不做承诺。
   - 最近结构:`workcell-validation-plugin/src/engine.ts`(collisionPairs)。

7. **CEE 事件仿真=信号+传感器+逻辑块,我们已有骨架**
   - 决策:虚拟调试的核心不是动画,是"PLC 写的逻辑对不对"。
   - 对位:virtual-commissioning 的信号/命令/故障注入/断言(golden-08)正是四类信号+传感器的对位;按 CTU 论文的诚实边界声明:仿真不模拟 IO 物理层/接触力/柔性线缆。Logic Block 对位=规则节点(输入信号→条件→输出信号),存储在资源资产里(西门子存在 JT 内,我们存在资产包)。
   - 最近结构:`virtual-commissioning-plugin` + contracts 的 robot/IO 资产。

8. **OLP 的第一块该做"emulated controller + 程序往返"而不是全套 RCS**
   - 决策:客户验证程序语法与点位,不完全依赖 RRS 精度;默认控制器 80% 精度本身就是西门子的产品档位。
   - 对位:kinematics(FK/IK/梯形速度)之上,做一个**品牌后处理器(先 1-2 个品牌)+上传解析器**,生成/回读程序文本;在文档里写明与 RCS(RRS1,95%)的精度差距,不冒充。
   - 最近结构:`workcell-validation-plugin/src/kinematics.ts`(路径生成端)。

9. **人因:任务原语(Go/Get/Put)+标准输出,先做 NIOSH/OWAS/RULA 三件**
   - 决策:人因报告的价值在"可引用的标准分数",不在人体动画。
   - 对位:ergonomicsScreening 已有工效筛查;升级路径=人体模型(百分位参数化)→任务原语→**按标准输出分数**(NIOSH RWL/LI、OWAS 类别、RULA 分;LBA/疲劳后置);EAWS 不承诺(未获取其 PS 集成证据)。
   - 最近结构:`workcell-validation-plugin/src/ergonomicsScreening.ts`。

10. **PD 对位:我们的 ppr.ts 已是"三个结构+分配"的形状,补的是企业语义**
    - 决策:工艺数据真源的门槛不在数据结构,在**变更与复用语义**:allocation=clone+origin link、LD 跨型号复用、MCN 差量捕获、accountability check。
    - 对位:`contracts/src/ppr.ts`(PprBopVersion/PprOperation/PprComponent)+ digitalThread(版本/冻结/基线漂移,golden-09)已具备骨架;按手册语义补:①origin link 与"从 product BOP 传播到 plant BOP"的显式命令;②logical designator 属性+按 LD 的自动分配;③MCN 式变更集(捕获 diff、按生效期设状态、导出差量)。**split-process 的坑直接写进产品规则**:跨站工艺只允许分配子操作。
    - 最近结构:`ppr-lite-engine/src/comparison.ts`(对账)+ `contracts/src/digitalThread` 相关。

11. **线平衡:我们已有确定性计算,补"约束+拖拽闭环+检查器"**
    - 决策:平衡的真实工作流不是算一次,是"拖操作→看红线→查违例"的循环。
    - 对位:已核查 `ppr-lite-engine/src/lineBalancing.ts` 已算 takt/效率/理论最小工站/超载工站(比 parity 矩阵记的"缺失"更好,矩阵该行应改为"部分");补:①工站 Process Resource 分层(工位-人,含 capacity%);②优先约束(PERT 前置图)+一致性/违例检查器(成环检测+站序违反检测);③工时来源挂 activities(code/unit time/frequency/work time/category),对位 MTM 的"数据卡"抽象(内置一套通用 MTM 系码表,外部 TiCon 用导入对接,不做云依赖——符合工作区本地离线硬门槛)。
    - 最近结构:`lineBalancing.ts`(80 行,已读)+ `ppr.ts` 的 standardTimeMinutes。

12. **EWI 与标准文本:把"工艺行→指导书"做成编译,而不是文档**
    - 决策:跨厂一致性的本质是标准文本复用+行级引用,版本变更时指导书随行更新。
    - 对位:workInstructions.ts(PprElectronicWorkInstruction)已有;补 Standard Text 元素库(文本片段+数据采集定义+符号)与"BOP 行引用编译"语义。
    - 最近结构:`ppr-lite-engine/src/workInstructions.ts`。

13. **数据线程叙事:明确"谁是真源"**
    - 决策:客户问"改了 EBOM,工艺/仿真/指导书谁动"。
    - 对位:把第 4 章全景图落成产品架构声明:ppr 包=真源,workcell-validation=工位验证器,plant-lite=厂级沙盘(经导入对接口,不做 BOP 直连承诺),digitalThread=变更回环。当前三包已各自成立;缺的是**跨包的 study 概念**(一个 CC 打包产品+资源+操作下发给工位验证、结果挂回)——这是三产品一体感的真正粘合剂,建议作为 ppr-lite-engine 的下一个大项。

---

# 附录 A:未获取清单(诚实声明)

1. Plant Simulation 官方手册正文(support.industry.siemens.com / docs.sw.siemens.com 正文需登录;公开搜索索引可用,内容端点拒绝匿名会话)。Scribd 上的 Student Guide 未抓取正文(平台付费墙)。
2. Process Simulate 官方 Reference Manual 正文(docs.sw.siemens.com 有 12.1.3/15.0/2301 版索引,内容端点需会话)。已用 CTU 论文+论文+课程大纲交叉替代。
3. Plant "Gantt" 独立功能节的文档证据(以 chart 工具与 Siderska 工具列表为准)。
4. 能耗分析精确属性名/对话框字段(口径有多源佐证,字段名未核对)。
5. PS 碰撞检测的"时序窗口"语义;EAWS 在 PS Human 中的原生集成证据。
6. PS 仿真结果回流 Teamcenter 的字段级清单(存在 study 同步机制,细节未获取)。
7. PD→Plant Simulation 的官方直连管道证据。
8. Xcelerator Academy "Plant Simulation Associate" 认证大纲原文(仅获得 PS Robotics 轨道 88h 结构与课程主题;Plant 轨道未获取)。
9. 多机器人同步作为具名功能的官方手册章节(机制=信号互锁,有论文与社区证据;具名章节未获取)。

# 附录 B:来源清单(全文引用处已标 S 编号)

- S1 Teamcenter 2606《Manufacturing Process Planning ─ Usage》,Siemens,1024 页 PDF(2025 版权头)。镜像:siemens-docs.dev.mait-group.com/documentation/external/PL20251212545240207/en-US/tc_help/Manufacturing Process Planning  Usage.pdf(本地:D:\Download\pps-research\mpp-usage.pdf)
- S2a Xcelerator Academy Learning Track "Robotics Simulation Engineer (Standalone)" trackID=76(3 课 88h);S2b Long-term Tec《Process Simulate Essentials Training》5 天大纲(longtermtec.com/process-simulate-essentials-training)
- S3 Martijn Mes《Simulation Modelling using Practical Examples: A Plant Simulation Tutorial》Univ. of Twente 2017(utwente.nl/.../tutorialplantsimulation13-v20171017.pdf,CC BY-NC-ND)
- S4a J. Siderska《Production Processes Management by Simulation in Tecnomatix Plant Simulation》J.ECOPER 2016(researchgate 277662116,经 webReader 全文);S4b S.S. Baskaran et al.《Digital Human and Robot Simulation in Automotive Assembly using Siemens Process Simulate: A Feasibility Study》Procedia Manufacturing 34 (2019) 986-994(researchgate 334556194,经 webReader 全文)
- S5a M. Konopa《Diploma Thesis:Virtual commissioning...》CTU Prague 2013,91 页(wiki.control.fel.cvut.cz/.../Dp_2013_konopa_miroslav.pdf);S5b Dumitrașcu & Dincă《Virtual Commissioning of a robotic cell using Tecnomatix Process Simulate》AOS Review Vol.9 Nr.1(aos.ro/wp-content/anale/TVol9Nr1Art.5.pdf);S5c PS Basic 培训文档(Collision Setup 引文,经搜索命中 Scribd 藏本);S5d Siemens Community 帖"PD: How to traverse a process tree..."(2020);S5e SimTool《Bottleneck Analysis in Siemens Plant Simulation...》
- S6a Siemens 玻璃/太阳能行业能源优化白皮书(assets.new.siemens.com,经搜索摘要,佐证状态×功率口径);S6b INOPROD Jack/PS Human 工效分析页(404 于本次抓取,内容来自搜索摘要);S6c Dentsu Soken Tecnomatix 页(营销数字,仅作 [营销] 佐证)
- 我方代码(对位栏):packages/plant-lite-simulation/src/*、packages/ppr-lite-engine/src/*、packages/workcell-validation-plugin/src/*、packages/contracts/src/{ppr,operations}.ts、packages/virtual-commissioning-plugin(均于 2026-09-26 实读)
