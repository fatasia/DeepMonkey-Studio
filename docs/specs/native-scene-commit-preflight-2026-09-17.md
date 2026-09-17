# Native 场景提交预检

日期：2026-09-17。状态：已完成独立切片；三维热同步呈现屏障仍待。

## 合同

`SceneResourceDomain.validate_commit` 与 `GpuSceneCache.validate_commit` 只读检查资源修订、设备 epoch、源域数量和驻留预算，不登记身份、不回收缓存、不修改统计。正式 `commit` 始终重新检查，预检成功不是跨异步间隙的提交保证。

拖放候选在渲染验证前调用预检，预算不够的候选无需再执行预览绘制。预览仍不向窗口呈现，原有提交和恢复流程保持不变；本片没有把 RenderPacket、Shader 或完整 renderer 更新改成 Presented 后发布。

预算继续计算活跃旧资源与候选新增资源之和。可释放的弱引用不计驻留；预检不靠先清理这些条目来得到正确结果。复杂度与原提交检查一致，没有新增逐帧扫描。

## 验证

- `cargo test --offline --lib`：310 passed / 1 ignored。
- `scene_resource_domain`：3 项覆盖重复预检无登记、同修订异内容、预检后 epoch 失效、65,536 身份耗尽。
- 显式 `gpu_scene_cache_tests -- --ignored --test-threads=1`：RTX 4060 Laptop / Vulkan，3 项通过；覆盖 1 byte 拒绝、有效候选重复预检、预检后预算变动、256 域耗尽、缓存复用、局部 instance 拷贝与设备恢复。正常候选 636 bytes，释放后 0。
- `origin_reload_preserves_presented_scene_and_failed_candidate_keeps_frame`：真实 640×480 surface 通过；失败候选前后 HDR 读回差异 0。此为既有坐标更新回归，不是新增呈现屏障证据。
- `asset_directory_drop_events_publish_only_validated_frames`：真实 GPU 拖放回归通过，覆盖有效/拒绝候选、相机恢复、3D→2D→3D 分配切换。
- `cargo clippy --offline --bin deep-engine-native --lib -- -D warnings`、格式化与 repository gate 通过。

本片无视觉设计变更。GPU 读回不替代 OS 截图，完整视觉验收未计入本片。
