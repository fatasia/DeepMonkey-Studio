# 主流程发布回归（2026-09-17）

核验 Native 热更新、Dashboard 呈现与正式 API 构建。代码基线为 `47fd6d1`，本轮不关闭完整跨端视觉和设备矩阵任务。

| 检查 | 结果 | 覆盖 |
|---|---|---|
| `cargo test --bin deep-engine-native` | 122 passed / 43 ignored | 包加载、取消、恢复缓存、监听、场景与图表合同 |
| `app::package_live::present_tests -- --ignored --nocapture` | 3 passed | 场景、Shader、完整 renderer 的跳帧保留及呈现后提交 |
| `app::dashboard_gpu_tests -- --ignored --nocapture` | 1 passed | 图表独立数据、跳帧回滚、模拟重试、页面键 |
| `app::package_drop_probe_tests -- --ignored --nocapture` | 1 passed | 目录/包拖放、相机切换、3D→2D→3D 重建及检查点 |
| `pnpm --filter @bim-studio/api build` | passed | TypeScript 生产输出与 Scene/Dashboard compiler bundles |
| `verify-dashboard-production-build.mjs` | passed | 无开发条件导入；三种下载路由已注册且未授权请求返回 401 |

GPU 用例使用 NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan / Windows surface；标准测试中的五项 ignored 在本轮显式执行，其余 38 项未由本报告证明。

生产构建检查的设备指纹使用 64 个零的测试配置；该检查只验证启动接线与鉴权，不执行设备认证、下载成功或 Native 窗口。真实窗口证明来自上面的显式 GPU 用例，二者不混用。

剩余：跨端截图、真实设备丢失、多设备/驱动矩阵、完整发布下载及离线升级回滚验收。以上回归不能据此判定 Deep2D 或 Engine 全部完成。
