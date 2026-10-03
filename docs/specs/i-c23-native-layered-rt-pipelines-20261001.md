# I-C23 Native RT 分层管线（2026-10-01）

在既有 `fragment_main_rt_layered` 上接 6 个 opaque/MASK 管线变体，让已驻留分层场景消费 RT 生产路径。透明材质仍走既有栅格混合路径。

## 现状核查

1. 全源 layered / RT 检索和 git status：已有层绑定、共享层核、栅格层族；`pipeline/rt.rs` 只有 6 个普通 RT PSO，`draw_rt_batch` 断言无层，readiness 第 5 门直接拒层。未跟踪受保护四项不改，其他并行专线文件不覆盖。
2. contracts / types：PbrMaterial.layered、304B 层行、native textures 12..19、19 sampled textures 能力门均已存在。`RtMeshPipelines` 内部资源合同可扩可选层族，不增加公开材质 ABI。
3. Cargo.toml 固定 wgpu / pollster / serde / bytemuck 已够用，无新增依赖。
4. 消费方：RT 创建唯一产品入口 `renderer/init.rs`，测试入口沿旧创建函数；`renderer/frame.rs` 消费 readiness 与 RT pass，`reestablish_rt_residency` 原样迁移 PSO。增量迁移后若没有层族仍需明确回退，不能让普通绑定吞层。
5. 测试 / 证据：普通 RT 族编译、RT/raster 阴影、降级、恢复测试均已存在；层白炉新腿由本专线修正 oracle，root 串行验证。没有 RT 层绑定 / 层色差 / 层族 readiness 真机证据。
6. I-C23 production/native-consumption/spec、remaining 表、GLM handoff 明列 RT 层族未建；本次仅补该缺口，扩展 lobe 求值仍另列后继。

**已有（不重建）**：RT TLAS 驻留和查询、普通 6 PSO、层 WGSL 包装、层资源、普通 RT 阴影门、恢复迁移。

**真实缺口**：6 层 PSO、RT 材质绑定分支、初始化追加、readiness 对层族存在性的判断与独立 GPU 层证据。

## 实现与锁

- 锁 `pipeline/rt.rs`、`pipeline/mod.rs` 导出、`gpu_scene_draw.rs` 的 RT draw、`renderer/rt_residency.rs` readiness、`renderer/init.rs` RT 创建段、`rt_fallback_gpu_tests.rs` 对层门断言；新增 `rt_layered_gpu_tests.rs`，只在 `rt_pixel_gpu_tests.rs` 增加挂载与同源设备请求参数。公共 WGSL 不改。
- 旧 `create_rt_mesh_pipelines` 保持普通 6 PSO 与签名；新增 with_layered 入口按需追加 6 PSO，普通/层族各自独立 layout / fragment 调用图。
- init 仅包内含活动层且层 layout 就绪时追加；readiness 仅在场景含层但 PSO 未具层族时回退。后续从无层初始场景热切到层且缺族时仍 fail-closed 回退，避免额外常驻 PSO。
- draw 层批次选择 `fragment_main_rt_layered` 并绑定 LayeredGpuMaterial；普通批次维持旧选择。
- 新测试用独立 fixture（沿既有 parity 几何，增加两层颜色/coverage），19 采样能力 + RT 双门。正式 raster/RT pass 逐像素 HDR 对拍，独立普通基材帧证明层改变响应，readiness 必须进入 RT；六层变体创建均在 validation scope 内。

Design Read：Unity PBR 材质响应与西门子工业材质语义；沿既有渲染生产管线，不新增 UI / 令牌。截图视觉闭环尚未通过，不以数值 GPU 门代替产品视觉或完整 I-C23 完成。

## 验证

实现已冻结，`rustfmt --edition 2024 --config skip_children=true` 与 `git diff --check` PASS。GPU/Cargo 仅 root 串行执行，尚未编译 / 实跑。

新门：`cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native rt_layered_material_pipeline_matches_raster_and_consumes_layers -- --ignored --nocapture --test-threads=1`。

回退回归：同 bin 的 `rt_opaque_ready_matches_frame_loop_contract_on_real_objects`，以及既有 RT family / recovery / parity 测试。新层门单次为 1 fresh，root 独立运行两次才记两 fresh。

普通场景初始化仍只建 6 普通 PSO；层场景额外 6。普通创建函数签名保持，集成副本无需机械漂移。未新建 layer 求值 / RT shading 副本。

### root 真机复验

2026-10-01 RTX4060/Vulkan 上，两次独立进程各1 fresh均实际进入ray-query层管线（无soft skip）：6层变体，65536像素，RT/raster最大HDR差0；层相对基材差0.2783203，28919像素改变。日志 `test-output/jc-i-20261001-layered-rt-round{1,2}.log`。bin全测试编译通过；真对象readiness 1测、集成RT/raster阴影2测通过，65536像素100%一致。产品截图、扩展lobe与完整I-C23验收仍未关闭。
