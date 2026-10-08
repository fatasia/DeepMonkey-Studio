# Studio WASM 纹理解码预算修复

用户反馈两个 Deep 后端均失败。生产包真实 SMT 场景的 WASM 切换返回 `images[4]: Limit 0 exceeded.`；WebGPU 的 19 个采样纹理槽限制由材质资源布局任务处理。

## 现状核查

1. 已检索 Web viewer/delivery、Deep gltf 解码、纹理预算和未跟踪文件。已有 GLB 图片尺寸读取及按预算降采样，不重建解码器。
2. 已读 CompileSceneRuntimeOptions、CompileSceneRenderOptions、GltfTextureDecodeOptions 与 contracts；`textureBudgetBytes` 已贯穿正式 runtime-package 编译。
3. 依赖沿用现有 Deep/Three/Vitest 与浏览器图片解码，不增加库。
4. WASM worker 和无 worker 分支共同调用 `compileStudioWasmRuntimePackageInProcess`。该入口遗漏纹理预算；WebGPU 作者包入口已有112 MiB预算。GLTF单次解码上限128 MiB，六张源图使剩余额度耗尽。
5. 已读 worker 编译所有权/取消测试、场景纹理预算与交付测试；真实浏览器失败明确发生在图片解码，尚未创建 WASM GPU 后端。
6. 已查引擎切换规格、13:36 handoff 与恢复 ledger。README只读，发布与 Pages 等待 Deep 验收。

已有（不重建）：112 MiB作者纹理预算的尺寸规划、worker图片解码和正式 runtime-package 类型字段。

真实缺口：WASM Studio入口未传预算，直接解码原图后触发128 MiB上限；将已有112 MiB预算传入共同入口，保留核心上限与源身份记录。原图尺寸未超预算时字节不变，超预算才走现有降采样。实际同场景切换结果待新包复测。

已运行 worker 编译所有权和 runtime纹理交付两文件12项测试、完整作者包32项测试，EXIT0。新生产包在真实 SMT 场景已越过图片解码，原 `images[4]: Limit 0 exceeded.` 消失；后续 runtime-package 高级材质准入拒绝由共享 Native/WASM 材质任务补齐，当前尚未成功接管该场景。

## 共享材质入口现状核查

已读现有 `CompileSceneRenderOptions.advancedMaterials`、runtime-package 编译调用和材质准入，以及新 Native/WASM 共享 Rust 消费方。依赖不变；Native 实机 GPU 八项材质目标、TS writer 59 项测试与 WASM 构建已通过，证据见 `test-output/native-material-evidence.json`。已有（不重建）：specular 和透射的正式运行时材质、纹理及 GPU 消费。真实缺口：Studio 未开启现有 advancedMaterials 选项，runtime-package 中间层未转发且仍一律拒绝高级材质。Studio 传入既有选项；中间层仅允许正式 Native writer 已验证的材质，保留尚未实现的分层材质拒绝。真实 SMT 接管仍待复测。

## 保存缩略图现状核查

已检索 presentation帧订阅、缩略图、场景保存与 prefab/机器人消费，读过四项现有生命周期测试及 ViewerEngine 相机字段。合同、依赖均沿用现有 DOM/Three/Vitest，未新增公开类型。规格与上述生产 CPU 证据对齐：Deep 和 Three 的同轨迹拖动都在缩略图 canvas.toBlob 触发长任务，调用异步 API 仍会同步排空GPU工作。

已有（不重建）：真实呈现帧订阅、异步编码、1500 ms超时、后端身份与资源清理。

真实缺口：场景保存和离开编辑器可在鼠标拖动中读取GPU画布。按用户最新要求，取消这些入口的缩略图生成，直接保存作者数据；快照中已有缩略图原样保留。素材库中显式抓取 prefab/机器人图片的入口仍沿用原有工具。

验证：保存、导航和既有显式捕获生命周期三文件30项测试通过；覆盖手动/自动保存不发起GPU捕获、导航携带历史图与作者数据，以及异步恢复存储期间新场景/更新保存的所有权保护。Web类型检查通过，新生产包已构建。README未修改。
