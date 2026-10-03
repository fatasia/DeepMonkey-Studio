# B2 渲染专项实施任务书(2026-10-04)

> 派发前置:B1 三专项(MSAA/VSM/物理调试器)收口、deep-engine 包构建恢复自洽后才能派发(同包互斥)。
> 硬门槛与验收口径同 [ue-class-b1-task-briefs-20261003.md](ue-class-b1-task-briefs-20261003.md) 头部。

## Brief-MegaLights:随机采样万灯

**目标**:≥5000 盏动态点/聚光实时直接光;面积光上限 8→64。
**复用基座**:`packages/deep-engine/src/lighting/`(areaLights.ts/ltc.ts 常量互钉、`DEEP_AREA_LIGHT_MAX=8`→扩容)、Forward+ 簇光(clusterLightingPbr)、T20 曲线 LUT、§1 BVH(compute,影子光线;若 B1 光追未就绪先用随机一灯硬阴影近似+降噪)。
**实施要点**:
1. 灯光池:统一 `MegaLight` buffer(点/聚/面积三型 union,64B/灯;IES 索引复用 iesShading);`DEEP_AREA_LIGHT_MAX 8→64` 时 **stride/LUT/打包 ABI 全链重算**(areaLights/ltc.ts 互钉测试+checksum 门同步)。
2. RIS 初始采样:像素级 K=32 候选(辐射重要度加权,LOD 化:距离衰减截断)→ 权重 resample 到 M=1;时域复用(复用 T07 motion vector);空间复用 5×5。
3. 阴影:胜者灯 1 条可见性光线(compute BVH 或 shadow map 回退);无时间闪烁门(逐帧差 p99≤2/255)。
4. 通路选择:`rendererCapabilityManifest` 加 `meg lights`(supported/degraded);≤64 盏自动走既有簇光快路径。
**验收**:①5000 动态点光(10% 移动)1080p p95 ≤20ms(Web);②与离线 512 采样参考 RMSE ≤0.05;③64 面积光 correctness RMSE ≤1%(CPU 参考);④闪烁门;⑤全测试+checksum 门绿+dist 重建。
**规模**:1-2 周。

## Brief-Nanite:mesh DAG 工具链与流式虚拟几何

**目标**:亿级三角形单资产、十万实例,draw 与规模解耦,档位渐变。
**复用基座**:G1 meshlet 批、T26 HLOD/簇决策、F3 页调度(virtualTextures 全家)、occlusionCulling/G1 剪影、GPU indirect(lodIndirectDraws)。
**实施要点**:
1. **离线工具**(Rust,`packages/deep-engine-native/geometry_dag/` 新目录):网格→meshlet 图→Quadric 逐簇简化 DAG→按屏幕误差分桶编码→`.dgc` 流式格式(分块+父子索引+边界锁定);CLI:`geometry_dag build <in> <out.dgc>`。
2. **运行时**:DGC 资源槽(仿 gaussianSplat/splatSceneSlot 模式);页调度按屏幕误差(复用 F3 feedback/驻留预算);簇剔除(既有 HiZ/遮挡);indirect 按页分组。
3. **回退**:非 DAG 资产走现有 HLOD;manifest 登记 `virtual-geometry` 双档。
**验收**:①5 亿三角形单资产,显存 ≤1.5GB,p95 ≤16.7ms@1080p;②20 万实例 draw ≤300;③相邻档切换像素差 p99 ≤2/255;④驻留稳态上传 ≤64MB/s;⑤HLOD 回归不破。
**规模**:2 周+(工具链占半)。

## Brief-GI:静态 SDF 遮蔽 + 动态探针混合

**目标/要点**:见 B1 Brief-GI;**派发前置**:先完成"A2 SDF 场景覆盖面核查"——`packages/deep-engine/src/physics/sdf*`(sdfCollisionBridge/sdfGpuQuery/sdfCollisionQueryWgsl)现有 SDF 的数据来源(哪些几何可烘焙/精度/规模),若仅碰撞代理覆盖需先补"场景级 SDF 烘焙"步骤(静态资产增量化),该核查报告先行落盘再动 GI。
**规模**:核查 0.5 天 + 实施 3-4 周。

## Brief-TSR 默认档:残影压制

**目标**:TSR 参与默认组合(与 MSAA 并存:MSAA 4x 主目标 + TSR 上采样/低动态重建),残影 2.93%→≤1%。
**要点**:几何置信度(disocclusion 深度差阈值自适应 α);透明/粒子排除出历史;与 AA 档位组合(antialiasing-master-plan §2 tsr 档)。
**验收**:扫掠逐帧差 p99 ≤2/255;残影 ≤1%;与 MSAA 组合帧预算 ≤3.2ms。
**规模**:3-5 天。

## 派发顺序建议
1. MSAA 收口后 → **MegaLights**(面积光扩容+RIS,checksum 门多,趁手热)
2. 并行第二路 → **TSR 默认档**(小,快赢)
3. **Nanite DAG**(长线,Rust 域独占)
4. A2 SDF 核查(0.5 天,主线程可做)→ **GI 派发**
