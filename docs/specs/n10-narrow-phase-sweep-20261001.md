# N10-geometry:机器人连杆/工具/工件窄相位与时间扫掠

> 日期:2026-10-01 | 对应估时表:`docs/specs/remaining-tasks-estimates-20260930.md` N10-geometry
> (互锁粗筛之后的机器人连杆/工具/工件窄相位与时间扫掠,出碰撞时刻和最小间距;12–24h,中信心)
> 定位:纯 CPU 几何/仿真引擎能力切片;不做 UI、不接控制器、不改物理求解器。

## 1. 六步现状核查(2026-10-01 执行)

1. **全仓 grep**(packages/*/src、apps/web/src,含 `git status --short` 未跟踪):
   `narrowPhase|gjk|convexDistance|sweepCollision` 零命中(rapier 自带 d.ts 与 node_modules 除外);
   `robot/fk/ik` 命中 `apps/web/src/viewer/ikSkeleton.ts`(T15 纯数学 FK/多链限位 IK)、
   `ikPoseSearch.ts`、`robotPoseRuntime.ts`(场景层)、
   `packages/workcell-validation-plugin/src/kinematics.ts`(平面链点位 FK/IK,无体几何);
   `collision` 命中 `apps/web/src/viewer/analysis.ts`(MeshBVH 网格级 `closestPointToGeometry`)、
   `spatialValidation.ts`(静态规则校验+包围球宽相)、T17 物理
   (`apps/web/src/delivery/compileScenePhysicsRuntime.ts`、`native_physics.rs` cast_ray)。
   **互锁**命中 `packages/contracts/src/robotSync.ts`(信号级调度合同)与
   `packages/workcell-validation-plugin/src/robotSync.ts`、
   `packages/virtual-commissioning-plugin/src/goldenInterlock.test.ts`。
   **无任何窄相位/凸体距离/时间扫掠实现。**
2. **契约层**:`packages/contracts/src/robotAsset.ts` 的 `RobotLinkDefinition.collisions:
   RobotVisualDefinition[]`,geometry 为 `mesh|box|sphere|cylinder`——凸体来源齐全,零合同改动可用;
   `robotSync.ts` 明示"调度层不掌握 TCP 几何";`scene.ts` 物理合同归 T17/并行任务,**本切片禁改**。
3. **依赖**:three 0.185.1、three-mesh-bvh(analysis.ts 在用)、`@dimforge/rapier3d-compat` 0.19.3
   (apps/web vitest 已有使用先例,如 `rapierPhysicsCcdGolden.test.ts`)。零新依赖。
4. **消费方**:`RobotSyncPanel.tsx`(106 行)自述"活动窗口互斥只提示潜在过近,
   **不计算 TCP 距离、连杆扫掠**或控制器认证"——N10 正是该声明的缺口;
   `skeletonFK`/`buildSkeletonFromRobotDefinition` 已被 `ikPoseSearch` 消费(测试覆盖 52 项量级);
   `analysis.ts` 的 `closestPointsBetweenObjects` 被 `spatialValidation` 消费(静态,不沿时间);
   T17 `NativePhysicsHost::cast_ray` 为 Rust 侧只读查询(collider 跟随刚体)。
5. **测试与证据**:`docs/reports/deep-core/T15-implementation.md`(IK 收敛残差 9.06e-8 m、逐位确定性)、
   `T17-implementation.md`(CAD→collider、确定性 quickhull、cast_ray golden、机构四组黄金)、
   `ikSkeleton.test.ts` 等。互锁侧:`robotSync.test.ts`、`goldenInterlock.test.ts`。**窄相位与扫掠测试空白。**
6. **规格**:估时表 N10 条目与 T19–T24 复查条目;`docs/active-task-recovery-ledger.md`
   (2026-09-30 停止交接状态,本会话文件所有权:新建文件均为 N10 专属);
   能力扩展总入口 `docs/handoffs/engine-capability-expansion-plan-2026-09-22.md`。

### 核查结论

**已有(不重建,零改动复用)**:
- FK:`buildSkeletonFromRobotDefinition` + `skeletonFK`(T15,逐位确定,关节限位/mimic 解析);
- URDF 合同:`RobotAssetDefinition`(collisions 几何 box/sphere/cylinder/mesh);
- BVH/网格距离:`apps/web/src/viewer/analysis.ts`(静态场景校验层,保留原样不碰);
- 物理查询基准:Rapier(Web vitest)与 Native `cast_ray`(T17),仅作交叉验证参照;
- 互锁粗筛:`runRobotSyncScenario`(信号级调度 + TCP 互斥窗口),本切片在其"之后"运行,不做调度。

**真实缺口(本切片补齐)**:
1. 两凸体最近点对窄相位距离查询(无);
2. 沿 FK 轨迹的时间扫掠(采样→粗筛→窄相位→碰撞时刻二分细化)(无);
3. 结构化输出(碰撞时刻、接触点、最小间距、涉及连杆对)(无)。

**边界(不碰)**:`scene.ts`/`simulationEngine.ts` 合同、`components/**`、T17 物理 runtime、
WASM/GPU、`apps/api`(quickhull 属生成管线,本切片运行期不需要它,见 §3 选型)。

## 2. 交付范围

| 文件 | 内容 |
|---|---|
| `apps/web/src/viewer/convexDistance.ts` | 纯标量 GJK 距离子例程:两凸体(box/sphere/cylinder 顶点化、解析球、网格顶点集)最近点对与距离;穿透返回布尔;逐位确定性 |
| `apps/web/src/viewer/robotSweepCollision.ts` | 时间扫掠引擎:骨架 + 关节轨迹采样 → 每步 FK(复用 T15)→ 对级球粗筛(下界剪枝)→ GJK 窄相位 → 状态翻转二分细化碰撞时刻 → 结构化报告 |
| `apps/web/src/viewer/convexDistance.test.ts` | 解析对拍(球/盒/四面体)、交叉验证(Rapier castRay)、确定性、退化输入拒绝 |
| `apps/web/src/viewer/robotSweepCollision.test.ts` | 已知碰撞时刻轨迹、无碰撞最小间距、擦边不漏检、工具/多连杆对、粗筛统计、双跑逐位、10k×10 性能 |
| `docs/specs/n10-narrow-phase-sweep-20261001.md` | 本规格 |

## 3. 窄相位算法选型

**选择:GJK(Gilbert–Johnson–Keerthi)距离子例程,直接作用于凸顶点集/解析球支撑映射。**

| 候选 | 结论 | 理由 |
|---|---|---|
| **GJK 距离(选定)** | 采用 | 支撑函数直接吃顶点集,查询期**无需构建凸包**;距离与最近点对是原生输出(SAT 需要额外构造);迭代次数与顶点数无关(只与形状分离度相关),mesh 顶点数百级也稳定;固定迭代序 + 无随机源,确定性可逐位对拍;URDF 的 box(8 顶点)与 sphere(解析支撑)天然精确,cylinder 顶点化误差显式声明 |
| 凸包对 + SAT | 不选 | SAT 只回答相交与否,最小间距还需另一套算法;凸包对需要先建 hull——T17 quickhull 在 `apps/api`(app 层、不导出、面向离线 collider 生成),运行期每步变换后 hull 不复用,反而增加构建成本 |
| EPA(穿透深度) | 不做 | 扫掠交付是碰撞时刻与最小间距;穿透区间只需布尔与端点,EPA 接触集不唯一且复杂度高,列为后续增强 |

**T17 quickhull 复用说明**:选 GJK 后运行期不需要凸包——支撑映射就是"隐式凸包"。
T17 quickhull 继续服务离线 collider 资产生成(其确定性约定:外向 CCW、退化三级守卫);
若后续把本窄相位接入 T17 collider 运行包,可直接消费其 `convex-hull` 产物顶点(已是去重凸点集,GJK 支撑查询更省)。

**最小间距定义(本切片口径)**:两凸体最近点对欧氏距离
`d(A,B) = min{ ‖pa − pb‖ : pa ∈ A, pb ∈ B }`,输出世界系 `pointA`/`pointB`(最近点对)。
`d > 0` 分离;`d = 0`(含穿透)记碰撞,穿透时接触集不唯一,**不输出接触点**(诚实边界,EPA 后补)。
扫掠最小间距 = 全部采样时刻 `d` 的最小值(碰撞样本按 0 参与)。

### GJK 实现要点

- 初始方向:两体包围球心差(零向量时取固定 +X);
- 单纯形 ≤4 点,最近点解用封闭式(segment/triangle/tetra,Ericson 例程),返回 barycentric 权重;
  `pointA = Σλᵢ aᵢ`、`pointB = Σλᵢ bᵢ`(单纯形缓存两侧支撑点);
- 收敛判据:`|v| − max(0, −v·w)/|v| ≤ relTol·|v| + absTol`(上下界夹紧,relTol=1e-6,absTol=1e-9,迭代上限 64);
- touch/penetration:`|v| ≤ absTol` 或单纯形含原点 → 碰撞;支撑点重复(退化)即收敛返回,防死循环;
- 球体用解析支撑(精确,供解析对拍);顶点集支撑为线性扫描 O(N)。

## 4. 时间扫掠离散化

```
输入:骨架(IKSkeleton,T15)+ 关节轨迹 poseAt(t)+ 体集合(连杆/工具随节点,工件静态)+ 对列表
对 t_i = t0 + i·Δt, i = 0..N(含两端点):
  1. skeletonFK → 各节点世界位姿(复用 T15,mimic/限位解析口径一致)
  2. 每体世界化:link/tool = 节点位姿 × localOffset;工件 = 固定变换
  3. 对级粗筛(保守,三角不等式):
     a. 球不相交 → 该步该对必分离,记样本(不调 GJK);
     b. 球面下界 centerDist − rA − rB ≥ 当前已记录最小间距 → 跳过 GJK(不可能刷新最小);
  4. 窄相位 GJK → (separated, distance, pointA, pointB)
  5. 状态机:相邻样本分离→碰撞翻转处,对 [t_free, t_collide] 二分细化
     (判据 = 该时刻是否碰撞;时间容差默认 1e-6 s,迭代上限 40),首个翻转给出 firstCollision
输出(每对):
  minDistance / minDistanceAtSeconds / minDistancePointA / minDistancePointB
  firstCollision?: { timeSeconds, pointA, pointB }   // 碰撞样本无接触点(穿透接触集不唯一)
  collisionIntervals: [{ enterSeconds, exitSeconds }] // 端点经二分细化
  meta: { gjkQueries, sphereCulledSamples }           // 粗筛效率审计
```

**离散化极限(诚实声明)**:碰撞检测粒度为采样步长;一步内"穿入又穿出"(隧穿)不可见。
本切片不做连续碰撞检测(CCD 扫掠体),由调用方按体最大速度选取步长
(经验:`Δt ≤ 0.1·(最小体尺寸) / v_max`);二分细化只细化采样间**状态翻转点**,
不能挽回被整步跳过的碰撞。

## 5. 验收与测试计划

| 用例 | 解析期望 |
|---|---|
| 球-球已知距离(r=0.5,心距 2) | d=1±1e-9;pointA/B 在连心线,距各自球心 0.5 |
| 球-球接触/穿透 | 接触 d≈0 分离;穿透 separated=false |
| 盒-盒(半边 1,一个绕 z 45°,沿 x 心距 D) | d = D − 1 − √2(±1e-9);最近点 (1,0,0) 与 (D−√2,0,0) |
| 对称性与交换律 | d(A,B)=d(B,A) 逐位一致;同输入双跑逐位相等 |
| Rapier 交叉验证(T17 同族查询) | ball/convexHull castRay 的 toi 与 GJK 距离一致(同一连心线)±1e-6 |
| 扫掠已知碰撞时刻 | 单关节臂(r=0.2 末梢球,θ: 0→π/2 / 1 s),静态球在 π/6 半径 1:t* = 2·asin(0.2)/(π/2) ≈ 0.256416 s,二分细化后 ±1e-5 |
| 扫掠无碰撞最小间距 | 静态球在 −π/6:min d = 2·sin(π/12) − 0.4 ≈ 0.117695(±1e-5) |
| 擦边不漏检 | 静态球使切触恰在样本上(d≡0):必须报 firstCollision,且 t 与解析一致 |
| 粗筛有效性 | 远距工件:sphereCulledSamples > 0 且结果与全量 GJK 一致 |
| 确定性 | 同场景双跑 JSON 逐位相等 |
| 性能 | 10k 步 × 10 连杆对(全部进窄相位的最坏配置)CPU 计时,给实测数与粗筛剔除对照 |

## 6. 明确不做(诚实边界)

- EPA 穿透深度与穿透接触点;CCD 扫掠体(步内隧穿声明见 §4);
- 凹体(凹体先经 T17 凸包管线近似,`concaveSource` 语义沿用);
- UI 接线(RobotSyncPanel 归 components/** 禁碰清单)与场景合同改动;
- Rust 侧实现(本切片纯 TS;Native cast_ray 已由 T17 golden 把关,交叉验证用 Web Rapier 同族查询);
- 多机器人自碰撞对(对列表由调用方给出,机制同构,不单列)。

## 7. 实测结果(2026-10-01,全部实跑)

**测试**:`convexDistance.test.ts`(12 项)+ `robotSweepCollision.test.ts`(9 项)= **21/21 通过**;
同族回归 `ikSkeleton/ikPoseSearch/ikRetarget/spatialValidation/analysis` **55/55 通过**;
`apps/web` `tsc --noEmit` 全包 **0 错误**;`git diff --check` 干净;已跟踪文件零改动(5 个新文件全部未跟踪)。

**解析对拍数值**(节选):
- 球-球(r=0.5,心距 2):d = 1(±1e-9),最近点 (0.5,0,0)/(1.5,0,0);
- 盒-盒(半边 1,绕 z 45°,心距 4):d = 4−1−√2 ≈ 1.585786,最近点 (1,0,0)/(4−√2,0,0);
- 球-盒 3.75 m 场景(曾因共面四面体缺陷报碰撞):修复后 d = 3.7500000021(相对误差 5.6e-10);
- 扫掠碰撞时刻:θ: 0→π/2 / 1 s,静态球 π/6 → 入口 0.0769±1e-5 s、出口 0.5897±1e-5 s(解析解吻合);
- 无碰撞最小间距:2·sin(π/12) − 0.4 ≈ 0.117638(±1e-6);1e-4 m 净空:不误报且 min 匹配;
- 擦边(d≡0 于 t=0):检出 firstCollision @ 0,不漏检;
- Rapier castRay 交叉验证:球 toi=1.5 与凸包盒 toi=2 均与 GJK 距离一致(<1e-6)。

**性能(win32 / Node v24.18.1,CPU 计时,证据 `test-output/n10-sweep/perf.json`)**:

| 场景 | 窄相位查询数 | 耗时 | 单次 |
|---|---:|---:|---:|
| 最坏:10k 步 × 10 连杆对,包围球恒重叠(粗筛不触发),分离态 GJK | 100,000 | **276.0 ms** | **2.76 µs** |
| 对照:同规模,球-球下界精确,距离单调增(首样本后全剪枝) | 10 | **29.6 ms** | —(9.3× 加速) |

**过程中修复的确定缺陷(同族排查)**:
1. GJK 对 B 体的支撑方向未取反(Minkowski 差方向错)→ 距离整体偏大;同族排查:全部支撑调用仅两处,同批修复;
2. 收敛判据投影符号错(`u·w` 应为 `v·w/|v|`)→ 迭代不收敛退化到重复点守卫;
3. **共面四面体误判包含(生产级)**:零体积单纯形中 `sideOpposite` 为浮点噪声,逐面同侧判定被噪声伪装 → 相距 3.75 m 的球-盒报成碰撞。修复:面法向长度作尺度、低于相对阈值(1e-12·‖n‖·extent)的面"不可判",全部不可判按非包含处理;三角形最近点解补退化守卫(共线回退三边取最近)。同族排查:单纯形求解全部路径(segment/triangle/tetra)逐一核对,segment 已有零长守卫,家族其余干净;
4. URDF rpy 四元数半角公式笔误(cos 误乘 0.5)→ 恒等 rpy 得到 w=0.125;测试"rpy 恒等逐位一致"当场捕获。
