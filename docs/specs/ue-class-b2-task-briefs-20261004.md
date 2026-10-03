# B2 渲染专项实施任务书(2026-10-04)

> 派发前置:B1 三专项(MSAA/VSM/物理调试器)收口、deep-engine 包构建恢复自洽后才能派发(同包互斥)。
> 硬门槛与验收口径同 [ue-class-b1-task-briefs-20261003.md](ue-class-b1-task-briefs-20261003.md) 头部。

## Brief-MegaLights:随机采样万灯

**目标**:≥5000 盏动态点/聚光实时直接光;面积光上限 8→64。
**复用基座**:`packages/deep-engine/src/lighting/`(areaLights.ts/ltc.ts 常量互钉、`DEEP_AREA_LIGHT_MAX=8`→扩容)、Forward+ 簇光(clusterLightingPbr)、T20 曲线 LUT、§1 BVH(compute,影子光线;若 B1 光追未就绪先用随机一灯硬阴影近似+降噪)。
**实施要点**:
1. 灯光池:统一 `MegaLight` buffer(点/聚/面积三型 union,64B/灯;IES 索引复用 iesShading);`DEEP_AREA_LIGHT_MAX 8→64` 时 **stride/LUT/打包 ABI 全链重算**(areaLights.ts:17 与 wgsl/ltcAreaLighting.wgsl:13 互钉测试+checksum 门同步)。
   **扩容禁独立交付(2026-10-04 盘点)**:现有簇光是逐灯着色,裸扩 64 盏=每像素循环成本 ↑8×,帧时爆炸——面积光扩容必须与 RIS 采样同批交付(LUT 表 64×64×2 与灯数无关,只改灯数组 6KB,风险可控)。
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
**核查结论(2026-10-04 主线程已完成)**:SDF 基座工程化完备——mesh→SDF 提取(≤65,536 三角形,sdfCollisionBridge)、GPU dispatch、查询 WGSL(checksum 门)、真值 fixture、内存预算档(MAX_SDF_PROFILE_GRID_CELLS)。**场景级聚合 SDF 烘焙缺失**(现状按刚体局部网格)——GI 的 M1 第一步=补"静态场景合成 SDF 3D 纹理"烘焙(增量静态资产+天光可见性共用该纹理),工作量 +2-3 天计入实施。

### Brief-GI 实施结果(2026-10-04,M1 已交付)

**已有(不重建,A2 核查结论成立)**:SDF 基座(sdfGrid.buildSdfGrid/sdfCollisionProfile 内存档/
sdfCollisionQueryWgsl checksum 门)、probe 家族(16/32 方向档、probeOcclusionDirection Fibonacci
权威、probeClipmapSampling 8-tap+Chebyshev+法线权重采样链、F5 words[12..23] L1 SH 逐位合同)、
C12 whiteFurnace、atmosphereSky 物理大气。**真实缺口(M1 补齐)**:场景级聚合 SDF 烘焙、
SDF 圆锥天光追踪、探针 SH 更新的①天光遮蔽②SSGDI 输入与时域滤波、sdf-gi 能力登记。

**交付物**(全部 ≤300 行,`@bim-studio/deep-engine/gi` 子路径导出):
1. `src/gi/sdfSceneBake.ts`+`sdfSceneBakeGrid.ts`:场景级 SDF 烘焙 —— 静态实例世界系
   **min 合成闭体并集**(`"aabb"` 逐资产域 ±1 cell 缺省 / `"scene"` 全场景域精确覆盖),
   资产哈希增量缓存(fingerprintFloat32,场景重划分不清缓存),动态实例排除并逐条报告,
   规模墙 fail-visible(三角形/网格/采样预算跳过 + 原因),内存档复用
   MAX_SDF_PROFILE_GRID_CELLS/estimateSdfCollisionMemory;产出即 physics `SdfGrid`。
2. `wgsl/sdfSkyVisibilityTrace.wgsl` + `src/gi/sdfSkyVisibility.ts`:天光遮蔽 compute 单源
   (每 lane = 探针方向 × SDF 8..16 步圆锥软阴影口径,固定步数无 early-break,域外
   **fail-open=1** 光照语义),CPU f32 同序镜像;checksum+naga 门
   (sdfSkyVisibilityTraceWgslChecksum.test.ts)。
3. `src/gi/probeSkyVisibilitySh.ts`+`probeShUpdate.ts`:可见度→L1 SH 投影(白炉构造:均匀场
   dipole 精确零);探针 SH 更新接受①天光遮蔽②SSGDI 输入,时域滤波 α=0.1(fail-closed
   解析),埋入探针透传,**F5 words[12..23] 捕获块原样透传**(白炉 gate≡1 逐位负控不动),
   occlusionFloor=可见度均值,几何统计(meanDistance/variance)按捕获侧合同注入
   ——实测踩坑:缺统计时 Chebyshev 采样链整列拒绝(已在合同注释钉死)。
4. `src/gi/sdfGiDayNight.ts`+`sdfGiShade.ts`:昼夜循环 CPU 参考 harness(参考房间 12 静态盒
   烘焙 60,192 cells;252 探针×16 方向;物理大气天空,仰角=22°·sin(方位角) 自然入夜;
   GI-only 着色 + 显示曝光,直射项属生产直射通路不在本刀)。
5. 合同:`displayContract.gi`(`DisplayGiMode "off"|"sdf-probe"` + temporalAlpha,缺字段=off
   零迁移,resolveDisplayGiMode/resolveDisplayGiTemporalAlpha fail-closed 单源);
   `rendererCapabilityManifest` 登记 `sdf-gi`(web=degraded/harness-only,native=unavailable/
   absent)+ deep-engine 自检行 + native `renderer_capability_manifest.rs` 自检行 + 金样
   fixtures/renderer-capability-manifest.json 重生成,三方对拍 22/22 绿。

**验收证据**(`test-output/gi/`:evidence.json + day/night 1080p PNG + sha256):
①昼夜循环旋转天光(0.25°/帧,全循环 1440 帧=60fps 24s,含日出最陡段,预热 16 帧分离收敛
瞬态)逐帧像素差 **p99=1 ≤3/255**;②F5-L5 三区封门哨兵 + 白炉逐位负控 +
probeRecordIrradianceSemantics + wallLeak + leakDirectionMatrix 全绿(gi+哨兵合跑 82/82,
拆分后复跑全绿);③C12 whiteFurnace 测试全绿(16/16);④探针 SH 更新 CPU 侧
252×16 p95=0.56ms ≤6ms(GPU 圆锥追踪 1.57M trilinear 采样/帧 ≈亚毫秒级,真机帧时归 GPU
联测);⑤lab parity 场景 ibl/ibl-hq 不在本刀失败集(vitest 全量失败集 =
pbrShadowState/c8F32Inputs/megaLights*/deviceSession/textureArray*/outputFamily/pipelines,
全部并行在途域,与本刀文件零交集);⑥tsc 主:src/gi 零错误(仅并行 megaLights 在途
19 错,committed 破损非本刀引入)+ lab:仅 megaLights 域;`npm run build` 重建 dist 完成
(tsc 对在途 megaLights 报错但按仓内 noEmitOnError 缺省继续 emit,dist/gi 十文件完整且
`import('./dist/gi/index.js')` 运行时加载通过;contracts dist 同步重建,金样/合同落位);
⑦昼夜对比 1080p 深色截图 ×2(day sha256=927a4800…,night feee55d3…,GI-only 着色,
太阳亮斑/门洞 GI 梯度昼夜可辨)。

**边界披露(诚实条款)**:生产 pbrRenderer 的 GPU dispatch 接线(捕获核消费 SDF 纹理)
属后续切片,M1 交付引擎侧通路(compute 单源 + CPU 权威镜像 + 更新合同),web 能力档如实
登记 degraded/harness-only;真机 GPU 帧时与 verify:gpu-release 未跑(GPU 窗口归主线程,
与 F5 先例同口径);aabb 域模式多资产未覆盖空域为 exterior 有界近似(光照量语义,已在
合同注释声明,验收用 "scene" 域);runtimePurityGate 的既有违规
(pbrRendererFrames 等)为并行在途域,sdfGiDayNight 的 performance 计时已移到测试/证据侧
保持 src 纯净。

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
