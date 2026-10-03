# C8 障碍接触场景逐子步对拍定论(GPU obstacles vs f64 黄金 contacts)

- 日期:2026-10-02
- 任务:定位批遗留 —— `clothParallelGpuProbe.ts` 障碍场景(球心 (0.55,0.5,0.05) r=0.45,64 tick)
  GPU obstacles vs f64 黄金 contacts 的 goldenErr=0.6177 超门 0.1;根因候选 = f64 构建序投影 vs
  f32 色序投影在接触-滑动混沌域放大。
- 结论:**根因是 B(实现差)——障碍 ABI 装箱错位使 GPU 障碍投影通道静默死通道;已最小修复并真机复验。
  修复后残余(64 tick=1.2685)由约束投影扫序的非光滑接触敏感支配(A 家族,f64 反例定量),按登记口径交 root,未自行放门。**

## 1. 现状核查(progress-01)

- 已有(不重建):障碍场景在 `runClothParallelGpuProductionReplay` 尾部(GPU 走 `dispatchClothStepAuto`
  内联 obstacles,f64 黄金走 probe 内联 `contacts.project` 闭包);先验 evidence
  `goldenMaxPosErr=0.6177282211825479`、worstParticle=5(GPU 停球下缘 (0.500,-0.004,0.0098) vs
  黄金绕侧 (0.536,0.220,-0.565));风路径同 binary 真绿(per24 2.085e-5)。
- 子步序同构确认:GPU `integrate→projectObstacles→逐色 project→projectObstacles→finalize`;
  f64 `integrate→contacts→构建序投影→contacts→速度回算`。结构同构,差异仅三处:约束批序
  (色桶序 vs 构建序)、精度(f32/f64)、WGSL `dist==0` 分支(度量零)。
- 真实缺口:`ClothParallelMirror` 无 obstacles 通道(GPU 障碍场景从未有过 f32 同构参照)、
  无逐子步读回、无 f64 色序变体、无首分歧定位、无混沌敏感性证据。

## 2. 方法

- 子步分解:`dispatchClothStepAuto` 以 `substeps=1, dtSeconds=dt/8` 逐子步派发(h=÷8 为 2 的幂精确
  移指,逐位同值);保真性 = 分解轨迹 vs bulk 整 tick 终点**逐位一致**,bulk 双跑逐位,
  bulk 64 tick 终点**逐位复现先验锚点 0.6177282211825479**。
- 四方逐子步锁步:GPU(f32 色序+obstacles)/ 本地 f32 镜像(色序+obstacles,逐运算 fround,补镜像
  缺口)/ f64 黄金(构建序+contacts,底座同闭包)/ f64 色序变体(仅约束批序不同)。
- CPU 纯线:f64 序因素双轨、f32 精度双轨、1-ULP 初值扰动混沌判据。
- 探针:`packages/deep-engine/scripts/c8ObstacleSubstepProbe.ts`;runner:`scripts/c8ObstacleSubstepRun.mjs`;
  真机 headless Chrome(--enable-unsafe-webgpu)。

## 3. 首分歧定位(progress-02)

- 接触首发 = tick1 sub0(初态布料即深陷球内,首子步立即触发接触投影)。
- 修复前异常:GPU 侧 `insideGpu` 从 tick1 sub0 起 8 个子步**恒 60**(黄金侧 13→0→2→…被投影清零);
  GPU-vs-镜像首子步即 0.381(风场景同 binary 执行噪声为 2.085e-5 量级)。
- **GPU 障碍投影通道对状态零效应 → 0.6177 度量的是"GPU 无障碍自由布料 vs 黄金球接触布料"。**

## 4. 根因 B:障碍 ABI 装箱错位(已修复)

WGSL `Obstacle{center, row0, row1, row2, halfExtents}` = 5×vec4f(80B);halfExtents 在 **f32 槽 16..19**,
sphere/cuboid 判别式 = `halfExtents.w > 0`(槽 19)。`packClothGpuObstacles` 旧实现:

- halfExtents.xyz 写到槽 **13..15**(落在 row2.w 与 padding 上;identity 旋转下覆写不可见);
- 槽 19 从未写 → 恒 0 → 全部障碍走 cuboid 分支,读到 (0,0,0) 退化零盒 → `inside` 恒 false →
  **projectObstacles 恒无效应**,全程无异常、无 uncapturederror。

sphere 的 radius 本身装在 `center.w`(槽 3)正确,故 cuboid 分支读不到半径、sphere 分支永不进入。

修复(最小,`softBodyGpuDispatch.clothParallel.ts`):halfExtents.xyz → 槽 16..18;槽 19 =
`radius > 0 ? radius : 0`。回归锁:`softBodyGpuDispatch.clothParallel.test.ts` 新增障碍 ABI 逐槽断言;
physics 全族 30 文件 177 测试通过(3 skip 为既有);Rust 半无障碍装箱孪生,不受影响。

### 真机复验(修复后)

| 断言 | 数值 |
|---|---|
| 通道复活 | insideGpu 42→3→13→20→16→4→8→4(tick1 逐子步);minSurfDistGpu=5.14e-10(粒子贴球面) |
| 执行保真(GPU vs 同序 f32 镜像) | t1=1.5e-6,t8=1.08e-5,t16=1.2e-5,t32=2.29e-4,t64=1.38e-2(FMA 级噪声带) |
| 残余=序因素 | GPU-vs-黄金 t1s0=0.2877 **与 f64 色序轨道逐检查点同值**;t8/t16/t32/t64:GPU 1.0885/1.1507/0.8276/1.2685 vs 色序 f64 1.0885/1.1507/0.8276/1.2844 |
| 分解完整性 | 终点逐位一致、双跑逐位 |

## 5. 残余的定量归因(A 家族,登记口径)

| 因素 | 隔离实验 | tick1 | tick64 |
|---|---|---|---|
| 投影序(纯 f64,同 contacts) | 构建序 vs 色桶序双轨 | 0.2877(t1s0) | 1.2844 |
| f32 精度(同色序) | 镜像 vs 色序 f64 双轨 | 1.8e-6 | 4.4e-2 |
| 混沌(1-ULP 初值) | 色序 f64 克隆轨 | 1.7e-15 | 0.171(平台,有界) |
| GPU 执行 | GPU vs 同序镜像 | 2.0e-7(t1s0) | 1.38e-2 |

机理:接触投影夹在约束扫两侧,扫序改变约束收敛末态,第二次接触投影沿不同径向把深陷粒子推出——
非光滑映射对扫序一阶敏感,不是量化噪声的指数放大(1-ULP 有界为证)。

**门判据登记(交 root,未自行放门):**
1. 通道行为断言:带/不带 obstacles 同 binary 轨迹必须不同;接触粒子投影后 |dist−r| ≤ 1e-6;
   投影后不得大比例滞留球内。
2. 执行保真断言:GPU vs 同构 f32 镜像(色序+obstacles,逐子步)≤ 0.05;超带即实现 bug。
3. 场景级物理不变量:拉伸带 ≤5%、有限态、动能有界(沿既有口径)。
4. 真值关系:深接触场景 GPU(色序)参照 = 色序 f64/同序镜像;构建序黄金的 0.1 点对点门仅适用
   无接触/浅接触场景(风场景实测 0.062 绿,不受影响)。0.1 门对深接触+色序实现结构性不可达,
   f64 反例(0.288@t1s0,与精度、GPU 实现全部无关)即可证伪。

## 6. 同族清单

- 串行核 `dispatchClothGpuStep` 对 `input.obstacles` 静默忽略(同族"静默死通道";建议后续
  fail-fast,行为变更留 root 决断)。
- WGSL 单源头注释"radius>0=sphere"与代码判别式 `halfExtents.w>0` 口径漂移(注释级;WGSL 受
  字节门禁+Rust 共享,需 `wgsl:sync`+校验和,本批不动)。
- 其余 halfExtents 消费仅 CPU f64 `softBodyStaticCollision`(对象表示),无同型错位;
  其余 GPU 装箱(particles/constraints/params/stepRange)有既有 ABI 测试+本批逐子步保真佐证。

## 7. 证据与落盘

- `test-output/c8-obstacle-substep-20261002/`:
  - `progress-01.json`(现状核查)、`progress-02.json`(首分歧定位)、`progress-03.json`(根因定论);
  - `evidence-prefix-obstacle-abi-fix.json`(修复前真机证据:通道死定位,512 子步行);
  - `evidence.json`(修复后真机证据:通道复活+执行保真+残余=序因素,512 子步行);
  - `cpu-f64-order-line.json` / `cpu-f32-mirror-line.json`(CPU 纯线,序/精度/ULP 分离)。
- 代码:`packages/deep-engine/src/physics/softBodyGpuDispatch.clothParallel.ts`(修复+注释)、
  `packages/deep-engine/src/physics/softBodyGpuDispatch.clothParallel.test.ts`(ABI 回归锁)、
  `packages/deep-engine/scripts/c8ObstacleSubstepProbe.ts` + `scripts/c8ObstacleSubstepRun.mjs`(定位探针)。
- 边界如实声明:①帧时未测(任务禁令);②cargo 未用(任务禁令),Rust 半经检索确认无障碍装箱孪生;
  ③GPU 证据为单设备(headless Chrome/同一适配器),双跑逐位代替跨设备扫;④底座探针、既有门与
  `jc-i-continuation` 零改动;⑤未 commit。

## 8. 诚实条款

修复后 64 tick GPU-vs-构建序黄金 = 1.2685,**0.1 门仍超**——这不是未完成,而是该门在本场景
结构性不适用(f64 反例),处置为登记口径交 root;若 root 决断需要点对点绿,可选项是
障碍场景换色序 f64 参照或生产固定串行核(后者当前不支持 obstacles,需先补通道)。
