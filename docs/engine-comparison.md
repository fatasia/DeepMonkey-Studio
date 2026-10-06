# 引擎能力对照(定性)

> 本文是[渲染基准程序](specs/render-benchmark-program-20261007.md)的姊妹篇:**只做定性能力对照,不含任何性能数字**。
> 性能数字一律来自[性能实测](../README.md#性能实测)的同场 fixture 基准(浏览器组)与原生参考表(Deep Native vs Unity,外部计时),不用任何第三方公开跑分。
> 表内均为公开事实;"✗"表示无内置能力,不代表生态不可达成。

## 能力矩阵

| 维度 | DeepMonkey Studio | three.js | Babylon.js | Unity(原生) |
|---|---|---|---|---|
| 运行形态 | 浏览器 WebGPU + WASM + Windows/Android 原生 | 浏览器 | 浏览器 | 原生为主,web 导出 |
| 引擎内核 | 自研(TS WebGPU 内核 + Rust/wgpu 原生执行器) | 社区开源(MIT) | 微软开源(Apache-2.0) | Unity 商业内核 |
| 完整编辑器 | ✅ 2D 看板 / 3D 场景 / 脚本 / 设备拓扑 / 数据中心内置 | ✗(官方仅示例编辑器) | ✗(Playground) | ✅ Unity Editor |
| 工业格式内置离线解析 | ✅ IFC/STEP/IGES/JT/X_T/DWG/OpenUSD/URDF 等,浏览器与本地队列完成 | ✗(依赖 loaders 生态) | 有限(glTF 系为主) | ✗ 需第三方插件(如 Pixyz) |
| 数据连接与语义层 | ✅ 32 类数据连接 + 语义本体 + AI 溯源账本 | ✗ | ✗ | 附加产品线(Unity ArcGIS/Industry 附加) |
| AI 受控执行 | ✅ MCP 工具 + 写入差异确认 + 失败回滚 + 审计 | ✗ | ✗ | Muse(对话式辅助,非受控写执行) |
| 多端交付合同 | ✅ Web / 只读 Viewer / Windows / WASM 同一发布合同 | ✗(自行封装) | ✗(自行封装) | ✅ 平台构建体系 |
| 许可 | DMCSL-1.0(源码可得) | MIT | Apache-2.0 | 商业订阅 |

## 与性能表的关系

- 浏览器四档(three-webgl / three-webgpu / babylon-webgpu / deep-webgpu)在同一 fixture 下同轮实测,见 README「性能实测」;
- 原生参考表(Deep Native vs Unity 2022.3 Windows 构建)按基准程序 P3 采集,独立成表并注明"原生运行时,与浏览器表不可直接对比";
- 本表不承载任何帧率/帧时间数字——跨场景、跨硬件、自报口径的第三方数字不进我们的表。
