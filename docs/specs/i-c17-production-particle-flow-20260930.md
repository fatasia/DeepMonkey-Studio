# I-C17 粒子流场生产消费

在已有 GPU 粒子双缓冲运行时接入当前 curl-noise 核，保留原发射、压缩、间接绘制、取消与资源归属。

状态：CPU/类型与两fresh实际GPU已通过，源冻结待主线程构建/提交。

视觉立场：沿Babylon流场机制与Siemens克制工业渲染，用已有base.css深色容器和实际PBR HDR画面呈现单一流线。256粒子的颜色属于显式fixture材质，不加产品主题令牌或编辑器。

## 现状核查

1. 已检索 packages/apps 全源和未跟踪文件。现有 `wgsl/particleFlowField.wgsl`、sidecar、`gpuParticleFlowFieldWgsl.ts` 是在树草稿；没有flowFieldNoise CPU镜像、32B参数宿主或生产import。注释中提到的镜像/锁步测试不是已有文件。
2. 已读 contracts 场景类型与 validation、GpuParticleRuntimeOptions/FrameInput、GpuParticleEmitter：已有alarm-pulse/expanding-ring/flow-line预设，64B粒子槽、32B每帧参数、容量与步长预算。contracts没有独立particle/flow场景合同，不把它描述成已有作者入口。
3. 已查deep-engine依赖：现WebGPU、shader mirror同步、Vitest与lab/Playwright工具可用，不加库/不造新的粒子平台。
4. 已读消费方：PbrRenderer `particleEmitters`→createGpuParticleRuntimeFromEmitters→每帧beginFrame→PbrParticlePass；它是现有生产SDK入口。Studio当前没有把自定义GpuParticleEmitter作者对象接到此接口，完整场景作者配置需沿现有模型效果路径核查后决定。
5. 已查gpuParticleRuntime/Emitters/Burst/Indirect与particleBudget/Curves/Events/Stats测试，existing双缓冲发布、重入/取消、设备lost与已提交工作退休机制可复用。新flow无CPU或实机证据；历史test-output中的源码副本不算当前证据。
6. 已读0930handoff、remaining estimates和权威剩余清单：I-C17真实余项为现草稿消费/预算/确定性/可关停/实机，T20另保留透明排序、LUT与烟体边界，不混做通用流体。

已有（不重建）：解析梯度curl WGSL草稿、相同0..5绑定与粒子ABI、容量/步长上限、预设发射、GPU压缩双缓冲、indirect billboard、取消/重入/提交退休和资源回收。

真实缺口：32B流场参数及限制、核身份/字节锁、CPU数值参考、运行时按需流场PSO与binding6、真实frame消费、开关/零强度保持原核路径、确定性与真实GPU量化、作者对象保存入口边界。

## 最小接线

新增独立参数/CPU参考叶子后，沿GpuParticleRuntime现beginFrame选择模拟pipeline。省略flow，或strength=0且无速度帽时，选择原simulateAndCompact，零资源与零额外dispatch。开启只多32B uniform和一个compute pipeline，不增加第二粒子状态缓冲；原reset/compact/indirect顺序、当前slot发布与退休机制不改。

显式时间phase与整数seed；每粒子3次8角点解析噪声，固定64 workgroup，已有容量硬帽。GPU异步压缩slot顺序不作为确定性口径，按粒子稳定ID比较轨迹；同输入/seed/phase两次同设备逐值一致，CPU f32参考按实际FMA差记录容差。

## 状态与锁

C18已在633557be收割。新增flow参数/CPU参考/核身份三个测试文件共6测PASS，engine类型检查PASS。主线normal/shadow短窗口期间源冻结；结束后沿批准的GpuParticleRuntime/Emitters、PbrRendererTypes与PbrRenderer粒子传参接线。

作者范围已核查：Studio ModelEffects fire属于Three owner，没有通用GpuParticleEmitter作者配置；本刀按权威余项接已有生产SDK入口，在RenderView提供显式phase/seed与逐帧关停，不把新的节点编辑器计为本刀交付。

新增参数上限：phase±1e6、scale[1e-6,1e6]、speed/strength/maxSpeed[0,1e6]、seed完整u32；位置查询域沿canonical核钳制±1e6。32B结构中6号word保留u32种子、5/7号word为零。GPU已有双槽预算不变，开启额外32B uniform，设备需两个compute uniform binding。实际视觉只深色1920×1080两fresh realm。

## CPU 与生产接线

RenderView.particleFlow → PbrRenderer.driveParticles → submitGpuParticleEmitterFrame → GpuParticleRuntime.beginFrame，显式phase/seed逐帧打包。省略flow或strength=0且maxSpeed=0选原pipeline。flow可选stage仅借既有state/counter/indirect/frame，验证后发布；并发首次开启共用一个staging promise，失败释放候选且可重试。开启后切回原核仍保留32B，直到runtime.dispose；创建/提交/发布全部保持同device owner，替换设备后current为空且不提交。

当前6个聚焦文件21测PASS/1既有Naga环境skip；覆盖原核基线选路、参数/核字节、解析导数与无散近似、CPU积分与速度帽、候选验证失败重试、重入去重、设备替换与提交退休后释放。engine、lab与Web类型检查PASS。

## 实际GPU证据

`node scripts/i-c17-production-particle-flow.mjs`：两fresh Chrome realm，深色1920×1080，独立esbuild直接消费当前源码。全engine src与WGSL前后身份一致，sourceFresh/stable=true；shader SHA `643fe3e9f9994abefd6f96ea097afa9b181b8c7ad33eed208642b3396f0cb821`，bundle SHA `20b8b3453ce701ea2af27fb9c95b5e2c19bfff5ddcaf28091dd1a0a16247b3ac`。

- 每轮16活粒子×8步，按稳定ID排序与f32参考对拍，最大误差1.1920928955078125e-7，速度帽0.8实值最大0.80000008811671；过期粒子删除、loop寿命回卷与indirect计数核对通过。
- 同seed重放逐值一致，异seed改变场；zero与原核全记录逐值一致。GPU压缩顺序不作为确定性合同，未声称跨不同GPU逐位一致。
- 非法参数和预取消保持上一活快照；基线7资源、开启8资源（仅多32B）、关闭后复用同资源、runtime.dispose归还全部。两轮session最后0资源、errors/diagnostics为空、设备同一epoch0。
- 实际PbrRenderer/RenderView/emitters/indirect/PbrParticlePass走HDR production路径；首帧无粒子与启用帧差异像素11536/11509，后继drawCalls=2。关闭只停止场驱动，不删除原粒子内容。

报告 `test-output/i-series-0930/particle-flow/evidence.json`；已目视 `round-1-flow-enabled.png`、`round-2-flow-disabled.png`。原fixture把regular grading contrast设0被产品合法性门拒绝，历史保存在`failure-illegal-fixture-grading.json`，改用C18/S4已有合法中性author grading；生产guard不变。

## 视觉检查与范围

两轮图中流线连续、颜色克制、端点在视区内、HDR混合无黑块或断裂。十维自评分按本刀生产SDK范围：布局9.5、令牌一致性9.5、排版不适用、状态9.5、动效9.5、3D渲染9.5、信息设计不适用、反馈9.5、深色1080适配9.5、参数语义9.5。适用项均9.5；排版/信息设计无新增UI，不计产品编辑器评分。图为机制诊断fixture，未把它当成完整工业场景美术或未测试的FPS成绩。

同族已核查flow+原模拟+burst共享reset/indirect切换：flow进入后须恢复base bind group，burst亦按既有owner处理。已测候选验证失败、重入、取消、device替换、submitted-work retirement，不另建第二生命周期。

后继范围：完整节点作者界面、透明排序、曲线LUT、火焰预算/烟体求解仍按T20；未改Native/Rust、C8材质shader或StudioThree fire owner。后继I-C1复用现有PLY/splat底座。

## Harvest

以下20文件为本刀；src/index.ts无需改，实际公开WebGPU入口为src/webgpu/index.ts。源码/runner冻结，test-output本地证据保留。

```text
packages/deep-engine/wgsl/particleFlowField.wgsl
packages/deep-engine/wgsl/particleFlowField.wgsl.sha256
packages/deep-engine/src/webgpu/gpuParticleFlowFieldWgsl.ts
packages/deep-engine/src/webgpu/gpuParticleFlowFieldWgslChecksum.test.ts
packages/deep-engine/src/webgpu/gpuParticleFlowFieldTypes.ts
packages/deep-engine/src/webgpu/gpuParticleFlowFieldTypes.test.ts
packages/deep-engine/src/webgpu/gpuParticleFlowFieldStage.ts
packages/deep-engine/src/particles/flowFieldNoise.ts
packages/deep-engine/src/particles/flowFieldNoise.test.ts
packages/deep-engine/src/particles/flowFieldParticleCpu.ts
packages/deep-engine/src/particles/flowFieldParticleCpu.test.ts
packages/deep-engine/src/webgpu/gpuParticleRuntime.ts
packages/deep-engine/src/webgpu/gpuParticleRuntime.test.ts
packages/deep-engine/src/webgpu/gpuParticleEmitters.ts
packages/deep-engine/src/webgpu/pbrRendererTypes.ts
packages/deep-engine/src/webgpu/pbrRenderer.ts
packages/deep-engine/src/webgpu/index.ts
packages/deep-engine/lab/iC17ParticleFlowProduction.ts
scripts/i-c17-production-particle-flow.mjs
docs/specs/i-c17-production-particle-flow-20260930.md
```

主线程收割复核：6文件21测通过/1既有Naga skip，两实际截图已核看；engine与Web生产构建通过，新Native源码对应WASM已重建，runtime artifact freshness通过。I-C17本刀关闭，完整作者节点/T20后继保留。
