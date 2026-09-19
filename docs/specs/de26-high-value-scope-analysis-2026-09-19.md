# DE26 高价值范围重整（2026-09-19）

本文以 `de26-high-value-scope-2026-09-17.md` 为主依据，并对照 `deep-engine-execution-tasks-2026-09-16.json`、Reality Compiler 取舍和 Unity 灯光对齐方案。它解决一个常见误读：**DE26 不是第 8 项 readiness 的别名**。readiness 只是 DE26/A02 的一块证据；DE26 还包含编译链、运行时、灯光/GI、材质、动画、数据、诊断、发布和复杂工业场景。

## 1. 用户确认的范围

- 目标平台只保留 Three.js、Babylon.js、Unity；Unity 是能力/视觉参照，不是运行依赖。
- V1–V7 做扎实，V8 小而强，V9/V10/V11/V13 按真实场景补齐。
- V12（扫描现场对照 / Splat 方向）不建设；既有 E57/LAS/3D Tiles 工作不被删除，也不能夹带 V12。
- V11 属于 C07 场景搭建子切片；V13 属于 G06 数据驱动信息牌子切片。
- 删除项不回流：A05–A07、D02/D03/D07/D08、F02/F03/F06–F08、H01/H05/H06/H08、I01–I03/I06/I08、旧 V01–V05。

## 2. 机器任务基线

当前机器清单共 57 项：

- 52 项在 DE26 分母内；5 项明确排除。
- 基线文件标记 3 项已完成、49 项本轮待办；这只是 2026-09-16/18 的计划基线，不等于当前真实验收结果。
- 任务组分布：A 5、B 8、C 8、D 4、E 8、F 3、G 8、H 5、I 3（合计 52）。

当前收口必须同时看三种状态：代码实现、机器合同/测试、真实产品或跨端证据。单元测试绿灯不能把“本轮待办”直接改成完成。

## 3. 能力地图与验收重点

| 组 | 范围 | 真正要证明的结果 |
|---|---|---|
| A | A01–A04、A08 | 三引擎固定版本/任务/分母，真实资产与轨迹，统一采样，Web 成对基准和自动差距报告 |
| B | B01–B08 | 场景变化所有权、真实 RenderGraph 执行、资源/上传预算、设备恢复、后台准备和质量档切换 |
| C | C01–C08 | 失败语料、顶点色/平面/清漆/玻璃、压缩资产、增量构建/变体缓存、工业语义与 source map |
| D | D01、D04–D06 | Native 空间索引、连续重基点、持久标注、语义分区/预取、LOD/meshlet 混合场景 |
| E | E01–E08 | 色彩/能量/材质单位、多灯和受光、GI、反射、阴影投接、时序/细线、雾体积、Web/Native 逐格交付 |
| F | F01、F04、F05 | 正式动画/TRS 包、PhysicsWorld 宿主接线、机械约束与碰撞工具 |
| G | G01–G08 | Dashboard 组合、筛选/页面编译、权威资源读取、正式编译下载、二维三维数据版本与增量 |
| H | H02–H04、H07、H09 | 对象到 GPU 诊断、统一 Profiler、材质调试、增量原子回滚、可计划/校验/回滚的 agent 事务 |
| I | I04、I05、I07 | 点云/Tiles 混合园区、双骨 IK、可复现故障包与设备诊断 |

## 4. Unity 对标不是一句“支持光照”

E 组的增强验收至少要分别证明：

1. 多方向/点/聚光/面积光的语义、单位、衰减、范围、锥角和灯/对象影响层；
2. 每灯、每对象独立投影/接影，CSM、点光全向、聚光和软阴影有真实执行证据；
3. 静态/动态 GI、脏域更新、遮挡变化、室内外过渡和漏光边界；不能用 AO、Bloom 或自发光冒充 GI；
4. 反射探针/SSR 回退，以及金属、粗糙度、法线、清漆、玻璃的受光一致性；
5. 普通/实例/LOD/镜像/非均匀缩放/动画模型的受光和投影；
6. 作者修改→预览→保存→发布→Web/Native 离线重开，灯光、材质、探针和质量档不丢失。

功能、最终视觉、运动稳定、性能成本必须分开记账；一张截图或一个 SSIM 数值不能替代语义验收。

## 5. 依赖图和并行收尾顺序

```text
A02/A03/A04/A08 ─┬─> B03/B05/B06/B07/B08
                 ├─> C01/C06/C07/C08 ─> V11/V1/V2
                 ├─> E01/E02 ─> E03/E04/E05/E08 ─> V6/V9/V10
                 ├─> G01/G03/G06 ─> V3/V13
                 ├─> F01/F04/F05
                 └─> H02/H03/H04/H07/H09 ─> V5/V8
D04/D05/D06 与 I04/I05/I07 可在资产和运行预算证据具备后并行
```

当前并行策略：

- **动态运行包**：继续把正式 v7 resource/entrypoint 接到编译器，并补实际消费；这是 F01 与发布链的一部分。
- **GI/灯光**：继续 GI-off、复杂几何、Native 同照明和 E03/E05 语义矩阵；不放宽阈值。
- **工业**：继续 S1–S6 的真实 profile、混合场景和 OS 证据；工业结果只按 builtin/local/offline 约束记账。
- **DE26 readiness**：补 A02 的覆盖率/缺口机器包和真实负载；它不能替代其余 DE26 卡。
- **V11**：走 C07 真实场景拖放搭建、保存发布和重开；派生 GLB 只能关闭几何 gate，不能关闭产品链。
- **4 发布 OS、6 D24–D28**：保留现有 partial/blocked，不阻塞其他 lane，也不改成通过。

## 6. 完成判定

DE26 只有在相应任务卡的实现、测试、真实证据和报告都齐全时才可关闭。以下情况必须保持 partial/review-required/blocked：

- 只有 ABI/validator，没有消费者；
- 只有派生资产统计，没有源级 RVT 统计；
- 只有 Web 证据，没有 Native/离线重开；
- 只有单灯或单模型截图，没有灯/对象层和阴影语义；
- 只有计划、文件存在或单元测试，没有真实产品链路；
- 用 Unity 商业组件替代项目内置离线实现。

本文件是范围和依赖整理，不把任何新增计划计入完成率。

## 7. 引擎对标补充（2026-09-19 主线程核查，按用户要求新增）

用户要求：对比 Unity、Three.js、Babylon.js、UE5 及其未来版本新特性，找出全面超越还缺什么。纪律不变：平台参照分母仍是 Three.js、Babylon.js、Unity；UE 是能力/系统设计参照，不恢复已删除的 UE 原生基准（A05–A07 不回流）。以下均为能力参照，不是运行依赖。

### 7.1 版本事实（2026-09-19 网络核实）

| 引擎 | 当前版本 | 关键新特性 | 未来版本（已公布） | 依据 |
|---|---|---|---|---|
| Unity | 6.4（2026-03-17） | ECS 转核心包；Project Auditor 内置；Adaptive Performance 重设计；Multiplayer Matchmaker | **Unity 7**：Unite Seoul 2026-07-20 公布路线图，2026-12 early Beta，2027Q1 GA；**统一渲染管线**（替代 URP/HDRP 双轨，破坏性变更） | [Unity 7 Roadmap](https://unity.com)、[Unity 6.4 发布讨论](https://discussions.unity.com) |
| Unreal | 5.8（2026-06-23） | **MegaLights 生产化**（万级动态投影灯，典型场景 60fps）；**Lumen Lite**（Irradiance Fields 中档 GI）；Nanite 持续增强 | 5.9 定位性能/稳定/打磨；**UE6 EA 目标 2027 年底**，GA 再 12–18 个月 | [UE 5.8 发布](https://www.unrealengine.com)、[The road to UE6](https://www.unrealengine.com) |
| Three.js | r186（季度节奏） | WebGPU 后端生产化；TSL 节点着色；WebGL→WebGPU 一行迁移 | r187+ 季度迭代；**2026-05 起 WebGPU 成为 Baseline**（Chrome/Edge/Firefox/Safari 默认启用），WebGPU-first、WebGL 降为兼容层 | [Releases](https://github.com/mrdoob/three.js/releases)、[What's New in Three.js 2026](https://www.utsubo.com) |
| Babylon.js | 9.0（2026-03-26） | **Clustered Lighting**、**Frame Graph**、体积效果增强、地理空间渲染、**Gaussian Splatting**、动画重定向、Node Particle Editor、Inspector 重写 | 9.x 持续成熟 Clustered/FrameGraph/Inspector 工具链 | [Babylon 9.0 公告](https://forum.babylonjs.com)、[Windows Developer Blog](https://blogs.windows.com) |

### 7.2 能力映射：DE26 已有对位

| 引擎特性 | DE26 归属 | 结论 |
|---|---|---|
| Babylon 9 Clustered Lighting | E05 + B05（V9 真实灯阵），已有 `lighting/clusterGrid.ts` | 有基础，验收在 E05 P0 |
| Babylon 9 / Unity 统一管线 Frame Graph | B03（V4），已有 `webgpu/pbrFrameGraph.ts` + 执行器 | 有基础，须追真实提交证据 |
| Unity APV/SSGI、UE Lumen/Lumen Lite | E03（P0），探针 clipmap 已有 | 有基础，静态/动态 GI、脏域更新逐格验收 |
| UE MegaLights（万级投影灯） | E05 仅到 32/128/256 灯阵 | **缺口 G1**，见 7.3 |
| UE Nanite 虚拟几何、Unity GPU Resident Drawer | D06 meshlet/LOD 验证 | **缺口 G2** |
| UE World Partition/HLOD | D05 语义分区/预取 | **缺口 G3**（编译期 HLOD 自动化） |
| Unity Asset Transformer / UE Datasmith（CAD/BIM 导入优化） | C08 溯源 + C07 构建 + 工业 S1–S6 | 对位良好且更可审计（见 7.4） |
| Babylon 9 地理空间渲染 | I04 点云/Tiles 混合园区 | **缺口 G4**（地理坐标系） |
| Babylon 9 Gaussian Splatting | V12 用户决议不建设 | 不建设；记录为竞争监测点 |
| Babylon 9 动画重定向 | F01 正式动画包 | 工业场景非优先，不新增 |
| Unity Project Auditor / Babylon Inspector | H02/H03 对象到 GPU 诊断、统一 Profiler | 对位良好 |
| Unity Multiplayer/Matchmaker | 无 | 决策点 D2，不夹带 |
| WebGPU Baseline（2026-05） | A 组双轨验收 | **策略缺口 G5** |

### 7.3 缺口清单（全面超越要补的；均为提案，待用户拍板后才入排期）

| 编号 | 缺口 | 为什么是超越必需 | 建议归属 | 量级/先决 |
|---|---|---|---|---|
| G1 | 虚拟化多灯阴影采样（MegaLights 级）：千灯级 stochastic light sampling（虚拟灯列表+重要性采样+时序复用），而非仅 cluster + CSM | UE 5.8 已把万级动态投影灯做到生产；E05 的 32/128/256 是正确第一步但不是终点 | E05 远期扩展卡 | 大；先决 E03/E05 P0 收口 |
| G2 | GPU-driven 剔除与虚拟几何：HiZ/GPU 遮挡剔除生产接线、meshlet 管线闭环；虚拟几何（Nanite 级）按需 | Unity GPU Resident Drawer 与 UE Nanite 已把"CPU 提交瓶颈"消掉；BIM 大场景卡顿主因 | D06 + B05 | 中；meshlet 基础已在 D06 |
| G3 | 编译期 HLOD/自动简化链：impostor、自动 LOD 链、分区烘焙 | UE World Partition 有运行时分区分层；我们的编译链形态更适合编译期烘焙 | C07（编译链阶段）+ D06 | 中；复用 C06 压缩资产 |
| G4 | 地理坐标系与底图对齐：CRS 转换、WGS84/投影适配、底图分层 | Babylon 9 已原生 geospatial；园区→城市级客户必问 | I04 相邻新切片 | 中；厂区级客户可延后 |
| G5 | WebGPU-first 验收策略：2026-05 起 WebGPU 已是四浏览器 Baseline；建议 WebGPU 定为主验收通道、WebGL 为兼容层；Three 社区暴露的 WebGPU 阴影/性能回归案例纳入我们的测试语料 | 引擎路线已定，双轨同权重会浪费验收预算 | A01/A02 政策，不改分母 | 小；政策调整 |
| G6 | 引擎版本漂移政策：Unity 7（2027Q1，统一管线破坏性）与 Three 季度版会打穿 A01 冻结 | 无重冻结政策，跨端对拍基线半年内失效 | A01：季度重冻结 + 差异记录；Unity 7 GA 后做一次 URP/HDRP→统一管线迁移对拍 | 小；政策 |
| G7 | 真实体积介质：现有 exp2 雾是高度雾；E06 雾体积须升级为参与介质（光线步进/散射）并与灯光/阴影联动 | UE 体积雾、Babylon 9 volumetric 增强都是标配；工业氛围感差距点 | E06（已有卡，补验收格） | 中 |
| G8 | 编译链 AI 辅助：自动资产诊断（缺项/单位/降级建议）、自然语言→H09 事务计划 | Unity Muse/Sentis 路线；我们的 H09 可校验回滚事务是独有落点，自然语言只是调用端 | H09/C08 扩展 | 中；不建聊天界面 |
| G9 | 多人协同评审（决策点 D2）：多人标记/漫游/状态共享 | Unity multiplayer/Matchmaker 信号；工业评审有真实需求但当前无卡 | 待拍板 | 未排期 |
| G10 | XR/WebXR（决策点 D3）：Unity/UE/Babylon 全部原生支持 | 工业培训/评审可选需求；当前无卡 | 待拍板 | 未排期 |

### 7.4 反超差异化：四引擎都不作为产品提供的

这些是已确认范围，不是新增计划；对标时必须先讲这五条，再比渲染能力：

1. **可追溯编译链**：SourceBundle→稳定构件 ID→source map→质量诊断，能回答"哪个源构件为什么缺失/变形"。Unity Asset Transformer 只做导入与优化，无可审计性。
2. **增量构建 + 原子回滚发布**：受影响产物集合、LKG、候选呈现、失败回退；引擎资产管线没有这套交付语义。
3. **双端确定性交付**：同一冻结运行包在 WebGL/WebGPU/Native 确定性重放（主线第②项正在收口）。
4. **内置本地离线工业格式链**：JT/X_T/RVT 自研 profile + builtin/local/offline 纪律；Three/Babylon 生态无，UE Datasmith 是商业桌面工作流。
5. **受限 agent 事务（H09）**：可计划、可校验、可回滚的场景事务；四引擎均无产品化对位。

### 7.5 战略窗口

- 2026-05 WebGPU Baseline → 2026-12 Unity 7 Beta → 2027Q1 Unity 7 GA（统一管线破坏性迁移）→ 2027 底 UE6 EA：两大商业引擎在同一窗口集中做破坏性大版本迁移，迁移成本压在他们用户侧；这 18 个月是把 DE26 基础卡收口、G1–G7 从提案转排期的窗口。
- 推进顺序不变：先 E03/E05 P0、编译链与 readiness 收口（与当前收尾线共用证据），再启动 G1–G3 类大扩展；新增项一律不计入完成率。
- 待用户拍板的决策点：**D1** G1/G2/G3 是否纳入 DE26 排期；**D2** 多人协同评审；**D3** XR；**D4** 地理坐标深度（G4）。在拍板前，以上不建卡、不排期、不计分母。

> **2026-09-19 用户拍板记录**：原文档内容全部同意；第 7 节新分析同意并作为后续任务——G1/G2/G3（D1 通过）、G5、G6、G7、G8 批准；**G9 多人协同、G4 地理坐标深度排除**；G10 XR 未提及，留待。总目标升级：**性能、效果、核心能力三个维度全面超越 Unity/Three/Babylon/UE**。批准项为后续任务，不计入当前完成率。

## 8. 下一版本革命性特性 → 我们应该做的（2026-09-19 主线程分析，按用户要求新增）

总目标：性能、效果、核心能力全面超越。本节回答"四平台下一版本各自的革命性武器是什么，我们对位做什么才算超越"。判断标准：对位项必须在我们手里以**跨端确定性 + 可审计证据**的形态落地，而不是同功能复刻。

### 8.1 四平台下一版本的革命性武器（2026-09-19 核实）

| 平台 | 革命性特性 | 本质 | 依据 |
|---|---|---|---|
| Unity 7（2026-12 Beta → 2027Q1 GA） | **Surface Cache GI**（实时全局光照）；统一渲染管线 | 用表面缓存把 GI 从烘焙带入实时，全平台一个管线 | [Unity 7 Roadmap](https://unity.com) |
| UE 6（2027 底 EA） | **AI 原生引擎**：AI-driven features、Verse 语言取代 Blueprint、引擎作为"连接层" | 脚本模型重写 + AI 进入引擎内核 | [The road to UE6](https://www.unrealengine.com) |
| Three.js r187+（季度） | **TSL 跨后端着色 + Compute**：一套 JS 风格节点着色同编 WGSL/GLSL，compute 已用于物理/碰撞 | 着色与计算与后端解耦 | [Releases](https://github.com/mrdoob/three.js/releases)、[migration guide](https://www.utsubo.com) |
| Babylon 9.x | **WebGPU 光线追踪（in-progress）**、Frame Graph 扩展、compute 深入光照/物理 | Web 端硬件光追 + 全图 compute 化 | [WebGPU Support](https://doc.babylonjs.com) |

### 8.2 对位与超越：我们应该做的（R1–R5，均已获用户方向批准，按依赖排期）

| 编号 | 我们应该做的 | 对位/超越逻辑 | 归属与先决 | 验收口径 |
|---|---|---|---|---|
| R1 | **跨端实时 GI 生产化**：把已有探针 clipmap（`probeClipmapRuntime.ts`/`probeClipmapPbrController.ts`）升级为 Unity 7 Surface Cache GI 对位——表面缓存 + 脏域更新 + Web/Native 同语义 | Unity/UE 的 GI 都不进浏览器；我们的 GI 必须在 WebGL/WebGPU/Native 三端同照明、同阈值、同误差预算——这是它们给不了的形态 | E03（P0）+ G7 体积介质；先决 E03 静态/动态逐格通过 | 三端同场景 GI 数值阈值 + 脏域更新延迟 + 漏光边界；禁用 AO/Bloom 冒充 |
| R2 | **跨后端着色 IR + Compute**：一套着色 IR 同编 WGSL（WebGPU）/GLSL（WebGL）/WGSL（Native wgpu），compute 先落 GI 探针更新、HiZ 剔除、万灯采样三个消费点 | Three TSL 不编译到 Native 后端；Babylon compute 不跨端确定性。"一套着色源 × 三后端 × 确定性结果"是独有形态 | shaderAuthoring 体系扩展；先决 G1/G2 启动 | 同一 shader 源三端渲染数值一致（基准场景逐字节/阈值双档）+ compute 用例进统一 Profiler |
| R3 | **确定性作为产品能力**：把 ② 的 canonical 帧合同推广到物理（F04）、数据回放（G06）、剖切/标注状态机——"同输入必同输出"写成运行时合同 | 四平台无一以"跨端确定性重放"为产品承诺；这是工业验收/事故复盘的硬需求 | F01/F04 + G06；基础已由 dynamic-frame-v1 验证 | 三端帧/步 digest 一致性进入每类运行对象的门禁，故障包可复现（I07 呼应） |
| R4 | **万灯 + GPU-driven 超越组合拳**（=已批准 G1+G2 合并执行视图）：虚拟灯列表+重要性采样+时序复用；HiZ+meshlet 两段剔除；对象级预算账本 | UE MegaLights 万灯 60fps、Unity GPU Resident Drawer 是"单端游戏场景"；我们要在 Web+Native 双端、BIM 语义场景（灯=设备/回路）下达到同量级 | E05/B05/D06 联合切片；先决 R2 compute 基座 | 256→1024→4096 灯梯度实测（投影灯单列），P50/P95/P99 + 显存账本逐档记录；对拍 Unity 同场景 |
| R5 | **AI 可校验编译链**（=已批准 G8 强化）：UE6 把 AI 塞进引擎内核；我们把 AI 放在编译链与事务层——资产诊断（缺项/单位/降级）、自然语言→H09 事务计划，全部带预览/校验/回滚/操作记录 | UE 的 AI 是助手；我们的 AI 每一步可审计可回滚——工业客户要的是"AI 改了什么、错了怎么退"，不是聊天窗口 | H09/C08 扩展；先决 H09 事务卡收口 | 每次 AI 产出都有 diff+校验结果+回执；故意坏输入的负例矩阵 |

**观察项（不承诺）**：WebGPU 硬件光追（Babylon in-progress）——等 Babylon 发布后评估 compute RT 反射对 E04 的增益，仍以探针+SSR 混合为基线，不把光追写进验收分母。

### 8.3 执行纪律

- R1–R5 是后续任务排期依据，不改变当前收尾线（⑥⑦⑧）优先级；与 5.5 依赖图一致：R2 是 R4 的先决，R1 与 E03 P0 同线，R3 随 F/G 卡顺路铺。
- 全面超越的记账方式：每季度用 A 组固定基准重测四平台对位场景（G6 重冻结政策），以实测数字而非愿景句进报告；未测不写超越。
