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

## 下载与真实光栅补验

- API 候选服务、运行时、路由、EXE/ZIP、DMDA 字节和 Native 启动计划共 8 文件 65 项通过。包含实际 HTTP 异步下载与客户端断开取消；打包夹具中的 PE 只用于格式验证，不作为实际安装验收。
- `pnpm exec vitest run --config scripts/dashboard-raster.vitest.config.mjs`：21 文件 167 项全部通过。设置 `C2_NATIVE_EXECUTABLE` 为本机 debug 播放器，主字体 `msyh.ttc`，fallback `arial.ttf`，真实 Native 文本生产器参与两项端到端用例，未跳过。
- 覆盖中文与组合符、透明图片、KPI、表格、ChartIR、fractional clip 和 producer receipt；修复背景层加入后 3 个旧测试的索引假设，仍逐项断言裁剪、像素尺寸、作者层序和节点预算。
- Web 类型检查、repository gate 通过。上述使用固定数据/布局夹具，不替代真实作者页面与 Native 窗口的截图对比。

## 页面图像与工业切片合拢复核

背景图编译/系统证据接入后，完整光栅回归24文件181项通过。使用静态CRT r2 Release播放器、微软雅黑主字体和Arial fallback；Native生产器用例未跳过。此检查覆盖输入/编译回归，不等于整页跨宿主截图验收。

JT七个API测试文件27项独立复跑通过（约9秒），包括真实材质路径、共享几何、装配身份和上传产物。CoffeeMaker/ExampleBlock GLB SHA与 `industrial-jt-material-path-2026-09-17.md` 一致；Web源透明度恢复的后续修复未混入这些导入测试结论。

标题HTTP交付r4的ZIP、单EXE、运行包SHA分别与 `dashboard-http-heading-delivery-2026-09-17.md` 一致，抽查 `downloaded-open.json` 的Vulkan3帧和GPU clean。此处是原始产物复核，不宣称再次执行整条HTTP流程。

3DM两份主证据SHA与圆柱/部分圆弧报告一致；Bezier精确截取及拒绝路径2项复跑通过。整件同步器有另一片在途修改，本次未将局部算法回归称作整件重验。
