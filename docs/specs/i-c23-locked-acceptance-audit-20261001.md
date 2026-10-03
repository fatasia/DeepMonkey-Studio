# I-C23 原锁定范围收口核查（2026-10-01）

本轮只补原任务行的双端按层纹理验收；编辑器层控件和新的材质瓣留在后继。

## 现状核查

1. 搜索 packages/contracts/src、packages/deep-engine/src、packages/deep-engine-native/src、apps/web/src 的 layered / texture / surface 调用并检查 git status 未跟踪项。两端生产层响应、304B 打包、资源 owner、按层 RGB/MR 和 UV 已存在。Native 现有 GPU 叶分别验证纯色炉、纯色 RT、coat/metal 组合及 1×1 金属颜色 alpha；未找到空间层 RGB+MR/UV0/UV1 的实际回读门。
2. 读取 RenderPacketTypes、Native contract/types、pbr_layered 和 pbr_texture。现有 base+≤2 层 surface 与独立两纹理合同、UV0/UV1 仿射、alpha×coverage、sRGB 颜色/linear MR、304B 参数行均可直接复用；不加协议或 ABI。
3. 检查 package.json / Native Cargo.toml：serde、wgpu、pollster、既有 Vitest 和真实 GPU 回读都已使用；本片不加依赖。
4. 追消费：Web production lab→PbrRenderer，Native GpuScene→扩展 material layout→deep_layer_stack，MR.b 乘 metallic、MR.g 乘 roughness。普通材质 shader 与层 shader 可各自渲染同一表面，构造独立父响应；公共 layered-material-authoring 例已有实际 runtime-package 消费。
5. 查现有 tests、reports、test-output：Web 原两 fresh 已覆盖独立父响应、RGB/MR/UV0+1/alpha；Native 原 G/B 炉偏差已修测试响应域 oracle，两 fresh 完整 65536 像素通过，最大相对误差 0.0583%，原均值 2% / 峰值 8% 不变。正确 dΩ 的 5 层栈×4视角 CPU 炉也已过原 1+1e-3 门。当前 Native 纹理打包金标证明载体，不能替代空间采样实帧。
6. 校准 remaining-tasks-estimates-20260930.md 第108行、i-c23-production-layered-material-20260930.md、Native 消费/炉归因/anisotropy 规格及 handoff。锁定行要求“分层材质响应核接生产 GPU、按层表面色差异/纹理与双端白炉”；Studio 层 UI 不属于原硬门。coat+显式 metal 的已验能力保留，不将未来 transmission/任意 dielectric aniso 加入本行。

**已有（不重建）**：双端实际层响应、Web 空间纹理两 fresh、Native 原白炉两 fresh、正确半球测量、RT层族、304B/纹理生命周期、package 作者消费和快照恢复。

**真实缺口**：Native 空间按层 RGB+MR 与独立 UV 变换的真帧父响应验收。当前判断是证据缺口；若实测失败，再按实际误差定位生产采样。

## 最小候选

仅在 ignored `test-output/i-c23-locked-texture-20261001/` 准备 Native 测试叶与 fixture 叶，各≤300行；父 white_furnace_gpu_tests.rs 只追加模块声明。复用现有 render_material_frame、19纹理 device、HDR回读，不复制 renderer。

两层各用2×2颜色与MR纹理，独立 UV0/UV1、旋转/缩放，固定 alpha128/192。真实普通材质父帧作为响应 oracle，f64 凸混合对照所有像素；保留 0.002 响应误差门。去纹理、错误UV选择、MR G/B交换为独立负控；coverage0 和 alpha0 逐值身份。原白炉仍沿既有 2%/8% 入口，不能由此直接光纹理片外推全参数能量。

GPU 测试已准备，尚无本片实际 GPU 结果。由 root 审核提升、Cargo 编译及两 fresh 实跑；正式源本路未修改。

## 冻结交付

候选 manifest：`test-output/i-c23-locked-texture-20261001/promotion-manifest.json`，SHA256 `6eb74d133c0f54250d32dd1d3ac129ace73ce446ebd01d4470241fe656a2f509`。新 fixture86行、GPU测试157行；父文件只追加模块声明。三源冻结后没有再修改。

CPU实际调用既有 Native rlib 的 validate_packet / prepare_pbr_resources；1/1通过（`cpu.log`），验证完整 JSON 往返、四层纹理索引、sRGB/linear编码、76-f32、普通父材质映射及独立混合算式。harness 提取正式相机墙函数及候选原 CPU 测试体，没有 shader 或生产求值镜像。该次检查使用19:48已构建 rlib；正式同包编译由 root 执行。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native layered_texture_fixture_keeps_real_contract_and_encoding -- --nocapture --test-threads=1
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native layered_texture_production_matches_independent_parents_and_uv_mr_controls -- --ignored --nocapture --test-threads=1
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --bin deep-engine-native white_furnace_layered_stack_matches_cpu_convexity -- --ignored --nocapture --test-threads=1
```

第二条需两个独立 fresh 进程。它验证完整纹理响应与三负控，不取代第三条均匀环境炉。生产是否存在采样缺陷及原行是否关闭，以 root 实帧和原炉结果为准。

## 首帧归因与精度 oracle 修正

root 提升三项后，正式CPU1/1通过；首 GPU 全帧最大父响应差 `.006718745947708271`，原 `.002` 门正确拒绝。独立诊断单层 replace/overlay 都失败、层1两模式均通过，排除 overlay 的 MSAA 协方差假设。最坏 `(128,128)`：父层R `26.046875`，实际混合R `8.421875`，由已存成half的父帧计算却预测 `8.428594`；94个坏点集中在层0高亮峰。

这是父帧先half读回再混合丢失精度的 oracle 问题。新的 test-only observer 在真实 ordinary/layered final return 薄加 hi/lo 输出，保留完整原颜色算式；替换回原返回后整个 WGSL 逐字等同，记录原/观察源SHA。读取未量化实际父响应后，由独立 CPU 混合，再用只含 textureLoad 的 GPU pass 做真实 rgba16float/4x resolve 存储。原 actualHDR16 帧保持，原 `.002` 门不变，独立 rawF32 `.002` 门并行检查；仍比较全65536点和三负控、coverage0/alpha0。

四项 precision 候选已由 root 提升。初版生成器误匹配 CPU synthetic parents 接缝，正式编译失败；独立单叶 amendment 已修为 GPU 函数内唯一接缝，未运行坏 GPU。`test-output/i-c23-locked-texture-precision-fix-20261001/amendment.json` 对实际 `28602acc…` 修改为 `5fa29698504dc2a419fcb0dca2108ee3f2113ff86d913a30737f8fd036bfdf99`，225行。完整新叶 rustc 类型/链接检查和两个实际 CPU 测试通过；GPU ports 仅用于编译的占位，未执行。root 正式同包复验及两 fresh GPU 仍待完成。

root 正式CPU2/2通过后，第一 precision GPU 仍失败。root 从真实 opaque draw 找到 observer 接缝未覆盖 `fragment_normal_capture` 两入口，capture颜色仍返回原值；不是新数学归因。追加单叶 `test-output/i-c23-locked-texture-capture-fix-20261001/amendment.json`：`61def174…`→`8694b648459edbb0848cde33e98a16c6d56fb54af68b4f98aea9e1d43a494c5f`，116行。现守4个实际color表达式，normal/roughness附件原表达式不动；CPU明确检查4入口消费observer与whole-WGSL恢复。新叶真实类型/链接及CPU2/2通过、无警告。当前GPU待root复跑；两个失败和正式编译失败日志均保留。
