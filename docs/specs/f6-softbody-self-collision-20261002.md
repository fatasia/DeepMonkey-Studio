# F6 软体(四面体)表面自碰撞 CPU 核(2026-10-02,主线程)

## 现状核查

前两刀(cloth 自碰撞 7/7、跨软体互碰 4/4)已收口;四面体软体自碰撞此前无任何实现(全仓零命中)。语义与布料不同:体积约束保内部结构,自碰撞只应作用于**表面粒子**。

## 实现

- 新叶 `softBodySelfCollision.ts`(125 行):
  `extractSoftBodySurfaceTopology(tets,count)`——表面=恰被一个四面体拥有的三角面(face key 计数),表面粒子集+CSR 1 跳邻接(同 tet 全粒子对;非表面粒子不写条目);构建期一次完成,零每帧开销。
  `createSoftBodySelfCollision({topology,count,radius,minEdgeLength})`——复用 `createParticleSeparation`(新增可选 `skipPair` 集合谓词):含任一内部粒子的对跳过(内部归体积约束),表面 1 跳邻接对跳过(归边约束),其余表面对最小距离投影。
- 参数合同:`radius>0` 且 `2r ≤ 最短四面体边长`(保证被排除的 1 跳对距离 ≥2r 不自相矛盾)。
- `SoftBodySolverConfig.selfCollisionRadius?`:构造期建拓扑+核;`stepSubstep` 两处 contacts 后调用(与 cloth 同位)。

## 验收(实测)

- 新测试 **4/4**:表面提取(4-tet simplex 顶点 4=内部点,surface={0,1,2,3},顶点 0 邻接={1,2,3,4},非表面无 CSR 条目);合同负例(radius 非法/2r>minEdge);skipPair 三态(全表面重合因两两邻接保持重合=排除生效,锚点不动);**双副本重合 simplex 场景**(两份 4-tet 顶点坐标完全重合、互不共享 tet):禁用 10 tick 保持重合(min=0,证明力来源),启用后跨副本表面对分离 ≥0.9·2r。
- 物理域全量 **25 文件 159 passed + 3 既有 skip** 零回归;src tsc exit 0。

## 如实边界

- 投影式单遍近似(与布料自碰撞同族):不承诺完全无穿透;与 contacts 顺序固定 contacts→self。
- 双副本场景是构造性证明(重合副本+非邻接),非真实褶皱工况;真实大网格压扁自接触的规模行为后继与 GPU 并行核一并评估。
- 测试初稿断言错把非表面顶点(4)当 CSR 条目读取——源码设计(非表面无条目)正确,断言已修正;调试中曾误疑 vitest 缓存(ENOSPC 写空事件的后遗症警惕),实际为断言错误。
