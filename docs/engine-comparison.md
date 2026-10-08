# 渲染引擎与运行方式

Studio 提供 WebGL 2、Deep WebGPU 与 Deep WASM 运行方式，在三维编辑器的“更多 → 渲染引擎设置”中选择。

| 运行方式 | 使用场景 |
|---|---|
| WebGL 2 | 浏览器兼容、常规编辑与现有 Web 生态 |
| Deep WebGPU | 支持 WebGPU 的设备、大场景与可选高级效果 |
| Deep WASM | 浏览器内运行 Rust 内核 |
| Deep Native | 导出后的原生客户端 |

各后端的材质、灯光、动画、后处理与发布能力以应用文档中心的“渲染能力矩阵”为准。切换前检查当前场景；不支持的能力会显示原因。

开发入口见 [SDK 与 AI 开发](ai-development.md)，运行安装见 [安装指南](registry-install.md)。
