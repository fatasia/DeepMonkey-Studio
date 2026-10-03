# ENG-source-size 拆分执行记录(2026-10-03)

> 行名称:ENG-source-size。目标:11 个 sourceSizeGate ERROR 文件按职责拆分,failures=0。
> 纪律:拆分=按职责分文件+导出重组,**不改任何运行语义**;禁凑行数掰函数;禁 cargo;禁帧时测量;
> 不 commit/push;GPU 被他线占用(F5/H-C7-P1),probe 真机复跑不做,只做语法/单测验证。

## 1. 现状核查(2026-10-03 执行时)

- 门禁规则(`packages/deep-engine/scripts/sourceSizeGate.mjs`):>300 行 WARN,≥301 行 ERROR;
  HEAD 中已超限的 legacy 清单豁免。11 个标的全部为 ERROR ⇒ 它们在 HEAD 无超限基线(多数为
  2026-10-02 各线新增的未跟踪/未提交文件,无 HEAD baseline ⇒ 不豁免)。
- runner 合同:5 个 probe 均为 esbuild 入口(`f3VirtualTextureGpuTest.mjs` 等 runner 以
  `entryPoints: ["scripts/<name>.ts"]` 引用并 `import("./probe.bundle.mjs")` 调用其具名导出)。
  **入口文件路径与导出名必须保持**——拆分方案全部保留原入口文件为 re-export 合同面。
- 消费方:src 侧入口 `softBodyGpuDispatch.clothParallel.js` 被 `physics/index.ts`、
  `softBodyGpuDispatch.clothSession.ts`、`softBodyGpuObstacleAbi.test.ts`、三个 scripts probe
  引用——拆分后入口保留全部既有导出面,消费方导入路径零变化。
- 测试命名惯例:仓库既有 `*.testUtils.ts` 惯例(被 `tsconfig.json`/`tsconfig.lab.json` 显式
  exclude,与 `*.test.ts` 同为测试专用),三个测试文件的夹具采用该后缀。

## 2. SHA 依赖核查表(拆分前完成,关键前置)

对 test-output/ 与 docs/(排除 node_modules)全量扫描:文件名引用 × 600 字符窗口内 sha 字段。

| 文件 | 冻结 SHA receipt | 锚定态 | 拆分处置 |
|---|---|---|---|
| scripts/softBodyObstacleGpuProbe.ts | `test-output/f6-softbody-abi-recovery-20261002/accepted-round{1,2}/evidence.json` `.sources[11]` sha256=`8c1da746…7079` | 证据时点**工作树态**(HEAD 无此文件) | 拆分 → 重锚(见 §4) |
| src/physics/softBodyGpuDispatch.clothParallel.ts | `test-output/softbody-wind-gpu-20261002{,-r2}/evidence.json` sha256=`e4728641…f3b3` | 工作树态 | 拆分 → 重锚 |
| src/physics/clothSolver.ts | `test-output/f6-continuation-20261001/{pbr-frame-loop,vertex-stream}/manifest-frozen.json` sha256=`b4b4d667…8b68` | 工作树态 | 拆分 → 重锚 |
| src/physics/softBodySolver.ts | `test-output/f6-continuation-20261001/vertex-stream/manifest-frozen.json` sha256=`17ee2122…415f` | 工作树态 | 拆分 → 重锚 |
| f3VirtualTextureGpuProbe.ts | 仅 `docs/specs/f3-virtual-texture-evidence-20261002.md:27` prose 路径引用(item evidence 无 sources/sha 段) | — | 入口路径保持,prose 引用继续有效 |
| 其余 6 个 | 仅 progress/milestone 文本提及,无 SHA | — | 直接拆分 |

**选择依据**:4 个有冻结 SHA 的文件选择"拆分 + 账本显式重锚"(J3-E 先例同款),而非
"内部分节保单文件"——因为单文件内部分节同样改变字节与 SHA,却无法解决 ≥301 行 ERROR;
拆分后 receipt 仍是其时点的真实历史记录,新证据由下次 probe 真机复跑按新 SHA 重生成。

## 3. 逐文件拆分记录(11 标的 → 33 文件,全部 ≤300 行)

### 3.1 GPU probe 组(5,入口文件保留 runner 合同导出,re-export 重组)

| 标的(原行数) | 处置 | 新结构(行数) | 验证 |
|---|---|---|---|
| f3VirtualTextureGpuProbe.ts (725) | 拆分 1→5 | 入口 69(runner 合同 probeAdapterInfo/runF3Item/F3LegOutcome)+ Session 123(会话/驱动/代理条目)+ Readback 204(生产 WGSL 读回/基线)+ Metrics 102(SSIM/差异/遥测)+ Legs 259(四证据腿) | esbuild bundle OK |
| clothParallelGpuProbe.ts (589) | 拆分 1→5 | 入口 21(re-export 四 runner 导出+gpuUncapturedErrors)+ Shared 72(常量/指纹/GPU 上下文)+ Replay 205(240 tick 主证据)+ Production 217(换核入口复验)+ Softbody 109(软体并行核复验) | esbuild bundle OK |
| c8ObstacleSubstepProbe.ts (555) | 拆分 1→4 | 入口 239(probeAdapterInfo/runC8ObstacleSubstepProbe)+ Shared 80(常量/视图/度量)+ Mirror 105(f32 逐运算镜像)+ ColorOrder 151(f64 色序变体) | esbuild bundle OK |
| softBodyObstacleGpuProbe.ts (531) | 拆分 1→4 | 入口 26(re-export 四 runner 导出+gpuUncapturedErrors)+ Shared 60(GPU 上下文/几何夹具)+ Projection 283(A 列直通投影+A2 变体矩阵)+ Replay 189(B/C/D 动力学场景) | esbuild bundle OK |
| f2HlodCullGpuProbe.ts (482) | 拆分 1→2 | 入口 275(runF2HlodCullGpuProbe)+ Render 219(ID WGSL/编解码/矩阵/实例打包/读回/膨胀) | esbuild bundle OK |

### 3.2 软体物理组(3,src 域,消费方导入路径零变化)

| 标的(原行数) | 处置 | 新结构(行数) | 验证 |
|---|---|---|---|
| softBodyGpuDispatch.clothParallel.ts (394) | 拆分 1→3 | 入口 96(遥测+dispatchClothStepAuto+全导出面 re-export)+ Contract 97(障碍 ABI/合同类型/dispatchCount)+ Kernel 244(params 打包/管线缓存/tick 步进) | tsc --noEmit OK;clothParallel/clothSession/ObstacleAbi 测试 20/20 绿 |
| softBodySolver.ts (323) | 拆分 1→2 | 求解器 284(类原样)+ Contract 54(SoftBodySolverConfig/Snapshot/VolumeStats,入口 type re-export) | tsc OK;物理域 36 文件全绿 |
| clothSolver.ts (310) | 拆分 1→2 | 求解器 260(类原样)+ Contract 67(ClothWind/Config/Snapshot/StretchStats/WIND_NOISE_SALT,入口 re-export) | tsc OK;物理域 36 文件全绿 |

### 3.3 测试组(3,describe/it 名与测试数零变化——外部证据按测试名引用不受影响)

| 标的(原行数) | 处置 | 新结构(行数) | 测试数(与拆分前一致) |
|---|---|---|---|
| webgpuProbeCaptureAdapter.test.ts (360) | 夹具外移 1→2 | 测试 276 + testUtils 93(fake device/plan/context/execute) | 14 passed + 2 skipped(Naga 门)=16 ✓ |
| softBodyGpuDispatch.clothParallel.test.ts (319) | 夹具外移 1→2 | 测试 208 + testUtils 121(枚举 shim/fakeDevice/grid/star/期望流/parity fixture) | 13 passed ✓ |
| probeSceneRadianceProducer.test.ts (313) | 夹具外移 1→2 | 测试 241 + testUtils 82(fake device/planePacket/captureContext/sunlit) | 13 passed + 2 skipped(Naga 门)=15 ✓ |

## 4. SHA 重锚账本(冻结 receipt → 拆分后新锚,拆分后实测)

| 文件 | 旧锚(receipt,证据时点工作树态) | 拆分后新 sha256(工作树实测) |
|---|---|---|
| scripts/softBodyObstacleGpuProbe.ts | `8c1da7469bd82b90e79991ccc47b57ad3ac26cbb91a1524ac2e4c8d528bb7079` | `ee0efa2220c5b37afa9951002fb83583cbc06eb283fb15a574872d57636eb850` |
| src/physics/softBodyGpuDispatch.clothParallel.ts | `e4728641cc71fe6f935d71ab97edc17e8983b952161ce51d4b536877378f53b3` | `8a6744ff65121c1f9c6aaf69031a59d88c24b16e5eab4069168b1aff063d346e` |
| src/physics/clothSolver.ts | `b4b4d6673688f0947b9bf92b567b620ec111ea01da2b93b62897149592088b68` | `ca84903c2a0e16e49cdb3ef0719bedc3047273893e0b1f87089ace7a0e1ff7cc` |
| src/physics/softBodySolver.ts | `17ee212286c275b180b644117540201df044fa69700d60a4b102949ce302415f` | `b683321fac5c073c279b754a5eeaf4a1ebaab6b46f0ee6b26f3859bf7d2ae3fc` |

- 语义接续声明:上述 receipt 是各自真机运行时点的真实记录,**不因本次拆分失效**;
  下次 probe 真机复跑(见 §6 未验证项)将以新 SHA 重生成 receipt,即完成重锚闭环。
- 注意:`softBodyGpuDispatch.clothParallel.ts` 的 receipt(e4728641)先于本会话就与
  工作树不一致(他线在途编辑),本账本只对"拆分前工作树态→拆分后"的变化负责。

## 5. 验证结果

- **门禁**:`node scripts/sourceSizeGate.mjs` → `files=3058 warnings=175 failures=0`
  (warnings 均为既有 legacy 超限,纪律允许保留;11 个标的全部离开 ERROR 区)。
- **probe 语法级**:6 个 probe 入口(5 标的+消费方 softBodyWindCollisionGpuProbe)esbuild
  bundle 全 OK(与 runner 同款打包路径,无 GPU 执行)。
- **类型**:deep-engine `tsc --noEmit` + `tsconfig.lab.json` + `tsconfig.examples.json` 三配置全绿。
- **runtime purity**:`runtimePurityGate.mjs` 通过(1013 browser/724 native 源)。
- **域测试**(src/physics+webgpu+rayTracing+lighting):353 文件,349 passed,**4 文件 7 用例失败
  ——全部为本会话之外的他线在途 WGSL/特性编辑所致**,归属证据:
  - `outputFamilyWgslChecksum`(directDisplay 镜像逐字节)、`iesSamplingWgslChecksum`(IES 镜像逐字节):
    失败原因是工作树中 `wgsl/directDisplay.wgsl`、`wgsl/iesSampling.wgsl` 等被他线修改而镜像未再生
    (本会话 33 文件不含任何 .wgsl/镜像文件;纯 HEAD 基线对照运行这 2 文件通过)。
  - `pbrGodRaysIntegration`(shadow read 声明 ×2)、`pbrPipelineSet`(Hi-Z MRT/static-only 分配/
    pipeline-set 去重 ×3):读取 `pbrRendererFeatures/pbrFramePlan/pbrPipelineSet` 在途态,
    均非本会话足迹(本会话 src 侧只动 §3.2/§3.3 所列 11 文件)。
  - 本会话直接域:物理域 36 文件 207 passed/3 skipped 全绿;三个拆分测试文件测试数与拆分前逐一相等。
- **禁项遵守**:无 cargo;无帧时测量(量化用例保留原 host 侧准备成本口径,未新增 GPU 计时);
  未 commit/push;未触碰 apps/web/src/ai/、apps/api/src/、AiAssistantPanel*、ViewerSceneCommandPort*、
  editorSceneWriteDriver*;jc-i-continuation-20261001.md 只读。

## 6. 未验证项(诚实声明)

1. **5 个 probe 真机复跑未做**(GPU 被 F5/H-C7-P1 占用):拆分只通过 esbuild bundle(语法/导入/
   导出面)与既有单测验证;真机数值证据(如 F3 四腿、C8 四方对拍)需 GPU 空闲后按 runner 复跑,
   复跑 receipt 将携带 §4 新 SHA。
2. **3-4 个失败测试文件未修**:见 §5 归属,属他线在途域(镜像未再生),超出本线权限;
   待相应线收口时以 `wgsl:sync` 类流程重生成镜像。
3. **会话期间检测到并行 stash 事件**:工作树 stash 栈中出现一条仅含他线 ai/* 域文件的 stash
   (非本线创建;本线的全树 stash 已在会话中安全 pop 恢复,选择性 push 因未跟踪文件 pathspec
   原子失败未产生任何 stash)。本线按"不碰他线域"纪律未处置该条目,已核实本线 33 文件全部完好。
4. **原 11 文件的拆分前工作树 SHA 未逐个留档**(除 §4 四个 receipt 已锚文件外):拆分是逐文件
   "读原文→写拆分"完成,未引入中间快照;若后续需要拆分前字节级基线,git 工作树差异
   (本会话未 commit)可回溯 HEAD+他线编辑的复合态,但不精确等于"拆分前一刻"。

## 7. 交付物清单

- 修改(11):`scripts/f3VirtualTextureGpuProbe.ts`、`scripts/clothParallelGpuProbe.ts`、
  `scripts/c8ObstacleSubstepProbe.ts`、`scripts/softBodyObstacleGpuProbe.ts`、
  `scripts/f2HlodCullGpuProbe.ts`、`src/physics/softBodyGpuDispatch.clothParallel.ts`、
  `src/physics/softBodySolver.ts`、`src/physics/clothSolver.ts`、
  `src/webgpu/webgpuProbeCaptureAdapter.test.ts`、
  `src/physics/softBodyGpuDispatch.clothParallel.test.ts`、
  `src/rayTracing/probeSceneRadianceProducer.test.ts`(均在 packages/deep-engine/ 下)。
- 新增(22):§3 所列各拆分文件(Probe 组 13 + 物理组 4 + 测试夹具 5,合计 22 个新文件)。
- 本记录:`docs/specs/eng-source-size-split-20261003.md`。
