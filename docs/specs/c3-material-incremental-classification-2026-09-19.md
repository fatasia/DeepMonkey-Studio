# C3 材质/纹理增量分类切片（2026-09-19）

状态：**合同切片完成，真实 uniform 原位写入尚未关闭**。

## 已完成

- 新增 `renderer/material_resource_diff.rs`：
  - `Identical`
  - `UniformOnly { changed_indices }`
  - `Structural`
- 纹理槽位、normal-map feature、shader model、alpha mode、double-sided、premultiplied alpha、材质数量变化全部归为 `Structural`，必须回退完整资源 staging。
- 只有数值 uniform 变化才进入 `UniformOnly` 候选。
- 新增 `prepare_material_uniform()` 纯函数：可在不解码纹理的情况下构造材质 uniform payload，为下一切片准备。
- `GpuPbrResources::write_material_uniforms()` 已具备安全 API，但**尚未接入生产 packet 更新路径**。

## 验证

- Native bin 中材质分类测试：2/2 通过。
- `cargo check --all-targets`：通过。
- 生产 C3 路径未被改变，现有 transform-only 快路径保持不变。

## 未关闭项

1. `queue.write_buffer` 写入现有 `GpuMaterial::_uniform` 的真实生产接线；
2. 真实材质数值变更场景的 CPU/GPU 时间对比；
3. 纹理 revision 变化的资源重用/重上传证据；
4. 材质快路径的 Web/Native 确定性和视觉回归。

本切片不宣称材质增量性能收益，避免把合同准备误报成生产快路径。
