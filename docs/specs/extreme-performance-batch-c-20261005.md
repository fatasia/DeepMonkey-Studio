# 批次 C 极致性能——基线与刀位(2026-10-05 主线程,deep-fair-comparison 实测)

> 对拍工具:`apps/web/scripts/gate-deep-fair-comparison.mjs`(三引擎同场景同轨迹;本基线=test-output/deep-fair-comparison/report.json+deep-fair-baseline-20261005.log,脚本 Beta 过时标签已修)。

## 基线(Deep WebGPU vs three-webgl 参考)

| 轴 | three-webgl | Deep WebGPU | 判定 |
|---|---|---|---|
| 静置帧 p50/p95 | 6.9/7.1ms | 6.9/**7.0**ms | **同水位,已胜**(exceeds.staticP95=true) |
| 输入轨迹 p50 | 6.9ms | 7.0ms | 持平 |
| **输入轨迹 p95** | **7.1ms** | **20.9ms** | ✗ 3× 尖刺(p99 48.8 vs 34.9) |
| 首帧(切后端) | ~61ms | **3122.7ms** | ✗;阶段:module 27.9/env 205.8/**scene-uploaded 2444.4(78%)**/余 444 |
| 黑帧 | 0 | 0 | ✓ |

## 刀位①:输入 p95 尖刺三层分解(实测)
1. **submitGap(提交间隔)p95=23.2ms**(webgl 0.2ms)——帧时 p95=20.9 的直接来源;Deep 的 queue.submit+rAF 节奏 vs webgl 合成器直提交的模型差。
2. **pointerToGpuComplete p50=49.5/p95=83.3ms**——手感延迟疑凶;**口径嫌疑大**:onSubmittedWorkDone 是队列级排空(含历史提交排队),非单帧 GPU 时间;改 per-frame timestamp querySet 才是真值(与 T25 逐 pass 计时同源)。
3. pointer→submit p95 3.0ms(webgl 1.5)——CPU 侧 2×,绝对值小,优先级低。

## 刀位②:首帧 scene-uploaded 2444ms(78%)
T11 冷管线已 -74% 的基础上第二刀:场景上传阶段分解(module→env→upload→validated),指向几何/纹理缓冲上传与管线编译的重叠度。候选:上传与编译流水线化(不互相等待)、按相机视锥优先上传、asset hash 缓存跨会话复用。

## 刀 A 判定(2026-10-05 双轨重跑,空闲服务器)
- **呈现口径三后端全部 ≈0ms**(webgl -0.1/webgpu -0.2/wasm -0.1 @p95)——指针下一帧即上屏,用户手感三后端同级;**"83ms 手感延迟"实锤为 onSubmittedWorkDone 队列排空伪指标**(队列含全部历史提交,与单帧无关)。
- **Deep 帧时输入 p95=7.2ms vs three 7.1——同水位**;上轮 20.9 尖刺未复现,定性为环境污染(与 UI 摸底路抢服务器+API watch 重启窗口)。**输入轴达标**,刀 B 探针降级为可选深挖。
- 批次 C 剩余唯一大刀=**刀 C 首帧**(3122ms,scene-uploaded 2444ms/78%):归因路径=rt-firstframe-marks.mjs 探针(需先经对话框切 Deep 后端才有完整 mark 序列,首版只捕到 module-ready);候选刀:上传/编译流水线化、视锥优先上传、asset hash 跨会话缓存。

## 执行顺序
刀 A(测量口径修正,半天):pointerToGpuComplete 改 timestamp query 口径→重跑对拍→若真 GPU 帧时本就 <10ms 则"手感延迟"是伪指标,消除误导;刀 B(submitGap,1-2 天):rAF 提交节奏归因(有无跳帧/双 rAF/队列背压);刀 C(首帧 scene-uploaded 流水线化,2-3 天)。

## 进展(2026-10-05 主线程)
- **刀 A 已落**:对拍脚本双轨口径(新增 pointerToPresent=指针后第二个 rAF=该帧已呈现;保留队列排空口径作历史对比),summarize 已接。带新口径重跑与路 9(UI 摸底)抢同一服务器冲突(canvas 等待超时)——**对拍延后至路 9 收口后执行**(或独立端口起第二套服务)。
- **刀 B 归因修正**:submitGap 跨后端不可比——webgl 侧 recordBackend(undefined)(合成器直提交无队列间隔可测,0ms 是测量语义产物);webgpu 侧 8.3ms p50≈vsync 节奏。**帧时 p95 20.9 的真归因=输入轨迹下的帧内分解**,正确工具=T25 逐 pass GPU 计时(F1 帧收据):输入轨迹+逐 pass 采样的探针跑真机,定位 7.0→20.9 的增量落在哪个 pass(候选:输入→场景 dirty 重投影/可见性重算/提交等待)。探针形态照 lab/sdfGiGpuProbe.ts 惯例。
- 待三路收口(GI✓ 后):刀 A 重跑+刀 B 探针+刀 C 首帧流水线化。
