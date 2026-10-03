# F6/T18 布料/软体风场 GPU 碰撞（2026-10-02,子智能体;进行中——实时落盘）

行定义:docs/specs/remaining-tasks-estimates-20260930.md:136「布料/软体风场与碰撞、软体并行、
顶点流生产消费;CPU/GPU 参考不重建」。本刀只做 F6/T18 剩余三项中的**风场 GPU 碰撞**
(持续高频帧性能禁做=帧时窗口;Native 软体 cargo 禁做)。硬约束:禁 cargo、禁帧时测量、
不 commit/push、GPU Chrome 串行、jc-i-continuation-20261001.md 只读。

## 现状核查（六步,2026-10-02 完成）

1. **全仓 grep wind/aero**(packages/deep-engine/src/physics + scripts,含未跟踪):布料家族
   wind 命中 6 文件;软体家族(solver/wgsl/dispatch/mirror/runtime host)**wind 零命中**。
2. **契约层**:无 packages/contracts 物理类型依赖;physics 域类型在 physicsTypes.ts 与各
   solver 文件内。`ClothWind`(clothSolver.ts,f64 黄金)与 `ClothGpuWind`(clothGpuWgsl.ts,
   GPU 输入合同,含 tickSeconds)已存在;软体侧无任何风类型。
3. **依赖**:WebGPU/esbuild/vitest/playwright 已在用;零新依赖。
4. **消费方**:布料风消费链齐全——WGSL integrate(windValueNoise)、packClothParallelParams
   96B、dispatchClothParallelGpuStep per-substep params 副本、ClothParallelMirror 接风、
   softBodyRuntimeHost cloth body.wind→ClothSolver。软体风消费方为零。
5. **测试与证据**:
   - 布料风场 GPU 全链**已闭合**(账本追加十六/十七/十八+三十四):真机 per24
     GPU vs 镜像 2.085e-5/2.395e-5,f64 黄金 0.056≤0.1(登记容差),裸重放无风指纹与
     基线逐位,见 f6-cloth-parallel-wind-20261002.md;
   - 软体障碍 GPU 全链**已闭合**(双 fresh 七门全绿):球 1.1e-7/旋转盒 1.9e-7 公式级
     黄金、镜像合同、黄金对照列、接触可观测,见 f6-softbody-params-abi-recovery-20261002.md;
   - 物理域基线(本刀开工实测):**35 文件 199 passed + 3 skipped,0 failed**。
6. **规格与账本**(jc-i-continuation 只读):追加十三(软体并行真机闭合,剩余明列「风场
   GPU 碰撞」)、追加三十四(params ABI 48/96 断裂破案+风场真绿+布料障碍探针
   obstacleGoldenMaxPosErr=0.6177 超门登记:根因=探针黄金 sphere vs GPU cuboid 算子错配,
   工作树现已两侧同 sphere r=0.45,该场景**真机复验仍未做**)。

### 已有（不重建）

- **布料并行核风场 GPU 全链**(WGSL 96B ABI/integrate 接风/value noise f32 逐位移植/
  per-substep 副本/镜像/真机):零改动,只读复用其 `mirrorWindNoise`。
- **软体并行核障碍全链**(projectObstaclesSoftBody/pack 64×80B/镜像/A-D 四列真机):零改动。
- **布料 f64 黄金风**(`ClothSolver.windAcceleration`+`WIND_NOISE_SALT`):组合场景黄金侧直接用。
- 软体 f64 黄金 `SoftBodySolver` **无风场语义**(grep 零命中)——本刀不扩 f64 黄金合同
  (风属于并行核+镜像口径,与障碍刀「并行核语义真值=色批序镜像」同构)。

### 真实缺口（本刀）

1. **软体并行核风场不存在**:SoftBodyGpuStepInput 无 wind 字段;packSoftBodyGpuParams
   48B 无风槽;softBodyParallelSolverWgsl integrateOne 只加 gravity;
   mirrorSoftBodyParallelStep 无风。四层(GPU 并行核/共享 pack/镜像/输入合同)全缺。
2. **风×障碍组合对拍全库空白**:布料探针风场景无障碍、障碍场景无风;软体障碍探针无风;
   无任何「风+障碍同场景 GPU vs 参考同 tick checkpoint」证据。
3. 布料障碍探针场景(0.6177 超门登记项)修复后未真机复验。

## 实现方案（最小补齐）

- **A 软体并行核风场**:`SoftBodyGpuWind`(与 ClothGpuWind 同形,seed 混 WIND_NOISE_SALT
  与布料/f64 黄金同源);共享 pack 48B→96B 头 48B 逐位不动(槽序:
  windEnabled u32@48、windSeed u32@52、baseSpeed@56、gustFreq@60、spatialScale@64、
  tickSeconds@68、pad@72..80、windDirection vec4f@80..96);并行 WGSL Params 同步 96B+
  windHash/windValueNoise(与 clothSolver.wgsl 逐字同文)+integrateOne 接风(标量展开,
  windEnabled=0 逐位退化);镜像接风(f32 噪声**导入布料单一真源**,禁复制——账本追加
  二十四去重教训);dispatch per-substep params 副本(风开 substeps 个,windTickSeconds=
  tick 基+sub·h;风关单副本逐位退化)。串行核/串行镜像不接风(障碍先例:字段忽略,
  文档声明非静默分歧);串行核 SoftBodyParams 保持 48B 结构(96B buffer 绑定 ≥min 合法)。
- **B 软体风×障碍组合**:镜像组合测试(CPU)+真机探针
  scripts/softBodyWindCollisionGpuProbe.ts+Test.mjs(Kuhn 软体+风+球:W1 风生效/
  W2 GPU vs 镜像 per24 同 tick checkpoint≤0.05/W3 双跑逐位/W4 接触可观测/
  W5 零风退化列;uncapturederror 常驻)。
- **C 布料风×障碍组合**:clothParallelGpuProbe production 增风+障碍场景(GPU wind+obstacles
  vs f64 黄金 ClothSolver wind+contacts sphere,64 tick,登记风容差 0.1),顺带完成
  0.6177 登记项修复后的同场景真机复验。runner verdict 增列。
- 合同钉:pack 头四字段 [particleCount,edgeCount,tetCount,substeps] 不动;
  WGSL 声明序 vs pack 异值字段逐槽核对(spot:粒子13/边7/tet3/子步2);
  接触序=积分后+约束后二次投影(既有编排不动);夹具 tet 构造期环绕规整+全约束修正
  (欠约束混沌教训);无假边/dummy 垫片。

## 进度日志（实时）

- [x] 现状核查六步完成(本文档"现状核查"节)。
- [x] A 软体并行核风场实现(2026-10-02):
  - `softBodyGpuWgsl.ts`:SoftBodyGpuWind 类型(与 ClothGpuWind 同形)、
    SoftBodyGpuStepInput.wind(串行核文档化忽略,同 obstacles 先例)、
    SOFT_BODY_GPU_PARAMS_BYTES 48→96、packSoftBodyGpuParams 风尾槽
    (windEnabled u32@48/windSeed^salt@52/baseSpeed@56/gustFreq@60/spatial@64/
    tickSeconds@68/pad@72..80/windDirection vec4f@80..96)、validateStepInput 风校验;
  - `softBodyParallelSolverWgsl.ts`:Params struct 96B 尾(与 pack 互钉)、
    windHash/windValueNoise(与 wgsl/clothSolver.wgsl 逐字同文)、integrateOne
    标量展开接风(windEnabled=0 恒等 gravity,零风路径逐位同构);
  - `softBodyParallelMirror.ts`:镜像接风(噪声单一真源=clothParallelSolver.
    mirrorWindNoise,导出化跨族共享;tick 基+sub·h 与 pack 同表达式;积分折算保持
    本文件非 fround 风格——与串行镜像逐位退化合同绑定,风关 (gx+0)·h≡gx·h 逐位);
  - `softBodyGpuDispatch.softbodyParallel.ts`:风开每子步 params uniform 副本
    (构建期一次创建),integrate bind group 逐子步换绑,project/finalize 共享首副本;
    风关单副本零扰动;缓冲创建序保持既有 trace 合同同位。
- [x] B CPU 测试全绿(2026-10-02):新叶 softBodyParallelWind.test.ts 7/7(零风逐位退化/
  风生效+风向投影/单步解析对拍(含 tick 基三点)/风×障碍组合全程接触 min gap 1.1e-9、
  无风对照终态 0.369 离面(接触维持者=风)/dispatch 风槽 17 递进逐位/风关 trace 逐位
  退化/非法风输入 fail-closed);softBodyParallelParamsAbi.test.ts 扩至 4/4
  (WGSL 布局走查 walker 按对齐规则算实际偏移,异值 13/7/3/2 + 风槽逐字段);
  既有 48 硬编码三处更新(softBodyGpuDispatch.softbodyParallel.test ×2、
  clothSoftBodyGpuWgsl.test、softBodyGpuDispatch.test 串行 96B buffer)。
  **物理域 36 文件 207 passed + 3 skipped(基线 199+8),tsc exit 0。**
- [x] C 真机探针双 fresh 全绿(见下节)。
- [x] 回报与诚实边界。

## 真机复验（双 fresh,NVIDIA Lovelace,exit=0 ×2）

探针:`packages/deep-engine/scripts/softBodyWindCollisionGpuProbe.ts` + `softBodyWindCollisionGpuTest.mjs`
(单 Chrome 会话跑软体+布料两家族;证据 `test-output/softbody-wind-gpu-20261002/` 与
`-r2/`,两独立 fresh 全 13 门 true,16 实际 esbuild 输入源 SHA 前后稳定)。

| 列 | 门 | 实测 | 结果 |
|---|---|---|---|
| 软体 W2 风+障碍 GPU vs 色批序镜像 per24 | ≤0.05 | 7.30e-6→**8.35e-4**(120t) | ✅ |
| 软体 W3 同 seed 双跑 | 逐位 | digest 6a065069 双跑一致(跨 fresh 亦一致) | ✅ |
| 软体 W1 风生效 | digest 不同+风向投影>0 | dot=**0.4886** | ✅ |
| 软体 W4 接触可观测 | min\|dist−r\|<0.05 | **1.148e-9** | ✅ |
| 软体 W5 零风+障碍退化列 per24 | ≤0.05 | 5.20e-6→6.83e-4 | ✅ |
| 软体 readback 演进(静默失效探测器) | digest 演进 | tick1≠tick2 | ✅ |
| 布料 A 有风无障碍(登记风容差) | ≤0.1 | **0.0538**(120t) | ✅ |
| 布料 B 夹具有效性(无风+公平球位) | ≤0.1 且不触球 | 0.0081,contact=false | ✅ |
| 布料 C 风+障碍组合·风致接触 | contact=true | true(0.02 窗口) | ✅ |
| 布料 C 预接触黄金差 | ≤0.1 | **0.0103** | ✅ |
| 布料 C 接触后黄金差(登记值) | 实测登记 | **0.0609** | ✅ |
| 布料 kernel | cloth-parallel 无回退 | 是 | ✅ |
| uncapturedGpuErrors | 空 | 空 | ✅ |

## 关键发现（本批实测纠正在册假设）

1. **布料障碍探针历史场景的夹具缺陷(0.6177/1.1-1.7 的真实根因族)**:历史球位
   (0.55,0.5,0.05) r=0.45 与旗初始态(z=0 平面)**深穿透**——旗平面切过球体,首 tick
   即全深度推出,构建序(f64 黄金)vs 色批序(f32 GPU)投影序敏感被最大化:实测无风
   1.27/带风 1.11(t8 前即爆,与风无关)。账本追加三十四「算子错配修复后该门才有效力」
   的假设被实测**纠正**:算子修复必要但不充分,夹具本身不公平(初始穿透=序敏感最大化
   的最坏初条件,同 CPU 夹具公平纪律)。历史场景随本批废弃(测量数据与归因链留档本文)。
2. **公平夹具(离面球位 (0.55,0.15,0.5),初始零穿透)下组合场景黄金差仅 0.0609≤0.1**:
   接触后滑动混沌放大的幅度受初条件支配;预接触段 0.0103 与无障碍风列 0.0538 同带。
3. 接触判据窗口教训:离面间隙 0.05 与窗口 0.05 同宽会产生 B 列假阳,真面接触窗口
   收紧至 0.02(判据随夹具几何声明,非门值放宽)。

## 诚实边界（不放过）

1. **f64 黄金层无软体风场**:SoftBodySolver 无风语义,软体风真值链=并行核 WGSL ↔
   f32 色批序镜像(与障碍刀同构);风噪声函数逐位合同由布料侧锁(0/200000),
   软体侧只锁接线(盐/y/tick/槽序),不重复锁噪声本体。
2. **串行软体核不消费风**(字段文档化忽略,同 obstacles 先例);串行核 params 结构
   仍 48B,96B buffer 绑定 ≥min 合法,真机串行+风输入行为=无风,已声明。
3. 软体组合场景接触后 GPU vs 镜像 8.3e-4 为 f32/FMA 容差域(A3/障碍刀同族口径),
   非逐位;镜像自身零风路径与旧实现逐位、风开路径双跑逐位。
4. 布料 C 列接触后 0.0609 为单球单旗场景登记值,多障碍重叠 4-sweep 收敛、旋转
   cuboid+风组合、持续高频帧性能(禁做)、Native 软体(cargo 禁)均不在此刀。
5. **未 commit/push**;GPU Chrome 单实例串行(本刀两次 fresh 自占窗口,未与他线冲突);
   sourceSizeGate 全仓 11 failures 均为其他批次既有文件(softBodyObstacleGpuProbe 531/
   clothParallel 394 等),本批新增/修改文件全部 ≤300 行合规。
6. 物理域 36 文件 **207 passed + 3 skipped(基线 199+8)**;tsc exit 0;无 cargo、无帧时测量。

