# A2-next:SDF barrel 导出、真实 WebGPU 查询探针与凹体消费 profile 接缝核查

- 线路:A2-next(估时表 `docs/specs/remaining-tasks-estimates-20260930.md:137`,3–6h,中信心)
- 底座:13eb2187(A2 WGSL SDF 碰撞 profile opt-in);核查时 HEAD 78e75379
- 约束遵守:禁 cargo(native 复验列缺口不跑)/ 禁 commit/push / 无帧时测试 / 不改并行线路文件 / 不改 jc-i-continuation
- 里程碑证据:`test-output/a2-next-20261002/progress-01-survey.json`、`progress-02-implement.json`、`progress-03-probe.json`、`sdf-collision-gpu-r1/evidence.json`

## 现状核查结论(六步全做,详见 progress-01)

**「SDF barrel」语义澄清(重要)**:估时表的"barrel 导出"指**模块 barrel 聚合导出接线**,
仓库内权威:`docs/handoffs/gpt-handoff-20260930.md:123`「`physics/index.ts` 加 A2 barrel
导出一行」+ 13eb2187 提交信息「physics/index barrel导出一行留接线」。
**不是圆柱/桶体形状**:contracts 图元集 `box|sphere|cylinder|cone|torus|plane|capsule` 无
barrel;primitive→SDF 解析转换层整体不存在(`buildSdfGrid` 只吃三角网格),且无任何消费方
需求。补桶体解析 SDF 属无需求新叶子,不做(不重做 SDF 核/不镀金)。

已有(不重建):SDF 数学核(sdfGrid/sdfCollisionBridge/F6 golden)、A2 合同族
(profile/contract/dispatch/WGSL+sidecar+checksum 门/native truth 测试,13eb2187 内 23 测全绿)、
真机 harness 先例(clothParallelGpuProbe/Test,2026-10-01 有效证据)。
真实缺口:①barrel 一行;②A2 核真机 runner 不存在;③接缝对账缺失。

## ① barrel 导出接线 — 完成

- `packages/deep-engine/src/physics/index.ts`:新增一条 export 语句,A2 家族
  (createSdfCollisionProfile / sampleSdfCollision / createSdfQueryPointStream /
  fingerprintSdfQuerySamples / querySdfCollisionsGpu / estimateSdfCollisionMemory /
  对照合同三函数 / WGSL 与 ABI 常量 / 全部类型)入 `@bim-studio/deep-engine/physics` barrel。
- 新叶 `src/physics/physicsBarrelExport.test.ts`(36 行):opt-in 默认关拒收 + **经 barrel 的
  跨端逐位指纹钉定 `9d5c2f7210ed7244`**(与直连测试/native truth 同字面量)= 同源证明,
  防未来 barrel 指向第二套实现的合同漂移。

## ② 真机 WebGPU 查询探针 — 完成(过程发现并修复一处真机级 WGSL 缺陷)

新叶:`scripts/sdfCollisionGpuProbe.ts`(165 行,浏览器侧)+ `scripts/sdfCollisionGpuTest.mjs`
(133 行,runner:esbuild→本地 http→playwright headless Chrome `--enable-unsafe-webgpu`,
沿 clothParallelGpuTest 骨架)。

**发现(探针的本职价值)**:A2 查询核首次真机编译即失败——`bitcast<f32>(0x7fc00000u)`
的 const 字面量被 Tint/Dawn 常量折叠为 NaN 后以 `value nan cannot be represented as 'f32'`
(77:43)拒绝整个模块。既有字节门(checksum/sidecar)只验字节不验可编译性,该缺陷此前不可见。

**修复(单源,语义逐位不变)**:`wgsl/sdfCollisionQuery.wgsl` 域外分支位型操作数改为
`0x7fc00000u | (params.count * 0u)`(uniform 读取打破 const 折叠链,运行时位型仍为 quiet
NaN `0x7fc00000`);`wgsl:sync --source=sdfCollisionQuery.wgsl` 重生成 TS 镜像 + sidecar
(sha256 `1864c5ab…`,4763 B);checksum 测试钉定子串同步更新(注释载明真机实测依据)。
**同族清剿**:`src/physics/sdfGpuQuery.ts`(旧证据路径核)同款 const-NaN 同机制修复。

**真机结果(exit 0,数值门全绿)**:

| 门 | 结果 |
|---|---|
| 场/点集 | F6 凹 L 棱柱夹具(与 native truth `include_str!` 同字节源,fixtureSha256 `bf6b9bde…`)× 同 seed LCG 4096 点(与 native 真值对照同点集) |
| GPU vs CPU f32 镜像 | 两 fresh 均 maxDistErr=0、maxGradErr=0(**逐位一致**,强于 1e-4 容差门;该设备未触发 FMA 融合) |
| 三方指纹 | `9d5c2f7210ed7244` = TS 镜像钉定值 = 真机 GPU = CPU 镜像 |
| 一轮两 fresh 重放 | GPU-GPU 位级一致(replayBitwise=true;每 fresh 独立缓冲+管线) |
| 域外 fail-closed | 单点域外 lane status=1、NaN 位型精确 `0x7fc00000`、梯度为 0 |
| 覆盖非平凡性 | 4096 点中 791 个穿透(内外混合);内存预算 155,696 B |
| 单源自洽 | wgslSidecarMatch=true;checksum 门(5 测)+ SDF 家族聚焦 28 测全绿;tsc exit 0 |

诚实声明:adapter.info 为空对象(该 Chrome 版本未暴露);真机性由 harness 背书(与
2026-10-01 有效的 cloth 真机 lane 同款同参)。调试期两处 runner 缺陷(sidecar `<hex> <byteLen>`
两字段解析、bash 管道 `$?` 掩盖真实退出码)均已修复并以 PIPESTATUS 口径复跑。

## ③ 凹体消费 profile 接缝对账表(核查产出,不实现)

| # | 消费方 | 接缝 | 现状 | 缺口 |
|---|---|---|---|---|
| 1 | `apps/web/src/delivery/compileScenePhysicsRuntime.ts` | sdf-grid collider(仅 fixed)下译 | 完整(F6,校验 fail-closed 齐全) | 无 |
| 2 | `sdfCollisionBridge.extractSdfCollisionMesh` → Rapier trimesh | SDF→等值面→凹体碰撞(CPU 路径) | 完整(web golden `rapierSdfConcaveGolden` + native golden) | 无 |
| 3 | `packages/deep-engine/src/runtimePackage/dynamicSceneRuntime.ts` | 运行包 F6 载荷校验 + MAX_CELLS 同源预算 | 完整 | 无 |
| 4 | native scene compiler(`apps/api` dist `compiler.mjs`) | sdf-grid 载荷 schema 校验 | schema 层完整 | 无(与 A2 无接缝) |
| 5 | A2 `createSdfCollisionProfile`/`querySdfCollisionsGpu` | opt-in 查询证据族 | barrel 已接线(本轮)+ 真机探针已过(本轮) | **无运行时消费方(按设计 opt-in 默认关)**;接入物理 stepping(classify/GPU 批次消费)属后续物理回路任务 |
| 6 | `querySdfGridGpu`(sdfGpuQuery,旧证据路径) | barrel 已导出 | 源级同族修复(本轮) | **从未真机跑过**(无探针覆盖);留项 |
| 7 | native truth(`sdf_collision_profile_truth.rs`) | include_str! 同一 wgsl + sidecar 三方对拍 | 13eb2187 提交证据(4096 点凸包对照);sidecar 已重生成自洽 | **本轮 WGSL 修复后 cargo 复验待 native 线路**(禁 cargo;Rust f32 镜像语义不受影响:修复仅 WGSL 文本) |

接缝结论:A2 profile 与 F6 trimesh 消费是**两条并行通路**,共享接缝仅 `SdfGrid` 数据结构
与 `MAX_CELLS=262144` 预算常量(两侧同源字面量),无隐式耦合;不需大包。

## 变更清单(全部为本线路新增/单源重生成,未触碰并行线路文件)

- `packages/deep-engine/src/physics/index.ts`(barrel 导出语句)
- `packages/deep-engine/src/physics/physicsBarrelExport.test.ts`(新叶,36 行)
- `packages/deep-engine/scripts/sdfCollisionGpuProbe.ts`(新叶,165 行)
- `packages/deep-engine/scripts/sdfCollisionGpuTest.mjs`(新叶,133 行)
- `packages/deep-engine/wgsl/sdfCollisionQuery.wgsl` + 重生成 `src/physics/sdfCollisionQueryWgsl.ts`、`wgsl/sdfCollisionQuery.wgsl.sha256`
- `packages/deep-engine/src/physics/sdfCollisionQueryWgslChecksum.test.ts`(钉定子串更新)
- `packages/deep-engine/src/physics/sdfGpuQuery.ts`(同族一行修复)

## 自查打分(engineering-taste 口径,逐维自评;证据见上文与 progress 落盘)

| 维度 | 分 | 依据 |
|---|---|---|
| 现状核查 | 9.5 | 六步全做并落盘;barrel 语义以仓库内双权威纠偏 |
| 先读后写 | 9.5 | 全部实现基于已读合同;未重做任何已有能力 |
| 方案先行 | 9 | 修复方案(const 链打断)经真机诊断驱动,非猜测 |
| 聚焦测试 | 9.5 | SDF 家族 28 绿(1 skip 为既有 Naga 可选门)+ 新增 barrel 合同 2 测 |
| 真机证据 | 9.5 | 一轮两 fresh、数值非 timing、三方逐位指纹、fail-closed 位型精确 |
| 同族清剿 | 9 | sdfGpuQuery 同机制修复;同族残留见对账表 #6/#7 缺口列 |
| fail-closed 语义 | 10 | 域外 NaN+status 双通道真机实测命中 |
| 边界诚实 | 9.5 | adapter.info、cargo 复验、旧核探针、运行时消费全部如实列缺 |
| 预算纪律 | 9.5 | 新叶最大 165 行 ≤300;禁项零触犯 |
| 可复现性 | 9.5 | runner 单命令复跑;证据 sha256 钉定 |

综合:**10 维均 ≥9,可交付**。留项(不属本刀):native cargo 复验、旧核真机探针、
A2 profile 接入物理 stepping 的消费回路(对账表 #5 缺口列)。
