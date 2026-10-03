# F6/T18 布料并行核风场 WGSL 化(2026-10-02,主线程;进行中——本文件=精确续作蓝图)

## 已完成(本批)

1. **ClothParams ABI 扩 48B→96B**(WGSL 字符串已改):追加 `windEnabled: u32, windSeed: u32, windBaseSpeed: f32, windGustFrequency: f32, windSpatialScale: f32, windTickSeconds: f32, windDirection: vec4f`(gravity 后)。tsc 过。
2. **integrateParticles 接风**:`windEnabled != 0u` 时 `noise = windValueNoise(tick*freq, y*scale, seed)`,`speed = baseSpeed*(0.5+noise)`,加速度 = gravity + dir*speed(与 CPU clothSolver.windAcceleration 同构:`acceleration = direction × baseSpeed × (0.5+noise(t·f, y·scale))`)。
3. **windValueNoise WGSL**:hash 整数链与 `terrainRandom.hashGrid2D` **逐位同构**(0x27d4eb2d/0x165667b1/0x9e3779b9/两轮 imul+移位,纯 u32);quintic smoothstep+双 lerp 标量 f32。windEnabled=0 时路径不触(零风退化应逐位=现风绿基线)。

## 续作步骤(精确)

1. **pack 扩**:`packClothParallelParams`(grep 定义,约 clothGpuWgsl.ts 或 clothParallelSolver.ts)48B→96B,补 9 槽写法(镜像 u32/f32 槽位对齐 WGSL struct 顺序:windEnabled u32@7、gravity vec4f@8-11(4 floats,含 w pad)、windDirection vec4f@12-15、windBaseSpeed@16、gustFreq@17、spatialScale@18、tick@19 → 共 20 槽=80B→WGSL struct 尾对齐 96B,pack 仍写 80B 字节其余零)。
2. **ClothParallelMirror 同步**(clothParallelSolver.ts,step() 内 integrate 段 ~232 行):
   - `ClothParallelConfig` 增可选 `wind?: ClothWind`(复用 clothSolver.ts 的 ClothWind 类型);
   - 镜像 f32 噪声:`windHashF32(x,z,seed)`(Math.imul 与 WGSL u32 乘逐位同构)+quintic/lerp 每运算 `f()` 舍入;
   - substep 时间:`t = (this.#tick 确认递增位置)*dt + sub*h`(先 grep #tick 递增点确认基准);
   - integrate 三行:`ax = f(gx + windDirX*speed)` 等,速度公式不变。
3. **dispatch 副本**(softBodyGpuDispatch.clothParallel.ts 同款布料 dispatch,在 clothParallel 文件或其 dispatch 所在处):per-substep params 副本 buffer(构建期 8 个,`windTickSeconds = (tickBase+sub)*h`?——**对齐镜像 t 定义**),integrate bind group 8 套;其余 pass 共享主 params(若 wind 字段被 finalize/project 读取无影响——它们不触)。
4. **CPU 测试**:①windEnabled=0:全新风绿矩阵回归逐位(退化的正确性);②wind>0:镜像 vs GPU 真机容差(沿 clothParallelGpuTest,布料 9.0e-3/0.05 同族)+镜像 vs f64 黄金 ClothSolver(带风)容差;③风开/关输出不同(生效证明)。
5. **真机**:clothParallelGpuTest 的 production 路径增风场景(两跑逐位+镜像容差)。

## 关键合同

- 镜像=GPU 同构 f32 真值(风 hash 整数部分双端逐位;插值 f32);f64 黄金(ClothSolver.windAcceleration)容差对照。
- windEnabled=0 全链逐位退化——不得破坏既有风绿矩阵。
- CPU f64 风噪声(terrainRandom.f64)与 f32 镜像的差异由 f64 黄金容差承担,同布料 A3 口径。

## 状态更新(同日续作完成度)

- **已完成**:①WGSL 三处(params 96B/integrate 接风/value noise f32);②pack 96B+wind 参数(integers[7]=windEnabled/windDirection/seed/baseSpeed/gustFreq/spatialScale/tickSeconds);③dispatch per-substep params 副本(风开时 substeps 个 buffer+integrate bind group 各套,风关时单副本逐位退化);④**ClothParallelMirror 接风**(f32 噪声 mirrorWindNoise 与 WGSL 逐运算同构,hash 整数链逐位;**seed 混 WIND_NOISE_SALT 与 f64 黄金同源**——盐值缺失曾致 78 米发散,已导出 WIND_NOISE_SALT 对齐);⑤测试:镜像带风 vs f64 黄金 240 tick 实测 0.081(风容差按实测登记 0.1,声明=f32 噪声插值量化经动力学放大,A3 先例)、风开关终态指纹不同(生效证明)、无风退化既有矩阵全绿。物理域 **177 passed+3 skip**。
- **真机复验(本批完成,exit=0)**:production auto 链三端同源接风(GPU dispatch wind 副本/镜像 config.wind/f64 黄金 ClothSolver wind);带风 64 tick **kernel=cloth-parallel 无回退**、GPU vs 镜像 24 tick 0.0198/48 tick 0.0533、f64 黄金 **0.056≤0.1**(风场景登记容差);**裸重放(GRID 无风)240 tick 指纹与无风基线逐位相同**(cpu=2757a337…/gpu=7a4bcdd4…)——风关路径零扰动证明。evidence sha256 2ce5a888…。**布料风场 GPU 化全链闭合(WGSL/镜像/dispatch 副本/真机)。**
