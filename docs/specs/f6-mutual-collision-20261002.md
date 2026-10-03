# F6 跨软体互碰 CPU 核(2026-10-02,主线程切片;崩溃恢复后收口)

## 现状核查

1. `f6-cloth-self-collision-20261002.md` 已收口单布自碰撞;`f6-continuation-audit-20261001.md` 明确"动态双向互碰必须分开登记"为 F6 真实缺口;session host 此前按 solver 整步推进(id 字典序),无子步级编排。
2. 两个 solver 的子步循环体同构(积分→contacts→约束→contacts→速度回算),拆分可保持逐位等价。

## 实现

- `clothSelfCollision.ts` 抽公共分离核 `createParticleSeparation({sets, diameter, crossOnly})`(多集合空间哈希+粒子对最小距离投影,确定性:集合序→index 升序→桶内 scatter 稳定);`createClothSelfCollision` 改为单集合薄包装(缓冲引用逐次换入,零拷贝),7/7 场景门+确定性测试守护等价(重合分支以预计算 diameter 除法与首版 1-ULP 内等价,无旧指纹合同)。
- `ClothSolver`/`SoftBodySolver` 拆出 `stepSubstep(substep)`(tick 计数与 finite 审计留 `step()`);风场时间基 `tick·dt + substep·h` 与连续 step() 逐位一致(clothSolver 17/17 含 240 tick 确定性/回放用例守护);新增 `particleBuffers()` 只读视图。
- `softBodyRuntimeHost.ts` 新增 `mutualCollisionRadius` 选项,构造期 fail-closed:半径正有限、全部 body 为 cloth kind(四面体软体首片拒绝)、substeps 全组一致、各布 2r ≤ spacing。`step()` 互碰路径=子步级交错(每子步各 solver `stepSubstep(sub)` → 跨集合分离投影),非互碰路径逐位走旧 `step()`。
- 分离核 `crossOnly: true`:互碰只处理跨集合粒子对,同布内部自碰撞由各 solver 独立的 `selfCollisionRadius` 负责(两个半径互不强制)。

## 验收(实测)

- 新测试 `softBodyMutualCollision.test.ts` **4/4**:构造合同负例(radius 非法/四面体/substeps 不一致/2r>spacing);双布叠置 200 tick 窗口(tick≥140):禁用负控真实穿透(跨集 min<2r)、启用跨集 min≥0.9·2r、开关终态指纹不同;确定性双跑逐位+第 100 步快照回放续跑逐位。
- 物理域全量 **24 文件 155 passed + 3 既有 skip** 零回归;`pnpm typecheck`(src/lab/examples)exit 0。

## 如实边界

- 投影式位置分离:互碰位移不进入速度回算(非弹性接触语义,无反弹冲量;与静态接触投影同族边界);交错积分/冲量交换后继。
- 首片仅 cloth↔cloth;soft-body(四面体)参与互碰、互碰与 GPU 并行核、运行包 SDK 通道(运行包 schema 未扩)均后继,不关闭 F6/T18-collision 整行。
- 0.9·2r 窗口门是本场景实测声明,非任意参数域证明。

## 环境事件(如实)

- 会话崩溃一次;崩溃前 ENOSPC 把 clothSelfCollision.ts 写空,按授权清理后完整重写(内容=重构最终态),7/7+155 回归重跑全绿确认无损。磁盘累计清理:9 月历史测试输出(≈14G)、wasm/Android/Tauri 历史 target(≈23G)、cargo incremental(0.6G)、SDK 安装 zip(1.7G)、J3-D 过程 diagnostic run(≈1.7G),现 130G 可用。
