# 静态场景局部坐标

`deep-scene-static-compile-v5` 把远离世界原点的静态场景移到相机附近编译，并将坐标帧保存在 Native 相机资源中。作者快照保持世界坐标。

## 固定规则

- 初始相机目标按每轴 1000 场景单位取整，作为局部原点；默认视角优先。
- 模型、基础体、相机位置与目标统一减原点；对象 ID、旋转、缩放不变。
- 数值往返误差上限为 `1e-6` 场景单位；根位置、相机和合成模型矩阵平移的 Float32 误差上限为 `1e-3`。超限拒绝编译。
- `scene-local-coordinates-v1` profile、原点和资源预算写入编译证据并参与 `compileGraphHash`；原始世界快照仍决定 `sourceSemanticHash`。

相同内容整体平移后，局部几何与相机参数相同；v5 的相机资源还保存不同世界原点，因此运行包 hash 不同。v4 只有编译 sidecar 中的原点，不具备包内世界坐标恢复能力。

## 校验与兼容

Web 预检支持 v4/v5，要求坐标证据与原场景一致。CLI 独立重算原点与编译图 hash，核对局部初始相机、资源预算、未编译字段和源资源排序；v5 还核对相机资源与编译证据中的坐标帧一致。旧 v3 保留原有校验路径，旧版通过不追认新版本精度保证。

## Native 相机坐标帧

相机资源 schema 2 必须包含 `coordinateFrame`，schema 1 禁止新增该字段。坐标帧包含固定 profile 与双精度原点，每轴使用 `% 1000 == 0` 校验网格；不能通过自报 profile 放宽误差。原点、相机局部坐标与资源 hash 一同进入运行包，再由编译图绑定。TS 与 Native 共同拒绝非有限数值、越界精度和未知字段，包括大数除法舍入掩盖非网格原点的反例。

Native `PlayerContent` 保存原始作者相机与坐标帧，提供世界/局部转换边界。当重载前后作者世界相机相同，仅局部原点变化时，用户相机 target 经旧原点还原后转入新原点，保持旋转与距离；超出预算或存在活动剖切时恢复新包初始相机。已有对象 ID 不改变。拾取和测量已接该边界，运行验证范围见下文。

真实 TS 编译夹具：`packages/deep-engine/fixtures/runtime-camera-v2.json` 与 `packages/deep-engine-native/tests/fixtures/runtime-package-camera-v3-coordinates.json`。最终 TS 相机/坐标/runtimePackage 三文件 82 项通过（`test-output/d09-camera-final-v3.log`）；Native runtime 相关 17 项、PlayerContent 4 项、重基夹具身份 1 项通过，另一个 GPU 用例在 CPU 命令中明确忽略（`test-output/d09-native-camera-review.log`）。`cargo check --locked --all-targets` 通过，无警告（`test-output/d09-native-all-target-review.log`）。CLI 矩阵 159 项通过，包含 v3/v4 兼容和 v5 重封 hash 后隐瞒未编译字段的拒绝检查。

实现入口：`apps/web/src/delivery/sceneLocalCoordinates.ts`、`compileSceneRuntimePackage.ts`、`compileSceneRenderPacket.ts`；归档校验入口：`scripts/lib/sceneClientArchiveNative.mjs`。

## 实跑证据

2026-09-15：编译、资源、源身份、兼容及局部坐标 66 项测试通过，Web 类型检查通过；CLI 与启动器 115 项通过。

`verify-scene-runtime-interop.mjs` 对 Primitives、Box、BoxTextured 各增加十亿单位偏移对照，6 个实际 Native headless 检查通过。近远场景的相机、完整绘制 payload 和对象映射相等，源输入不变；来源 SHA 和坏包拒绝检查保持。报告：`test-output/deep2d/scene-interop/a401451f-4f82-4a9f-ad1d-faef922b1ae2/report.json`。这是 headless 证据。后续 `56fa5958-ff27-4249-8dbb-3cf75e24b6e3/report.json` 的 `--gpu` 运行同样含6个case，但仅3个近原点样本有实际 GPU smoke 结果，3个Large字段为null；不能把case总数计作GPU通过数。近远payload等价单独作为数值对照。

独立完整服务验证另有 BoxTextured 十亿单位场景的正常窗口证据：Vulkan 1200×800、3帧Presented、GPU clean，报告 `test-output/native-service-real-report.json`。该记录包括冻结资源、真实编译、窗口复核和候选租约，不代替其他大坐标样本的GPU实跑。

### v5 六个真实 GPU 样本

最终 v5 报告 `test-output/deep2d/scene-interop/07f43a8d-5707-4611-bf5e-1019364ad797/report.json` 的 Primitives、Box、BoxTextured 及各自十亿单位偏移样本，六项均有非空 GPU 输出：RTX 4060 Laptop、Vulkan、64×64 smoke Presented、scopes/callbacks clean。它们不是正常尺寸视觉截图。对应六项 headless 报告为 `8f334bcf-8802-40d4-87e9-54c0cdabcc8a/report.json`。两次使用固定 EXE SHA `3d75c506006d6c9994ed640ea499a5e28492e62421c1ef81de014f411baa351d`、编译 bundle SHA `878174554f5cf6d10d2bf9843ef46b250123b4f891843c1bef518a3fb95d5be5`。这批记录补齐旧 v4 报告 Large GPU 为 null 的缺口，不覆盖或改写旧记录。

### 跨原点重载与失败候选回退

`scripts/generate-coordinate-origin-fixtures.mts` 使用真实 v5 compiler 生成非空 box，再将同一场景的根实例和相机重基 1000 场景单位，重算资源和包 hash。输出 `runtime-package-coordinate-origin-a.json`、`runtime-package-coordinate-origin-b.json`；原点分别为 `(1e9,1e9,1e9)`、`(1e9+1000,1e9,1e9)`，对象 ID、几何和材质身份相同，世界位置不变。

真实 GPU 用例位于 `renderer/coordinate_frame_gpu_tests.rs`。使用普通 winit 窗口和生产 `Renderer::new_candidate`，先执行离屏候选验证，再 activate surface 并实际 present；用户 yaw/pitch/distance 保持，target 经世界坐标重基。失败候选通过零尺寸触发真实 `verify_candidate_frame` 拒绝，当前 renderer 保留并再次 present。未改主渲染器或替换 GPU/进程。

在首次执行前固定验收阈值：640×480、RGBA16F HDR 纹理中发生逐字节变化的像素占比 ≤1%，总亮度相对差 ≤0.1%，失败回退图像必须逐字节相同。不是系统截图或完整视觉质量评分。

2026-09-16 实测 RTX 4060 Laptop / Vulkan：旧场景、新原点场景、失败候选后的旧场景均实际呈现；HDR 变化像素占比 **0.3974609375%**，总亮度相对差 **0.00101685605%**，失败回退 **0 个变化像素**，GPU scopes/callbacks clean。日志 `test-output/d09-coordinate-frame-gpu.log`。阈值未按结果调整；该结果限于固定 box、1000 单位重基、当前相机与渲染配置。

```powershell
cargo test --locked --bin deep-engine-native renderer::coordinate_frame_gpu_tests::origin_reload_preserves_presented_scene_and_failed_candidate_keeps_frame -- --exact --ignored --nocapture
```

以上命令在 `packages/deep-engine-native` 执行，需要先协调其他任务释放 GPU。

## 剩余范围

D09 尚未全部完成：几何变换的保守输入检查见下节；跨原点重载已有 CPU 与固定样本 GPU 回归，拾取与测量的世界坐标回写已接线；连续运动、法线与独立阴影容差仍需实测，持久化标注保留旧局部坐标合同。当前不会恢复资产编码时已丢失的精度。正式 Native 发布仍需对应产物的真实窗口证据，不能仅凭上述测试放行。

## 几何变换精度阻断

新增 `sceneGeometryPrecision.ts`，接入 `compileSceneRenderPacket.ts` 和 `sceneSnapshotRenderPacket.ts`。在 M64 合成矩阵写成 Float32Array 前，按实际索引顶点统计每轴最大绝对值，使用一次编译内的 WeakMap 缓存几何对象，避免每个实例重复扫描顶点；相同 ID 的不同几何对象不共享缓存。声明的 accessor min/max 不作为验证依据。

每行上界由两部分组成：矩阵系数量化差乘顶点范围（含平移项），加上 `γ7 × Σ|M32项|` 的非 FMA 四乘三加舍入上界，其中 `γ7=7u/(1−7u)`、`u=2^-24`。非 FMA 上界同时保守覆盖 FMA；另计 subnormal 输入被 flush-to-zero 的可能损失和中间结果绝对下溢项。绝对项和溢出或总上界超过既有 `maxFloat32CoordinateError=0.001` 场景单位时拒绝，错误含对象、几何、矩阵行和修正建议。

这不是实际误差测量。保守界可能拒绝某些本来精确的大整数操作，例如 1e8 顶点乘单位矩阵；文案为“无法在当前局部坐标精度预算内验证”，不宣称实际误差必然等于上界。也不机械限制源顶点大小：1e8 顶点缩小 1e-8 后可通过。GLB POSITION 已编码为 FLOAT 的源精度损失不能恢复，本片只比较该源顶点在 M64 参考变换和目标 Float32 运算之间的误差。

几何检查沿用既定坐标 profile；相机坐标帧入包已将 recipe 升至 v5。CLI 不能从量化后的矩阵恢复 M64 差异，该部分依靠可信编译执行与其来源记录，不因旧包结构验证通过就追认此检查。法线逆转置、相机投影、拾取、测量、阴影与完整 GPU 可视误差不在这个上界内。

验证：Web 四个 focused 文件 51 项通过，日志 `test-output/d09-geometry-precision.log`；Web typecheck 退出 0，日志 `test-output/d09-geometry-precision-typecheck.log`。包括真实 GLB 内部 1e8 顶点加缩放、1e6 顶点加旋转、巨大基础体阻断，以及普通 GLB/基础体、共享几何缓存、同 ID 不同内容、实际索引和 subnormal 反例。本片未运行 GPU。

## 世界拾取与测量（2026-09-16 收尾）

`player_picking::pick_world` 复用既有三角拾取，将命中局部点经 `PlayerContent.local_to_world` 转为 f64；`app/selection` 将该世界点交给双点测量。渲染聚焦、selected_point 和旧标注继续使用局部点，未更改标注文档合同。无命中、剖切或坐标转换失败时清除选择和测量；重置视图恢复包内作者相机。

实现前固定：拾取逐轴世界误差 ≤0.001，世界/局部往返 ≤1e-6，双点距离误差 ≤0.004 场景单位（覆盖两端逐轴误差传播）。真实 origin-a/b 包的已知 box 面点，横竖尺寸投影→拾取→测量及跨帧两点对照，最大逐轴误差 0.000000238419、往返 0、距离误差 0.000000408885，未放宽阈值。

Native bin 84 通过 / 28 显式GPU忽略，all-target check通过；日志 `test-output/d09-world-tools-bin.log`、`d09-world-tools-check.log`、`d09-world-tools-errors.log`。原 selection probe 实际窗口事件点击、聚焦、双点测量、空白清除及64×64呈现通过，日志 `test-output/d09-world-tools-selection-gpu.log`，EXE SHA `988e73c3c2a2df624039f40c134667bb628f643b98164c4bc4f298bd0cc0a63e`。该既有probe只接受无坐标帧packet；origin-a/b工具和reset本次仅CPU证据，不扩大为带帧包真实输入验收。

### 00:45 续跑：带帧包窗口探针

新增 `--smoke-package-selection <runtime-package.json>`，直接复用严格 package loader，不使用自动 LKG 回退；缺参、多参、不存在和 packet 冒充包在窗口创建前拒绝。旧 `--smoke-selection` 的默认 packet 路径保持。

origin-a/b 两个独立包及 legacy 三次 64×64 GPU smoke 通过。探针将合成 Cursor/Mouse/IME 事件送入实际窗口 handler，跨提交帧检查选中/聚焦、世界测量、空白清除、作者相机 reset，以及旧局部标注保存恢复。它不等于真实 OS 输入、同进程连续重基点或正式发布窗口验收。

最终报告分开记录工具 `actualDistance` 与参考 `expectedDistance`：A 实际距离 0.11901376068130892，B 为 0.11905884074703188，跨原点实际距离差 0.00004508006572295775；逐轴点差 0.00004863739013671875。固定距离 0.004、逐轴 0.001 预算未放宽。初版仅打印参考距离的问题经独立审查修正后重新构建并重跑三组，最终日志为准。

报告 `test-output/d09-package-selection-report.json`，EXE SHA `b4555b2017042717c44ef617cacd106db5210bebe67b410b1ce81e0f5c86571e`；日志 `d09-package-selection-a.log`、`-b.log`、`-legacy.log`。最终 Native bin 85 通过 / 28 GPU 显式忽略，build/all-target 通过，日志同前缀 `-bin.log`、`-build.log`、`-check.log`。持久化标注仍为局部坐标；连续运动、法线与独立阴影容差继续待验。
