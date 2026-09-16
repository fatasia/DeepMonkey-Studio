# Dashboard 组合运行时 C1

本切片为 Native Dashboard 提供版本化的多页、多图表与静态二维组合运行时。正式发布入口、文字图片编译及资源冻结按 [C2～C5](codex-dashboard-delivery-slices-2026-09-16.md) 继续。

提交范围是 C1 的包合同与 Native 宿主。Web prewarm 尚未完成：当前适配器仍拒绝 chart/dashboard 资源，预热计划依赖未独立提交的作者 LOD 驻留合同。该接线继续保留为本批次剩余项，不因 Native 通过关闭 C1 全项。

## 合同与行为

- 新增 Runtime Package v5，旧 v1～v4 合同和 golden 保留。页面、节点、资源、内部 ChartIR 身份分别校验；跨页复用资源、坏 hash、预算越界及 sim 串图表拒绝。
- 页面包含局部坐标的静态内容和独立图表，按 zOrder、节点身份确定顺序。clip 是节点局部裁剪；frame 不隐式截断阴影。绘制与命中使用相同页面变换。
- Native 同页图表独立更新、选择、缩放和回放。PageUp/PageDown 换页，Home 重置当前页缩放；换页清理 hover，保留图表数据。
- 整页 GPU 成功呈现后提交 CPU 状态和仿真游标；跳过、失败或恢复时保留原候选前状态。失去 surface 触发既有 renderer 重建，计时失败退避 100ms，积压逐帧以至少 10ms 推进。
- Composite 保留已有 atlas tint、opacity、UV 和绘制顺序。命名空间隔离各组件资源，累计预算在追加几何前检查。

## 验证记录

TS 合同从 `05526e3` 基础隔离导出，14 文件、259 测试与核心/Lab 类型检查通过。C1 提交不混入尚未独立提交的 prewarm、HDR、LOD 或形变扩展。

54 个产品源码文件的暂存态与独立导出逐一归一化比对一致；独立 Native all-targets check 通过。缓存修复后重新执行三项 GPU 测试通过，仓库治理门禁通过。

真实 GPU（RTX 4060 Laptop / Vulkan）三项通过：双图表像素更新隔离及换页恢复、旧 atlas tint/clip、真实 Windows 窗口的整页提交与跳过回滚。窗口测试还注入 Recover 返回值并检查真实 renderer 重建；不等同于物理设备拔除测试。

图像来自生产 painter 纹理读回，已检查更新前后和换页输出。golden 是已有图表/atlas 合同压力夹具，包含重叠系列和测试色块，用于验证数据与绘制语义，不是最终 Dashboard 视觉样板。完整浏览器、系统截图和 V-02 视觉矩阵仍待。

Native 全量 987 项通过、63 项忽略，严格 Clippy 与格式检查通过。逐层清理缓存造成组件间缓存互相驱逐的问题已修复，6 项组合回归覆盖热缓存、单层变更、层移除和第二层失败保持。包级体量门禁无阻断；原有 10 项 legacy 提示继续保留。C1 的 Web prewarm 剩余项不因这些结果关闭。

## 本地复现

```powershell
cargo test --locked --manifest-path packages/deep-engine-native/Cargo.toml
cargo test --locked --manifest-path packages/deep-engine-native/Cargo.toml --bin deep-engine-native dashboard -- --ignored --nocapture
```

运行包为 `packages/deep-engine/fixtures/dashboard-composition-v1.json`，由 `scripts/generateDashboardCompositionGolden.mjs` 调用正式 producer 生成；生成器路径相对 `packages/deep-engine/`。GPU 原始读回与日志保留在忽略的 `test-output/dashboard-c1-*`，不提交。
