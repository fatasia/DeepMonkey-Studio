# Deep2D X 输出 GPU 读回证据

状态：离屏正确性切片已完成；普通窗口接线与产品视觉验收仍为本轮待办。

## 路径与断言

`experimental-x-display-runtime-v6.json` 是已冻结的 TypeScript 作者输出。测试读取并校验整包，经过实际 LPAC 持续 worker、请求/回执哈希、宿主 publish，再交给生产 `Deep2dGpuPainter`。复用现有 GPU 设备、纹理读回和 renderer 模块，无测试专用 shader。

固定夹具三角形顶点为 (10,10)、(80,10)、(45,70)，逻辑尺寸 320×180。独立解析边界公式逐像素核对填充色与背景，排除边缘 1 px 的覆盖规则差异：每个 epoch 核对 1914 个内部像素，RGBA 每通道误差不超过 1/255，外部像素精确保持背景。没有从 GPU 结果反推参考颜色或形状。

同一 worker 连续 epoch 9/10，经初始创建和生产 `stage_update` 后，完整图像逐字节相同。取消下一次求值后，再次绘制已有 painter，读回图像仍逐字节相同。此断言证明旧 painter 可保留，不代表普通窗口的候选发布状态机已经接线。

## 实跑

- NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan，拒绝软件 adapter。
- 两次独立测试进程均通过，每次 2 个成功 epoch 和 1 次取消后的旧帧读回。
- `cargo clippy --test compat_x_display_gpu --offline -- -D warnings` 通过（manifest 见下方命令）。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_display_gpu --offline -- --ignored --test-threads=1 --nocapture
```

## 视觉边界

本片仅新增验证，不改变产品 UI、样式或渲染器。中性颜色夹具用于管线真值比较，不是产品主题。对标仍沿用 Unity 渲染正确性和 FVS 等比画布规范，产品令牌来自 `apps/web/src/styles/base.css`。

`design-taste-digitaltwin` 要求的浏览器双主题/双尺寸截图、实际窗口呈现、交互与十维评分尚未完成；本片没有产品视觉评分。离屏像素证据不计作 Kimi-95 视觉闭环。
