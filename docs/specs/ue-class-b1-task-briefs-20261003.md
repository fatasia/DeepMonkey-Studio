# B1 三专项实施任务书(2026-10-03)

> 每个 brief 是独立可派发单元(子智能体 prompt 底稿)。派发前须按"六步现状核查"复核引用文件仍存在。
> 硬门槛:自研/开源内置、本地离线;每专项带绝对指标验收门;改 deep-engine/web 源码后重建对应 dist;不 git commit。

## Brief-VSM:三环 clipmap 虚拟阴影

**目标**:替换现有 CSM 主阴影为虚拟阴影图(16k² 等效),级联保留为回退档。
**复用基座**:`packages/deep-engine/src/virtualTextures/`(页表 plan/commit/rollback/evict)+ `webgpu/virtualTexture{Residency,ResidencyBudget,PagePacking}.ts`(页池/预算已真机达标 SSIM 0.9927,见 f3-virtual-texture-evidence-20261002.md)+ T04 分页阴影经验(shadow_map_update/shadowDirty)。
**实施要点**:
1. 虚拟页表:三环 clipmap(近/中/远,围绕主视),虚拟 16384²、物理页池 2048²×4 atlas(RGBA8 depth-as-float 或 R32F,按可写格式定)。
2. 物化:每帧按屏幕像素投影误差排序 Top-K 页(预算 ≤2.5ms,超预算按误差截断);静态页版本号缓存,动态物体页掩码局部失效。
3. 采样:着色端页表查询(复用 virtualTextureSampling 的 tile-lookup 合同);页缺失回退上一环(渐变无洞);PCSS 软硬化随遮挡距离;近场由接触阴影 C10 补。
4. 替换逻辑:`displayContract.shadow` 加 `mode: "virtual" | "cascaded"`(缺字段=级联,向后兼容);`rendererCapabilityManifest.shadow-cascades` 条目更新双档说明。
**验收**:①同一 10 万对象场景,近景阴影边缘锯齿能量比级联 ↓≥60%(取边缘带像素梯度统计);②阴影全程 ≤2.5ms@1080p(GPU 计时,若无逐 pass 计时先接);③旋转/平移动态设备阴影延迟 ≤2 帧;④零洞:页缺失回退覆盖,像素无黑斑;⑤j3 shadow-visibility 门保持绿。
**规模**:2-3 周(人类口径)/专项 agent 数轮。

## Brief-GI:静态 SDF 遮蔽 + 动态探针混合 GI

**目标**:无烘焙动态 GI(类 Lumen 软件模式),昼夜循环无跳变、封闭房间无漏光。
**复用基座**:SDF 已有(`packages/deep-engine/src/physics/sdfCollision*.ts`、`sdfGpuQuery.ts`、`sdfCollisionQueryWgsl.ts`——A2 资产线,先核查场景级 SDF 数据来源与覆盖面,若 A2 只覆盖碰撞代理需先补场景烘焙 SDF 步骤);probeClipmap 探针 GI(16/32 方向)+ F5 镜面方向可见度门 + C11 SSR;大气天空 atmosphereSky。
**实施要点**:
1. 静态遮蔽层:场景几何 → 3D SDF 纹理(分块烘焙,静态资产增量化);天光可见性 = SDF 追踪(每探针方向 8-16 步圆锥);静态 1 bounce 预计算存探针 SH。
2. 动态直接层:半屏 SSGDI(复用 C11 的 depth/normal 缓存,射线 4-8 步)。
3. 探针层:probeClipmap 的 SH 由 ①天光可见性 ②SSGDI 输出馈入更新(时域滤波 α≈0.1);F5 门合成仲裁既有。
4. 漏光哨兵:F5-L5 三区口径扩展到昼夜场景。
**验收**:①昼夜循环逐帧像素差 p99 ≤3/255;②F5-L5 哨兵通过;③C12 白炉能量守恒通过;④GI 三层合计 ≤6ms@1080p;⑤parity ibl/ibl-hq 不回退。
**规模**:3-4 周。**前置核查**:A2 SDF 的场景覆盖面(第一件事)。

## Brief-PhysDbg:物理调试器

**目标**:录制/回放/跨端位姿比对的产品级调试器。
**复用基座**:FixedStepClock 60Hz 确定性、T17 黄金案例机制(fixtures+指纹)、rapierPhysicsDebugView/DebugOverlay、T28 回放面板经验、ScenePhysicsPanel:414。
**实施要点**:
1. `physicsDebugRecorder`:每 tick 记录(位姿四元数 f32/接触点对/穿透深度/关节约束脉冲,量化 + ring buffer,容量按 60s@60Hz 预算 ≈12MB);开始/停止/标记 API。
2. 时间线 UI:tick 刻度+播放头+逐帧步进(复用 T28/时间线面板样式);对象位姿曲线小图。
3. 跨端比对:web(WGSL/CPU 参考)/native(cargo)双端同 tick 位姿哈希,差 >1e-3 标红并跳转该 tick;复用 cloth_parallel_compute_parity 的指纹合同。
4. 可视化:接触点/穿透深度/约束力渲染(debugView 扩展,语义色:接触=青/穿透=红/约束=黄)。
**验收**:①60s@60Hz 录制零丢 tick(帧追赶上限内);②回放与录制位姿逐位一致(哈希等价);③web/native 差异用例:人为注入偏差能被定位到具体 tick;④录制开启时帧时增量 ≤0.3ms。
**规模**:2 周。

### Brief-PhysDbg 实施结果(2026-10-03,已交付)

**已有(不重建,T28 核查结论仍有效)**:app 层录制/回放/比对链(`physicsPoseRecorder/Compare`、`viewerEngineSimulation` 钩子、`PhysicsDebugPanel` 七功能区)原样复用;本次只补引擎侧确定性合同、native 镜像、时间线 UI 与通道语义合同。

**交付物**:
1. `packages/deep-engine/src/physics/debugRecorder.ts`:FixedStepClock 驱动的 tick 级录制器,全 TypedArray ring buffer(热路径零分配),f32 量化(位姿 7×f32/体、接触 9×f32 对、关节脉冲 4×f32),FNV-1a 双车道逐 tick 位姿哈希 + 链哈希,start/stop/mark(bounded 64),12MiB 预算反推 3679 tick ≈ 61.3s@60Hz;`comparePhysicsDebugRecordingTicks` 按 tick 对齐、哈希相等走逐位快路径、>1e-3 红线给首超差/首哈希失配 tick;`toDebugJson/parsePhysicsDebugRecordingJson` 跨端交换。经 `@bim-studio/deep-engine/physics` 公共子路径导出。
2. `apps/web/src/components/PhysicsDebugTimeline.tsx`(+CSS/测试):时间线节挂入 PhysicsDebugPanel(刻度轨+自适应刻度+点击寻址+播放头+超差红点+跳转首超差帧+位移/旋转包络小图+逐帧步进+语义图例+引擎哈希 JSON 导出);入口按钮「调试时间线」挂 ScenePhysicsPanel(AppStudioViewport 一条 state 接线)。
3. `packages/deep-engine-native/src/physics_debug_compare.rs`(新文件,未触碰 native_physics*/cloth*/runtime_navigation*):TS 合同逐位镜像(哈希/链/f32 场景/容差比对)+ 4 项 cargo 测试,共享 fixture `tests/fixtures/physics-debug-compare-v1.json` 由 `scripts/physicsDebugFixtureGen.mts` 经产品实现生成。
4. 语义色合同 `PHYSICS_DEBUG_SEMANTIC_COLORS`(接触=青/穿透=红/约束力=黄,UI 面映射 --info/--danger/--warning 令牌)。**3D 覆盖层挂载点在 apps/web/src/viewer(本任务禁改领地),数据合同先行钉死,挂载留待后续**;时间线内以红点/图例交付 2D 语义渲染。

**验收证据**(`test-output/physdbg/acceptance-evidence.json` + 两轮截图):①3600 tick@60Hz 抖动帧驱动零丢 tick(lost=0,dropped=0);②回放重录链哈希逐位一致 + JSON 往返零超差;③tick 37 注入 2e-3 被精确定位(web 实测 + Rust 镜像 4/4,亚容差 2e-4 只报哈希失配不误报红线);④record() p95=0.0064ms(预算 0.3ms,47× 余量);⑤⑥测试门:engine physics 域 vitest 全绿、web tsc 零错、Timeline 8/8+Panel 16/16+ScenePhysicsPanel 9/9+架构门 6/6;⑦UI 两轮浏览器闭环(1920×1080 深色,录制 95 步→回放 47/95,播放头/曲线光标/步进联动)。

**边界披露(诚实条款)**:整包 deep-engine tsc/build 与全量 vitest 存在并行在途领地错误(MSAA:pbrRendererFrames;VSM:virtualShadowResources;另有未跟踪在途件 meshletDag 自带测试缺陷)——本任务文件零错误,dist/physics 子路径已正确产出,整包构建验证待并行收口后补跑;期间 VSM 一次在途语法错曾短暂阻塞 UI 采集,其自行收口后完成。

## 派发纪律
- 同一时间 ≤2 路专项 agent;GPU 验证错峰;文件 owner 互斥(VSM=renderTargets/webgpu 帧管线+contracts.shadow;GI=physics/sdf+probeClipmap+shader;PhysDbg=physics+UI 面板——GI 与 PhysDbg 在 physics/ 有交集,勿同时派)。
- 每专项收尾:验收数据落 `test-output/<专项>/`,规格文档补"实施结果"节,重建 dist,进 `verify:gpu-release`。
