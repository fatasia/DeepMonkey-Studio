# Deep Monkey Studio

[简体中文](README.md) · [English](README.en.md)

自托管的工业数字孪生平台：导入 BIM/CAD 模型，接入设备实时数据，在浏览器里搭三维场景和数据看板，发布成可访问的应用。内网部署可使用本地资源与服务；外部 AI、视频和数据源按需连接。

[文档](docs/README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [支持](SUPPORT.md)

![Deep Monkey Studio 平台总体架构](apps/web/public/docs-assets/generated/platform-architecture-gold.png)

## 功能亮点

- **模型导入**：RVT、IFC、STEP、DWG、DXF、glTF/GLB、FBX。IFC 与 glTF 由浏览器直接加载，STEP 用内置 WASM 转换，RVT 走 Revit Worker、DWG 走 LibreDWG 在服务端转换。明细见[转换插件与格式支持](docs/converter-plugin-and-format-support.md)。
- **场景编辑**：构件树、测量、剖切、爆炸图、漫游、相机动画、光照天气与后处理；场景可保存、复制，并发布为稳定快照。
- **数据与看板**：原生支持 MQTT、Kafka、OPC UA、Modbus、S7、BACnet 等工业协议和常见数据库；ECharts 看板、实时视频、事件脚本可直接驱动场景。
- **视觉 AI**：上传 ONNX 模型（含 YOLOv5–v11）即可做图片质检和实时视频识别，告警联动三维场景高亮定位；Windows 下支持 DirectML GPU 推理。
- **AI 助手**：基于真实构件元数据的 BIM 问答、只读 SQL、自然语言生成看板，兼容 Responses 与 Chat Completions 两种 API。

完整清单见[功能清单](docs/capabilities.md)。

## 快速开始

要求 Node.js 24，pnpm 版本由根目录 `packageManager` 固定。

```bash
git clone https://github.com/fatasia/bim-studio.git
cd bim-studio
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web      # Windows / Linux：API + Web
pnpm studio start client   # 仅 Windows：再加桌面开发客户端
```

启动后：

- Web：http://localhost:5173（管理中心 `/manager`，品牌设置 `/branding`）
- API：http://localhost:4100，健康检查 `/health`

当前开发环境的管理员账号和密码均为 `admin`。停止、重启、状态、健康检查分别是 `pnpm studio stop / restart / status / check`。首次部署按环境模板配置，已有 `.env` 请保留。生产部署、PostgreSQL/MinIO、HTTPS 与排障见[从零开发与原生部署](docs/native-deployment.md)。

## 文档

- [功能清单](docs/capabilities.md) · [视觉 AI 上手](docs/vision-quickstart.md)
- [从零开发与原生部署](docs/native-deployment.md) · [场景文件格式](docs/scene-format.md)
- [文档索引](docs/README.md)

应用内打开 `/docs` 可阅读离线图文指南；开发者从[开发者上手](docs/development.md)开始。

## Deep Engine

Deep Engine 包含 TypeScript WebGPU 内核和 Rust `wgpu` 原生执行器。Studio 以 Three.js WebGL 为作者基线，Deep WebGPU 已作为可切换后端接入；Deep Native 是独立的发布目标，按场景能力和交付门禁验收。代码见 [WebGPU 内核](packages/deep-engine/README.md)与[原生执行器](packages/deep-engine-native/README.md)，当前范围见[执行计划](docs/specs/deep-engine-execution-plan-2026-09-15.md)。

## 参与贡献

欢迎 Issue 和 Pull Request，提交前请读[贡献指南](CONTRIBUTING.md)。所有合并都要求通过 `pnpm gate:repository` 以及与改动范围相符的测试。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。

## 许可

对于非受限企业与个人为 MIT 协议。但任何企业只要存在许可证所列的劳动、薪酬、个人信息或用户权益问题，即属受限组织，不得以任何方式使用本项目，也不得通过关联公司、承包商等第三方间接使用；公开源码或付费都不构成例外。

因此本项目是 source-available，不是 OSI 意义上的开源许可证。完整条款以英文 [Deep Monkey Community Source License 1.0](LICENSE) 为准，中文说明见 [LICENSE.zh-CN.md](LICENSE.zh-CN.md) 与 [LICENSING.md](LICENSING.md)，第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 鸣谢

感谢所有依赖项目的维护者和贡献者，特别是 [Three.js](https://github.com/mrdoob/three.js)、[Orillusion](https://github.com/Orillusion/orillusion) 和 [Unity](https://github.com/Unity-Technologies)——本项目在渲染、引擎架构和编辑器交互上从它们身上学到了很多。也感谢 [OpenAI](https://github.com/openai) 和[智谱 GLM](https://github.com/zai-org) 活动期间提供的 Token 支持。
