# 软体并行核真机发散定位与修复(2026-10-02)

任务:production wind 场景(clothParallelGpuProbe production auto 链,带风+锚定)GPU vs
色批序镜像 maxErr 在 tick24 即达 **1.55564269717622 且 48 tick 数值完全相同**(冻结)。
本文记录定位链、根因、修复、真机复验与如实边界。

证据目录:`test-output/softbody-divergence-20261002/`(progress-01/02/03 + probe-01/02 对照
实验脚本 + 基线 evidence + rerun-after-fix/ + rerun-final/)。

## 一、现象解构(定位链)

### 1. 冻结值的语义(真机逐粒子诊断)

主线程声称的 worstIndex/worstPinned 诊断实际不在工作树(grep 零命中),本任务补插:
device `uncapturederror` 监听、per24 `worstParticleIndex/worstPinned/worstInitial/worstGpuPos/
worstRefPos/worstGpuInvMass`、obstacles/session 同类诊断(`scripts/clothParallelGpuProbe.ts`)。

真机读数(progress-01):

- worst 粒子 = **143**(锚点 [11,11],初始位置 (1.1, 1.1, 0.0049088057));
- `worstGpuPos = [0, 0, 0]`、`worstGpuInvMass = 0` —— GPU 读回态不是"错在某个粒子",
  而是 **readbackBuffer 从未被有效 copy 填充,整体全零**;
- 1.55564269717622 = 镜像侧离原点最远粒子 143 的模长 `||(1.1, 1.1, 0.0049)||`。锚点在
  镜像全场景静止 → 24/48/240 tick、有风/无风/障碍四个场景**同值冻结**(f64 黄金侧
  1.5556426634585343 的 3.4e-8 差 = f64→f32 快照舍入);
- 裸重放(runReplay)另象限:gpuFingerprint 恒 `703b374387807d93`、kinetic=0 —— 该路径
  读的是构建期 `writeBuffer` 过的 stateBuffer,故呈现"冻结初始态"。该指纹与本地
  `buildClothParallelState` 初始态指纹逐位相同(本地 Node 复算验证,probe-01)。

### 2. 设备侧判词(非猜测)

`uncapturedGpuErrors`(插监听后首次可见):

```
Binding size (48) of [Buffer] is smaller than the minimum binding size (96).
 - While validating entries[..] against { binding: 2, ... BufferBindingType::Uniform, minBindingSize: 96 }
[Invalid BindGroup] ... SetBindGroup ...
[Invalid CommandBuffer] ... Queue.Submit([[Invalid CommandBuffer]])
```

Chrome 对 uniform minBindingSize 违约**不抛 JS 异常**:createBindGroup 返回 Invalid
BindGroup(验收探测全"accepted"即为误导),编码器失效在 finish/submit 才定型,**整个
命令缓冲静默丢弃**——stateBuffer 不更新、readback/kinetic 保持零填充、mapAsync 正常
resolve。这就是"既有门禁全绿却整体失效"能潜伏的原因。

## 二、根因

**params uniform ABI 断裂**:F6/T18 风+障碍扩展把 WGSL `ClothParams` 扩到 **96B**
(windEnabled@28、gravity@32、windDirection@48、windSeed/baseSpeed/gustFreq/spatialScale/
tickSeconds@64..84、obstacleCount/pads@84..96),但宿主三处分配仍按
`CLOTH_PARALLEL_PARAMS_BYTES = 48`:

1. `packClothParallelParams`(softBodyGpuDispatch.clothParallel.ts)——且风字段写入
   floats[12..20](字节 48..84)**超出 48B ArrayBuffer,TypedArray 越界写被 JS 静默忽略**,
   即使绑定有效风也是零(双重缺陷);
2. `createClothGpuStepSession`(clothSession.ts)paramsView/paramsBuffer;
3. 探针裸重放 paramsBuffer `createBuffer({ size: 48 })` 硬编码。

Chrome auto layout 按 struct **全长**(96B,不按入口静态使用裁剪)取 minBindingSize →
48B 绑定 → 全部 Submit 丢弃。

## 三、假设逐项排除表(任务书①-⑤)

| # | 假设 | 对照实验 | 判定 |
|---|---|---|---|
| ① | 镜像风噪声 vs WGSL windValueNoise | probe-02:WGSL 逐字转录(每运算 fround)vs 镜像,hash 全域逐位 + 20 万采样噪声 + tickSeconds 双路径 | hash 0 mismatch(既有结论维持);噪声 **4721/200000 mismatch,maxUlp=11**;tickSeconds 真实代码路径 336/512 mismatch → **部分成立,非根因**(ULP 级,~1e-7 动力学放大),列入同族修复;修复后 0/200000、maxUlp=0 |
| ② | GPU integrate 对锚点(w=0)early return | WGSL:w==0 → 清速回写 return,风块在后不触;真机 worstGpuInvMass=0 语义保持;且 GPU 根本未执行 | 排除 |
| ③ | mirror integrate continue 条件 | 镜像 `state[base+3]===0 → continue`(clothParallelSolver.ts)与 GPU 无分歧路径 | 排除 |
| ④ | project 系把粒子推走/索引错位 | WGSL project 自读自写(scale=correction·weight,锚点不动);色桶双端同源;发现同族缺陷:obstacleBindGroup params 绑 **3**(应 2)→ Invalid BindGroup(被根因掩盖) | 排除为根因;绑号缺陷一并修复 |
| ⑤ | pack/particlesFromState velocity 槽语义 | packClothGpuParticles(position+invMass/velocity/prev=position)逐字段核对;finalize 速度回算同式 | 排除 |

根因独占:params ABI 48B/96B 断裂(证据链见 progress-02)。

## 四、修复(最小 diff)

| 文件 | 修改 |
|---|---|
| `scripts/syncSharedWgsl.mjs` | 生成模板 `CLOTH_PARALLEL_PARAMS_BYTES` 48→96 + 机制注释;`wgsl:sync` 重生成 `src/physics/clothSolverWgsl.ts`(仅常量行,WGSL 字符串零改动) |
| `src/physics/clothSolverWgslChecksum.test.ts` | ABI 合同钉 toBe(48)→toBe(96) |
| `src/physics/softBodyGpuDispatch.clothParallel.test.ts` | 缓冲创建序 fixture params 48→96 |
| `scripts/clothParallelGpuProbe.ts` | 裸重放硬编码 size:48 → 常量;uncapturederror 监听与 worst 诊断转常驻(静默失效探测器) |
| `src/physics/softBodyGpuDispatch.clothParallel.ts` | obstacleBindGroup params 绑定 3→2(projectObstacles 静态使用 params@binding(2)) |
| `src/physics/clothParallelSolver.ts` | 镜像风噪声逐运算同构:①sx/sz 逐运算 fround(mirrorQuintic);②(v10-v00)/(b-a) 先舍入再乘;③tickSeconds 与 dispatch pack 同式(f64 累加一次舍入) |

## 五、真机复验(rerun-final,exit=0)

| 指标 | 修复前 | 修复后 | 门 |
|---|---|---|---|
| production wind per24 maxErrVsMirror | 1.55564269717622(冻结) | **2.085e-5(tick24)/ 2.395e-5(tick48)**,双跑逐位复现 | ≤0.05 ✅ |
| session 240tick mirror err | 1.55564269717622 | **5.358e-3** | ≤0.05 ✅ |
| session golden(f64) | 1.5556426634585343 | **9.003e-3** | ≤0.05 ✅ |
| session stretch | 1.0 | **0.0231** | ≤0.05 ✅ |
| 裸重放 gpuFingerprint | 恒 703b374387807d93(初始态) | 逐 tick 演进,tick240=7a4bcdd4…(**=文档登记的无风基线指纹**) | — |
| bare golden / replayBitwise / kinetic | 0.047 / true / 0 | **9.0e-3 / true / ≠0** | ✅ |
| uncapturedGpuErrors | minBindingSize 违约流 | **空** | ✅ |
| 裸重放 simulationParityBitwise | false | false(**A3 文档登记口径:GPU vs 镜像 9.0e-3 容差内非逐位,非门项**) | 登记口径 |
| softbody 并行核 per24 | 2.6e-5..4.2e-4 | 同值(零扰动) | ✅ |

物理域回归:`vitest run src/physics` **174 passed + 3 skipped**(与修复前基线同值);
`tsc --noEmit` exit 0;风噪声镜像 vs WGSL 逐位(0/200000)。

## 六、如实边界(不放过、不挑点)

1. **障碍场景 obstacleGoldenMaxPosErr = 0.6177 > 0.1(gate)**:算子错配,非内核缺陷。
   探针给 f64 黄金的是 sphere 接触(r=0.45),给 GPU 的是 cuboid OBB(halfExtents 0.5);
   布料初始大部分在 cuboid 内部,GPU 按合同把内部粒子推到盒面,黄金只推球面附近粒子。
   该场景为主线程本批次新增,历史上从未绿过(此前因 48/96 根因 GPU 全静默);不在
   clothParallelGpuTest.mjs 退出门内。可执行动作:探针黄金 contacts.project 换成与 GPU
   同式的 cuboid 最小轴推出(或 GPU 换 sphere),该门才有效力。
2. 全仓 `vitest run src` 5638 passed / **3 failed** / 47 skipped:失败全部位于主线程在途
   WIP 域(layeredMaterial shader anchor、rendererCapabilitySelfCheck、packetDeformation、
   cascadedShadow Rust bindings 正则),与本次布料家族 diff 域不相交,其宿主文件均为
   主线程已改文件;src/physics 与 tsc 全绿。
3. 诊断保留:probe 常驻 uncapturedGpuErrors 通道与 per24 worst 诊断(Chrome 静默丢
   Submit 类缺陷的唯一可见通道);一次性 bindGroup 验收探测已移除(结论:该方法无效,
   Chrome 不在 createBindGroup 抛错)。

## 七、不变量确认

- 未动:`wgsl/clothSolver.wgsl`(WGSL 真源字符串零改动)、串行核(softBodyGpuDispatch.ts
  /softBodyGpuWgsl.ts)、jc-i-continuation、四项用户资产;
- 无 commit/push/reset/clean/stash;
- GPU 真机双跑逐位(replayBitwise=true)、逐调用 vs 会话逐位(bitwiseEqualsPerCall=true)
  维持;production kernel=cloth-parallel 无回退。
