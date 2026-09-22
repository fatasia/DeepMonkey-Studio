# Deep2D V-04 短时稳定性与性能复验

范围：当前 Native 工作树、单机 RTX 4060 Laptop / Vulkan、真实 1280×720 Win32 surface，复用 8×8192 折线图七场景。8 小时 soak 仍明确排除；此报告不替代跨设备或真实驱动 TDR 验收。

## 测量合同

- 每场景 5 帧预热 + 30 帧正式采样；同进程最多 20 轮，共 4,900 次提交/呈现、4,200 个正式帧。静态重复场景必须无 restage、无上传。
- 原探针 CPU 取 30 帧，但 GPU 百分位混入 5 帧预热。现 GPU 与 CPU 使用相同帧区间并校验长度；`raw_samples` 保留采样顺序，百分位只排序副本。
- 原 `prev_present` 实际在 acquire 后更新，统计的是 acquire 间隔。现于 `queue.present` 返回后更新时间，下一帧 acquire 完成时读数，符合字段声明。GPU/present 使用 `measurement_schema=2`，不与旧口径直接相减。
- CPU prepare 保持旧口径：present_chart/文字栅格化/stage/编码/提交及 stage_cpu 包裹的数据操作；不含 fixture 构造、操作前数据 clone、首次环境/字体初始化。不把它称作整个应用启动时间。
- 显存值仍为顶点 shadow + path cache + 单个后台缓冲估计，不含 atlas、管线或驱动分配；OS working/private memory 与它分开记录。

## 可复跑入口

先执行 `cargo test --release --locked --manifest-path packages/deep-engine-native/Cargo.toml --test chart_e2e_perf --no-run`，使用返回的实际测试 exe：

```powershell
./scripts/run-deep2d-short-stability.ps1 -Executable <测试exe路径> -OutputDirectory <新的证据目录> -Rounds 20
```

脚本保存 exe SHA-256、当前工作树状态/探针源码 hash、CPU/OS/GPU 驱动/电源计划、stdout/stderr、100 ms 进程内存/句柄/线程采样和退出状态。目录已存在则拒绝覆盖；超时只终止本次创建的测试进程并保存失败证据。程序采样会产生少量开销，当前与对照应使用同一脚本。

## 失败与恢复口径

产品实窗测试覆盖 scene/shader/full 候选暂缓、旧候选抢占、可恢复呈现失败、最终版本发布；标准 delta 使用真实磁盘 watcher，涵盖零尺寸暂缓、坏候选/迟到拒绝、呈现后完整 LKG 和重启恢复。

设备矩阵使用隔离 `device.destroy()`→新建 device/cache→同内容重绘，对比恢复前后与恢复后重复帧字节；这是实际资源销毁/重建，不等于真实驱动 TDR 或随意删除生产 GPU 设备。人工 Narrator、真人 IME 候选窗和 V-02 视觉闭环不计入该性能报告。

## 当前版本首轮结果（优化前）

`test-output/deep2d-v04-20260918/`：20 轮 157.612 秒，退出 0，4,900 帧/4,200 正式样本通过完整性检查。i9-12900HX、Windows 11 22621、NVIDIA 驱动 32.0.15.9579、平衡电源计划。独占 GPU 测量窗口与 Engine 线串行。

进程 working set 峰值 319,254,528 B（304.465 MiB），private 峰值 529,506,304 B（504.977 MiB），采样 1,354 次，句柄最高 578。20–40 秒 private 约 514–524 MB，140–157 秒约 523–529 MB，不能仅凭短窗口宣称无泄漏。逐场景显存估计跨 20 轮无增长：常规 4,539,476 B，tooltip 4,543,180 B；静态零 stage/上传，tooltip 最大每 stage 576 B。

| 场景 | 20 轮 CPU P50 中位 ms | CPU P95 中位 ms | GPU P50 中位 ms |
| --- | ---: | ---: | ---: |
| 初始构建 | 24.207 | 29.198 | 0.0655 |
| 静态重复 | 0.341 | 0.534 | 0.0655 |
| 局部更新 | 14.744 | 19.107 | 0.0655 |
| 全量替换 | 49.118 | 62.049 | 0.0666 |
| resize | 55.983 | 64.328 | 0.0666 |
| 图例 | 11.558 | 14.041 | 0.0645 |
| tooltip | 9.694 | 11.718 | 0.0666 |

同机同脚本交错运行 9/16 留存 Release exe 与当前 exe，两组结果确认有 CPU 成本增长：局部 7.80→12.80、8.64→13.50 ms；图例 4.16→10.40、4.80→11.59 ms；tooltip 4.50→9.03、4.89→9.66 ms。旧 exe 的确切字节 hash 和时间条件已保存，不能从当前工作树反推它的源码 hash。证据目录 `test-output/deep2d-v04-{archive,current}-compare-{a,b}-20260918/`。后来新增坐标轴/图例内容是负载变化，不能以此直接关闭“性能无回退”。当前继续 profile 与同版本等价优化。

恢复复跑：`deep2d-v04-live-recovery-20260918.log` 中产品实窗 5/5；`deep2d-v04-uia-ime-20260918.log` 中产品 UIA/IME 1/1；`deep2d-v04-device-matrix-20260918/matrix_raw.json` 中 Vulkan/DX12 重建分别 36/155 ms，恢复前后及重复帧零差异。上述日志均位于 `test-output/`。

## 成本定位与帧内等价收敛

CPU-only profile 复用上述 8×8192 fixture 和生产 compose/axes/state/legend，每轮重新计数、预热 5 次后取 30 次。复跑入口 `cargo run --release --locked --manifest-path packages/deep-engine-native/Cargo.toml --example chart_text_profile`。TextRasterizer 的计时是显式 opt-in，正常模式不读取时钟。

优化前已有 rlib 的同一字节版本通过独立 thin-LTO 小客户端验证：axes 总 55.66 ms、legend 28.55 ms、state 15.08 ms、geometry clone 0.57 ms；measure 1,170 次/7.62 ms、raster 930 次/8.98 ms、glyph probe 60 次/1.82 ms，三类文本调用约占该组成时间 18.4%。这个 CPU-only 切片不含 GPU stage，也不测数据更新；工业线同期编译，绝对时间不当作最终性能门槛。原始 profile 和 rlib/exe hash 在 `C:/Users/rain/AppData/Local/Temp/deep2d-profile-20260918-50cfb1f43152400fbc1302238c925f89/`。

另查出实际重复：`map_cartesian` 对同轴每个系列重扫同一批 JSON rows；类目/非数值 X 即使不消费数值迭代器，也预先扫描共享 X 值。现以 `FrameAxisValues` 持有单次 frame 的不可变 ChartIR 借用，按轴 ID/通道共享原有顺序的值；该借用生命周期界定 generation，不跨帧缓存。保留原有域求解、zoom、坐标和所有 display-list 验证。保留值预算 4 MiB，超预算只退回不保留，不删除数据或拒绝本来有效的图表。

4 项对拍已通过：多轴/同轴复用、系列顺序反转、类别/数值/zoom、空数据/坏 row/NaN 域拒绝、新源版本隔离、零保留预算等价。当前源码 `--lib --test chart_* --test glyph_cache_tests` 共 37 个 suite、591 通过/6 忽略，严格 clippy 全目标全特性通过。日志为 `test-output/deep2d-v04-axis-regression-20260918.log`。

同版本 RGBA 对拍已通过：`test-output/deep2d-v04-axis-matrix-20260918/same-version-rgba.json` 的 6 个后端/尺寸帧、4 个字体帧及 2 个差异掩膜，共 12 份 RGBA 与本轮优化前矩阵逐字节相同。参考是 `deep2d-v04-device-matrix-20260918`，不是 9/16 历史包；这组覆盖真实 dashboard producer 内容，不代表所有图表数据组合。harness 保留原有 3 条镜像模块 private_interfaces 警告，生产 clippy 无警告。

Release SHA-256：优化前 `24436B561322B5FBB37210D5CEB795EAA780FDC7C9B79DC18B4CCAA7A233DF37`（留存 `deep2d-v04-20260918/pre-axis-cache.exe`），优化后 `01EE6B700D2CDEEEFB6ABE5F99FC1CC02EE92D3F0C29498B0751F44035B8C5D7`。工业构建结束后、Engine producer/截图暂停的独占窗口，交错执行 3 对同版本测试：`test-output/deep2d-v04-axis-{before,after}-{a,b,c}-20260918/`。

| CPU P50 变化 | 对 a | 对 b | 对 c |
| --- | ---: | ---: | ---: |
| 初始构建 | -3.4% | +1.5% | -2.2% |
| 局部更新 | -2.4% | -3.8% | -4.0% |
| 全量替换 | -9.0% | +0.3% | -2.9% |
| resize | -9.8% | +2.9% | -3.2% |
| 图例 | -4.9% | -0.1% | -6.9% |
| tooltip | -10.3% | -1.0% | -11.5% |

局部更新是三对均改善的几何路径；静态帧只有 0.20–0.30 ms，变化落在调度噪声量级。不能把不同轮次的全部差值都归因于此缓存，更不能将其解释为已恢复 9/16 所有 CPU 数值。

优化后另跑 20 轮：`test-output/deep2d-v04-axis-after-20-20260918/`，123.830 秒、4,900 帧/4,200 正式样本、退出 0。OS working 峰值 287,637,504 B，采样 private 峰值 508,780,544 B，1,075 次内存采样；静态零 stage/上传，七场景显存估计跨轮无增长。CPU P50/P95 中位 ms 分别为初始 21.440/24.589、静态 0.327/0.568、局部 13.072/14.408、全量 38.276/41.331、resize 46.731/51.816、图例 10.309/12.146、tooltip 8.727/9.741。

轴缓存切片正确性与当前短时稳定性通过；V-04 的整个“性能无回退”尚未关闭。接下来动态文字清晰度按独立切片验证，不混入这份优化前后样本。
