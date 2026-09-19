# R6-2 基线首批数字(2026-09-19 深夜,主线程)

场景:BIM 型 5000 实例(2 几何 × 5000 变换实例,`scene_content_key dee4b2b0…`),Native 播放器,`--smoke-telemetry` 6 采样帧(2 预热),release 构建,Windows,RTX 4060 Laptop,**Vulkan 后端**,驱动 595.79。机器当时有并行车道负载(另两 Chrome 实例),数字按首批基线记账,不写最终结论。

## 实测(样本原始值,未修整)

| 通道 | 样本(ms) | 中位 | 判读 |
|---|---|---|---|
| **cpu-submit** | 3.39 / 3.32 / 3.35 / 3.25 / 3.19 / 3.63 | **3.35ms** | 每帧 CPU 提交准备+提交 |
| **frame-interval** | 5.37 / 5.31 / 5.41 / 4.79 / 6.40 | **5.37ms** | 实际帧节奏 |
| gpu frame(timestamp) | p50 394µs / p95 442µs | **0.394ms** | GPU 全帧 |

**CPU 提交占帧间隔 62%——远超 30% 红线,R6-1 热点档被数据正式触发**(此前"GPU 99.6% 空闲"的判断在本场景得到复现:GPU 只用 0.394/5.37 ≈ 7%)。

## 边界与未覆盖(如实)

- 未覆盖通道与原因(遥测合同如实降级,不伪造):scene-update/upload 未独立埋点(`native_scene_update_is_not_isolated_from_resource_preparation` / `native_upload_is_not_timed_as_an_independent_boundary`);present 无合成器完成时间戳。**C3/A 组需要的 prepare 细分(遍历/编码/资源准备)还不能从本报告拆出**——细分埋点是下一步(原估半天,维持)。
- 5000 实例复用 2 个几何(实例化正确形态);六类负载矩阵与 20000 实例档待扩。
- 单场景 × 6 帧;多场景 × 长窗口为后续正式测量。

## 决策含义(按 R6-1 卡阈值)

1. cpu-submit 占比 62% → **热点档合法启动**,候选按 R6-1 路线图(队列串行化/barrier/map 批处理),全部过确定性门禁;
2. R6-2 的 C2(并行 encoder 农场)与 D 组(uniform 竞技场)优先级上调——3.35ms 的主体大概率是 per-instance 编码与绑定创建;
3. GPU 空闲 93% 再次确认 A 组驱逐策略(几何/文字上 GPU)有巨大预算空间。

证据:`test-output/r6-2-cpu-prepare-20260919-r1/`(telemetry-report.json 原始 JSON + 场景包 + packet + 生成脚本 `scripts/fixtures/gen-r62-cpu-prepare-scene.mts`,幂等)。

## r2 细分埋点(2026-09-19 深夜,同一机器,release,Vulkan)

细分埋点已落地(`--smoke-telemetry-prepare`):`CpuSegment` 新增 `packet_scene_update`(纯 CPU 场景准备:分类/校验/遍历/派生/阴影 stage)、`packet_resource_upload`(GPU 资源创建+上传暂存+错误域 pop)、`packet_deep2d_prepare`(文字通道,无 deep2d 场景保持 0 样本);记录点收敛在 `publish_render_packet_update`/`publish_deep2d_update`,采样窗内每帧做一次真实 packet replace(首实例平移 X 交替,内容键必变)。上一批 `native_scene_update_is_not_isolated_from_resource_preparation` / `native_upload_is_not_timed_as_an_independent_boundary` 两个 unavailableReason 由真实埋点取代,窗口无更新时如实降级为 no_*_samples_in_window。

**5000 实例 packet 更新细分(3 run × 6 样本池化,n=18)**:

| 段 | p50 | p95 | 占更新成本 |
|---|---|---|---|
| packet_scene_update(纯 CPU 场景准备) | **149.82ms** | 166.07ms | **88.4%** |
| packet_resource_upload(资源准备/上传) | 19.70ms | 24.05ms | 11.6% |
| 合计(全量 replace 上界) | 169.51ms | — | 100% |

帧路径(稳态,r1 对照):submit 3.32ms 占帧 CPU 4.41ms 的 75.4%,opaque 编码 1.07ms 占 24.2%,GPU 帧 0.394ms(空闲 ~93%)。r2 replay 模式下帧路径段同步采集:opaque 1.52ms、scene_update_resource_preparation 0.194ms(culling/lod 重编码)、submit 4.63ms。

**裁决(限定本场景:无文字管线/无透明/shadow 稳态干净)**:A1/A2 两分法判据都不命中——编码非主导(24%)、资源准备非主导(11.6%),主导项是第三类**全量场景准备**(88.4%),证据指向 C3 摊销重建/B02 脏域增量优先;本场景不给 A1 任何证据(Deep2dPrepare 0 样本),文字管线场景必须另测。GPU-bound 对照(shadow 夹具):GPU shadow 占 GPU 帧 69%、CPU shadow 段同步激活、packet 更新坍缩到 0.58ms——分段正确跟随瓶颈构成。回归:cargo test --lib 422/422;bin 148/148;telemetry 域 9/9(含新段测试)。

证据:`test-output/r6-2-cpu-prepare-20260919-r2/`(evidence.json 裁决文档 + 3×BIM 运行原始报告 + shadow 夹具报告 + build-evidence.mjs)。


## C3 快路径实测(2026-09-19 深夜,r3)

切片一(实例级 diff)+ 切片二(transform-only 快路径)落地后,同一 5000 实例 BIM 场景、同一冒烟驱动(首实例 X 交替,previous 修正为"渲染器当前已应用侧"):

| 通道 | 全量路径(改前) | 快路径(改后) | 收益 |
|---|---|---|---|
| packet_scene_update | 149.8ms | **0ms**(6/6) | 全量 prepare 完全跳过 |
| packet_resource_upload | 19.7ms | **0.019–0.029ms** | ~700×(仅 partial write 受影响行) |
| frame-interval | 187ms | **15–19ms** | 更新帧 >10× |

实现:diff TransformOnly(身份/几何/材质/纹理四重守卫)→ 每受影响行重算词 0..24(模型列主序+逆转置法线)+ 镜像符号词 30,材质词不动;按升序连续段合并 `queue.write_buffer` 整行 144B;奇异性合同与 prepare_scene 一致;阴影保守 `bump_scene()`;发布臂记遥测(scene_update=0,honest)。冒烟驱动的 previous 修正为"渲染器当前已应用侧"(original→original 伪更新会污染测量——教训)。

## Deep2D/A1 夹具补充(2026-09-19)

复用已有 `deep2d_runtime_atlas_v1.json` 增加 `tests/deep2d_prepare_baseline.rs`:
6 次 prepare,热态中位 **0.0348ms**,3 chunks/32 atlas bytes,测试通过。该 fixture 只验证 runtime atlas prepare,不含生产 CJK shaping/rasterization 或图表文字，因此 **A1 MSDF 文字驱逐尚未裁决**；真实 Deep2D/chart fixture 是后续必需,禁止拿 0.0348ms 推翻约 8ms 文字管线地板。证据:`test-output/r6-2-deep2d-prepare-20260919/evidence.json`。

## Deep2D 真实文字 fixture 与 A1 裁决(2026-09-19 深夜,r4)

真实文字工作负载 fixture 已落地:`fixtures/deep2d_runtime_chart_text_v1.json`(638KB 单行 JSON,sha256 `9a4c3784…`,同机重生成字节一致),由生产链路生成:8 系列 × 8192 行 chart(perf 同构)→ Hover 武装真实 tooltip → `present_chart`(cosmic-text shaping + swash 栅格化 → 整段 RGBA atlas base64)→ overlay 文字切片(tooltip+轴标签+图例+状态描边,不含 8192 点折线重几何)。**32 个文字 run / 275,400 解码 atlas 字节 / CJK+ASCII+数字三面齐备**(360 常用汉字池作类目名,y 轴数字刻度入像素;单帧可见 CJK ~16 字是 stride 抽稀的正确行为)。生成可复现:`examples/gen_deep2d_text_fixture.rs` + `scripts/run-deep2d-text-fixture-bench.ps1`。

**实测(release、单线程、纯 CPU,不含 GPU 上传/present;预实验一轮因首次执行 OS 分页污染被丢弃,认定轮四处独立测量互差 ≤9%)**:

| 通道 | 中位 | 判读 |
|---|---|---|
| 文字 fixture prepare(热) | **1.203ms**(冷 1.32) | 主体 = 275KB atlas base64 解码 + validate + quad 化 |
| 文字 fixture prepare + path cache | 1.131ms | 缓存无收益(路径只占 24 条,非瓶颈) |
| atlas-only 对照(同协议) | 0.008ms | 文字工作负载 ≈ 150× atlas-only;0.0348ms 旧值量级一致 |
| 活体 8×8192 文字变更帧:present(宿主 compose) | **5.30ms**(tooltip 1.74/axes 2.34/state 0.61/legend 1.01) | 其中 shaping 0.78ms(96 调用/帧)+ swash raster 0.97ms,余为装箱/ControlCanvas 路径/encode |
| 活体:Deep2D prepare 文字切片 | 1.23ms | 与 fixture prepare 1.20ms 互证 |
| 活体:全帧 prepare(含 8×8191 段折线细分) | 14.95ms | 全帧口径下几何细分主导,文字切片仅 8% |

**A1 裁决(判据灰区,按实测分段落款)**:真实文字 CPU prepare = **1.20ms**,落在「≥2ms 确认 / <1ms 修正」两阈值之间——**prepare 不是 8ms 的主体,原「MSDF 可把 8ms 直接归零」的量级推断不成立**。8ms 分解:宿主 compose ≈5.30 + Deep2D prepare ≈1.23 + perf 环境 stage/编码边界外 ≈1.4(机器差异内)。A1 MSDF 直接消除 swash 逐帧栅格化(~0.97ms)与整段 RGBA atlas 字节链(encode/decode/上传),估计收益 **~2-3ms/帧(25-35%)**;shaping/measure(0.78ms)与面板/轴/图例路径装箱(~3.5ms)不被 A1 消除——「文字 8ms→0.05ms GPU」应修正为「文字链 CPU ≈8ms → ≈5ms(A1 单独)」,逼近 0 需叠加 shaping 缓存与 compose 增量化(R2/R3/C3 类)。另:文字变更帧 vs 静态帧 present 中位差 <0.35ms——当前管线每帧无条件 re-measure/re-raster,文字内容变化本身不构成主要增量,过度失效的大头不在文字。

回归:deep2d×25 + chart 文字/图例/tooltip/轴 ×6 套件 release 全绿(33 二进制 147 用例),`cargo test --lib` 429/429;常规件 `deep2d_text_fixture_prepares_with_real_text_volume` debug/release 双过(断言真实栅格像素非零、image quads≥24)。证据:`test-output/r6-2-deep2d-text-fixture-20260919-r1/`(evidence.json + bench-output.txt 原始 JSON 行 + fixture-generation.json + sha256)。
