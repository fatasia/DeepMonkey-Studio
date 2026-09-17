# Native 全包候选重试复用

全包热更新在非零窗口跳帧时保留一个候选 renderer，100 ms 重试不再反复创建设备、管线和场景资源。只有实际 Presented 才发布内容与检查点。

- `RetryKind::Full` 持有可选候选；新包替换 retry 时释放旧候选，邮箱最终发布守卫继续生效。
- 零尺寸不新建设备；已有候选保留。窗口尺寸变化时丢弃候选并按新尺寸重建，不在旧 swapchain 活动时配置候选窗口。
- 重试同步当前用户视角；`Recover` 丢弃可能失效的候选设备，下轮重建；`Failed` 不发布。

## 验证

Windows / RTX 4060 Laptop / Vulkan：三项 RuntimePackage GPU 测试通过。全包用例覆盖零尺寸下连续两个版本、非零窗口连续两次注入 Skipped、一次注入 Recover，以及随后真实 GPU 呈现。两次 Skipped 的 renderer 代次只增长一次；Recover 后重新增长一次。未呈现时旧 renderer、发布哈希保持不变。

注入验证重试状态机，不等于实机驱动丢失。真实设备丢失、窗口尺寸变化期间的像素对拍和完整视觉验收仍待；本片不改变材质、令牌或画质设置，不宣称视觉完成。

复跑：

```powershell
cargo test --locked --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native app::package_live::present_tests -- --ignored
cargo test --locked --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native
cargo clippy --locked --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native -- -D warnings
```

结果：GPU 3 passed；bin 122 passed / 43 ignored；clippy 通过。上述三项 GPU 是对默认忽略项的显式执行，不将其余忽略项计为通过。

## 已分配候选的版本抢占

补测第二版已有 GPU 候选且两次跳帧后第三版到达：retry 只保留第三版及其新 renderer 身份，发布代次仍为0、旧哈希不变；第三版遇到一次注入 Recover 后重建，最终实际呈现并仅发布第三版。设备代次断言区分复用、抢占和恢复三种分配行为。RTX 4060/Vulkan 三项 GPU 测试及 clippy 再次通过；资源物理释放时机由 Rust 所有权与驱动管理，本测试未测量驱动显存回收延迟。

## 场景、相机和环境联合更新

全包候选现在同时使用坐标系/相机变化与真实预滤波 IBL 夹具，不再只用 builtin 环境。第三版将 specular/diffuse cube 改成黑色辐照，重新签内容哈希与资源修订。跳帧断言活动 GPU 仍使用原环境，最终比较 CPU 完整环境载荷及 GPU 上传源内容身份、名称与修订，证明三种资源随同一代次提交。

三项真实窗口呈现测试通过；另显式执行 `app::package_drop_probe_tests`，复用其环境像素测试：普通与 Shader 材质均有像素变化、亮度下降，回退后像素差为0。该像素证据来自同设备替换路径，不扩大成全包重建设备的逐像素对照。`cargo clippy --bin deep-engine-native --tests -- -D warnings` 通过。
