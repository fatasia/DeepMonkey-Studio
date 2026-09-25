# Babylon Web 轨道采集 harness（V4 性能基准）

V4 四对手基准（Three/Babylon/Unity/Bevy）中 **Babylon Web 轨道的最小可复跑采集 harness**。
本轮为**单侧采集切片**：只采集 Babylon 侧样本，candidate（Deep 对应轨道）配对留后续切片；
evidence 与 Bevy 轨道 `test-output/bevy-019-benchmark/paired-evidence.json` **同 schema**
（`deep-engine.competitive-benchmark.paired-raw` v2，case/fixture/settings 三 hash + rounds 原始样本 + provenance）。

## 依赖边界

- `@babylonjs/core@9.26.1`：npm registry 固定版本，**只装进本目录** `node_modules`
  （`package-lock.json` 锁定），不进 `apps/web` 运行依赖、不进 pnpm workspace。
- playwright-core 复用仓内 `apps/cloud-render-worker/node_modules/playwright-core`；
  esbuild 复用 `packages/deep-engine/node_modules/esbuild`；均不新增依赖安装。
- 本机 Chrome（`BIM_STUDIO_CHROME_PATH` 可覆盖，默认
  `C:/Program Files/Google/Chrome/Application/chrome.exe`），headless + `--enable-unsafe-webgpu`。

## 复跑

```powershell
cd scripts/benchmarks/babylon-web
npm install                      # 首次；固定 @babylonjs/core@9.26.1
npm run bench                    # 产出 test-output/babylon-web-benchmark-20260922/
```

产出：

- `paired-evidence.json` —— 与 Bevy 轨道同 schema 的 evidence（`track=babylon-web`，candidate=null）
- `paired-summary.md` —— 仓内 `scripts/benchmarks/paired-summary.mjs` **零修改**直接消费（候选侧如实标"未采集"）
- `raw/round-N-babylon.json` —— 每轮原始帧样本（逐帧 render 墙钟 + GPU 时间戳原始值 + JS 堆采样）
- `raw/round-N-chrome-tree.process-metrics.json` —— Chrome 进程树内存峰值采样

轮次：默认 3 轮冷热交替（冷=全新 user-data-dir；热=复用上一冷轮 profile 的 shader 磁盘缓存），
`BABYLON_WEB_BENCH_ROUNDS` 可覆盖轮数。每轮 warmup 30 帧 + 采样 120 帧（与 Bevy 配对轮同参数）。

## 夹具对齐（factory-instances/cubes-v2）

对齐对象：`scripts/benchmarks/bevy-0.19.1/src/main.rs`（Bevy 0.19.1 runner 的夹具生成）。

| 维度 | Bevy 0.19.1 | Babylon 9.26.1（本 harness） | 差异处理 |
|---|---|---|---|
| 实例 | 256 × `Cuboid(0.08)`，同 mesh+material 批处理 | 256 thin instance × `CreateBox(size=0.08)`，1 几何 1 材质 | 实例化路径等价 |
| 布局 | `x=(i%side)*0.11-offset, y=((i*17)%7)*0.007, z=(i/side)*0.11-offset, offset=(side-1)*0.055` | 完全一致 | 无 |
| 材质 | `StandardMaterial` base srgb(0.24,0.52,0.9), metallic 0.15, roughness 0.42 | `PBRMaterial` albedo（sRGB→线性换算后）同值同参数 | sRGB→线性由本侧显式换算 |
| 光照 | 平行光 `normalize(0.2855,0.8,0.586)`，illuminance 18000 lux，开阴影 | 同方向平行光，intensity=3.0（无量纲），开阴影（1024 PCF） | **单位体系不同**：lux vs 倍率，仅同方向同"开阴影"语义 |
| 相机 | yaw 0.55, distance 4, fov=2·atan(1/2.05), near 0.1, far 100 | 完全一致 | 无 |
| 视口/MSAA | 1280×720, MSAA 4, auto-no-vsync | 1280×720, WebGPU antialias(4x)，同步循环驱动（无 vsync 钳制） | MSAA 请求值 4，WebGL2 回退时由浏览器决定并如实记录 |

## 采集口径（诚实边界）

1. **cpu-frame-\***：同步 `scene.render()` 墙钟，循环驱动（非 rAF——headless 虚拟 60Hz 会钳制帧间隔，
   循环驱动更贴近 Bevy `auto-no-vsync` 语义）。Bevy 侧 cpu-frame 为帧间隔 delta，两者相近但**非同一口径**。
2. **gpu-frame-\***：Babylon `captureGPUFrameTime`（WebGPU timestamp-query，两时间戳相减，原始纳秒），
   /1e6 换算毫秒；引擎/驱动不支持时该指标如实为空，不虚构。
3. **peak-host-bytes**：Chrome 进程树（主进程+全部后代）WorkingSet 之和的峰值，
   `run-windows-process-tree-metrics.ps1` 200ms 采样；**与 Bevy 单进程 PeakWorkingSet64 口径不同**
   （Chrome 为多进程树）。peak-private-bytes 另存 raw 供参考。
4. **cold-start-ms**：浏览器进程启动 → 首帧渲染完成（含页面加载+引擎创建+管线编译）；
   **load-to-interactive-ms**：启动 → 首帧 + 像素读回验证完成。热轮数值自然偏低（缓存生效），
   每轮 `mode` 字段标明冷热。
5. **缺失指标**（input-latency / long-run / visual-similarity / peak-gpu-bytes 视环境）：如实 null，
   不虚构分位数；readiness.status=incomplete、eligibleForBenchmarkVerdict=false。
6. **backend**：WebGPU 优先（对应 Bevy Vulkan 档位），Chrome Windows 上经 Dawn 走 D3D 层，
   与 Bevy Vulkan **不构成同一图形 API 口径**；WebGPU 不可用时回退 WebGL2 并逐轮记录。
7. 单侧采集，环境对拍（candidate vs reference GPU 一致性）本轮不可做，environmentIssues=[] 仅表示未发现记录。

## 交付边界

- 本目录（脚本+锁文件）入库；`test-output/` 产出与 `node_modules` 不入库（gitignore）。
- candidate（Deep 对应轨道）配对、四对手矩阵聚合、画质相似度、30 分钟长稳：**后续切片**，本轮不宣称。
