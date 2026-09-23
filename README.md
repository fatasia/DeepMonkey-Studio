# Deep Monkey Studio

[简体中文](README.md) · [English](README.en.md)

[![Deep Engine](https://github.com/fatasia/bim-studio/actions/workflows/deep-engine.yml/badge.svg)](https://github.com/fatasia/bim-studio/actions/workflows/deep-engine.yml)
[![Studio (web + api)](https://github.com/fatasia/bim-studio/actions/workflows/studio.yml/badge.svg)](https://github.com/fatasia/bim-studio/actions/workflows/studio.yml)
[![Repository governance](https://github.com/fatasia/bim-studio/actions/workflows/repository-governance.yml/badge.svg)](https://github.com/fatasia/bim-studio/actions/workflows/repository-governance.yml)
[![License: MIT with Ethical Restrictions](https://img.shields.io/badge/license-MIT%20with%20Ethical%20Restrictions-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Windows%20%7C%20Android-4c8ddc)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![Rust](https://img.shields.io/badge/Rust-stable-dea584)
![React](https://img.shields.io/badge/React-19-61dafb)
![Three.js](https://img.shields.io/badge/Three.js-0.185-black)
![WebGPU](https://img.shields.io/badge/WebGPU-ready-9c5bd1)

vibe world，面向AI&元宇宙的图形底座

P0：统一 Agent Tool Registry、任务 DAG、执行回执、场景截图和验证接口；P0：先支持文本生成工业场景、预制体布局、灯光和交互；P0：加入“渲染后自动检查，不合格就修正”的有限循环；P1：接入图片参考、素材检索和风格参数；P1：扩展到数字孪生、仿真、运维和看板；P2：再考虑多 Agent 分工和长时间自主构建。

[文档](docs/README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [支持](SUPPORT.md)

![Deep Monkey Studio 平台总体架构](apps/web/public/docs-assets/generated/platform-architecture-gold.png)

## 功能亮点

- **模型导入**：RVT、IFC、STEP、DWG、DXF、glTF/GLB、FBX。IFC 与 glTF 由浏览器直接加载，STEP 用内置 WASM 转换，RVT 走 Revit Worker、DWG 走 LibreDWG 在服务端转换。明细见[转换插件与格式支持](docs/converter-plugin-and-format-support.md)。
- **场景编辑**：构件树、测量、剖切、爆炸图、漫游、相机动画、光照天气与后处理；场景可保存、复制，并发布为稳定快照。
- **数据与看板**：原生支持 MQTT、Kafka、OPC UA、Modbus、S7、BACnet 等工业协议和常见数据库；ECharts 看板、实时视频、事件脚本可直接驱动场景。
- **视觉 AI**：上传 ONNX 模型（含 YOLOv5–v11）即可做图片质检和实时视频识别，告警联动三维场景高亮定位；Windows 下支持 DirectML GPU 推理。
- **AI 助手**：基于真实构件元数据的 BIM 问答、只读 SQL、自然语言生成看板，兼容 Responses 与 Chat Completions 两种 API。

完整清单见[功能清单](docs/capabilities.md)。

## 完整功能列表

按子系统分组，与[功能清单](docs/capabilities.md)和[文档中心](apps/web/src/docs/getting-started.md)一一对应，只列已落地并经验收的能力。

### 3D 编辑器

- 构件树递归展开、显隐、锁定、透明度、变换与删除；按名称/稳定 ID/属性/楼层/类别检索并定位、隔离。
- 距离、构件最小距离、角度、标高四种测量；剖切盒与 X/Y/Z 轴向、拾取面剖切；径向/垂直/轴向爆炸图。
- 轨道浏览、带碰撞与地面跟随的第一人称漫游、第三人称漫游；六个标准视角；WebXR VR/AR 会话入口。
- 场景动画编辑器（相机轨道与模型关键帧、线性/平滑/曲线插值、循环往返）；模型动画播放；标签标记随场景保存。
- 楼层整层显隐与楼层分解视图；BVH 三角形硬碰撞检测；RVT 空间树（房间/MEP Space）与结构化 BIM 属性面板。
- 环境控制（晴/雨/雪、天空盒、网格、背景）；方向光/环境光/半球光/点光/聚光/矩形区域光；后处理（SMAA、FXAA、SSAO、GTAO、Bloom、选中轮廓、景深、暗角、胶片颗粒、残像）与 HDR/EXR 环境贴图。
- `/optimizer` 浏览器本地模型优化：减面、Draco、贴图压缩、顶点色与彩色 Web 光照贴图烘焙（AO、软阴影、间接反弹、降噪，Worker 内可取消）。

### 2D 看板

- 数据中心原生管理 HTTP、WebSocket、MQTT、AMQP、Kafka、CoAP、PostgreSQL、MySQL、Oracle、TDengine、OPC UA、Modbus TCP、BACnet、S7、EtherNet/IP、SNMP、TCP、UDP 与串口连接。
- ECharts + GridStack 看板：数值、仪表、趋势、面积、柱状、饼图、表格、状态、图片、本地视频、实时监控、网页组件；RTSP/RTMP/SRT 自动转为 HLS/WebRTC 播放。
- 模型、图层、BIM 构件与看板组件共用可信事件脚本，可直接访问 Three.js、ViewerEngine 与运行时对象；支持手填数据键与自动补全。

### Deep WebGPU 引擎

- TypeScript WebGPU 内核 + Rust `wgpu` 原生执行器（`packages/deep-engine`、`packages/deep-engine-native`）；Studio 以 Three.js WebGL 为作者基线，Deep WebGPU 为可切换后端。
- 渲染、glTF、几何、纹理、灯光、阴影、后处理与运行包子入口见 [Deep Engine SDK](apps/web/src/docs/deep-engine-sdk.md)；性能基准与对拍数据见 [引擎基准](apps/web/src/docs/engine-benchmarks.md)。

### Native Windows 运行时

- Windows 桌面客户端（WebView2）：源码开发要求 Rust stable 与 MSVC Build Tools；已安装客户端本地工作台不要求 Node/Python/PostgreSQL/MinIO。
- Native 播放器运行包与质量档（GPU 资源创建前裁决 Bloom 预算上限，`native-player-report` 回执实际档位）。
- Linux 服务器支持 Web/API/Deploy 目标；Android 场景 APK 发布(发布页一键打包/签名/下载)与 Rust wasm 第三渲染方案已于 2026-09-24 完成首个实测闭环(模拟器 E2E 全通、三方案同机对比、wasm+胶水 211.6KB);平台基线见[原生发布架构分析](docs/specs/原生发布架构分析-2026-09-15.md)。

### 发布与离线包

- 场景发布稳定快照、重新发布与撤回；导出零散 `.scene.json`、含资源 `.bimscene` 与合并可见对象 `.glb`。
- 只读 Scene Viewer 构建目标（`VITE_SCENE_VIEWER_BUILD=true`）；按需打包分 Deep Engine SDK、Scene Viewer、Full Studio 三档，见[按需打包](apps/web/src/docs/on-demand-packaging.md)。
- 生产存储可切 PostgreSQL（元数据）与 MinIO（对象存储），迁移保留原文件可回退；发布与恢复流程见[发布指南](apps/web/src/docs/server-publish.md)。

### 工业格式

- 已落地：RVT（自研 C# Revit Worker + Add-in，原生 GLB/IFC 双链路）、IFC（浏览器 That Open Fragments）、STEP/STP（OCCT WASM，无需 CAD 软件）、DWG（GNU LibreDWG→DXF 线框）、DXF、glTF/GLB（含 Draco）、FBX。
- 规划中（设计文档，不等同已支持能力）：JT、X_T（Parasolid 文本格式）等七方向工业格式内置接入，见[七方向三维格式工作计划](docs/specs/industrial-3d-format-work-plan-2026-09-16.md)；实际能力以[格式支持说明](docs/converter-plugin-and-format-support.md)为准。

### SDK

- `@bim-studio/deep-engine` 公开子路径入口：`/app`、`/webgpu`、`/gltf`、`/geometry`、`/textures`、`/runtime-package`、`/host`，源码构建本地归档安装。
- 场景脚本 `studio.*` 宿主 API、平台 HTTP API 参考与示例：[SDK/API 总览](apps/web/src/docs/sdk-api-overview.md)、[API 参考](apps/web/src/docs/api-reference.md)、[SDK 示例](apps/web/src/docs/sdk-examples.md)。

### 文档中心

- 应用内 `/docs` 提供 32 篇离线图文指南，分快速开始、资源与编辑、数据与 AI、工业任务、交付与运维、参与项目六组，中英文可切换。
- 文档中心是唯一文档事实源；GitHub Wiki 镜像由 `pnpm docs:wiki:export` 生成，不单独维护第二套内容。

### 管理端

- `/manager` 管理中心与系统管理页：管理员/编辑者/浏览者三角色、按项目授权、服务健康度、错误/操作审计、AI 配置。
- `/branding` 品牌设置：Logo、应用 Icon、系统名、主题色、默认语言、登录入口、维护模式。

## 快速开始

三步启动：

```bash
git clone https://github.com/fatasia/bim-studio.git
cd bim-studio && pnpm install --frozen-lockfile
pnpm studio start web      # Windows / Linux：API + Web
```

要求 Node.js 24，pnpm 版本由根目录 `packageManager` 固定。没有 `corepack` 时先执行：

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
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

本项目采用 **MIT License + Ethical Restrictions**（`DMS-MIT-ER-1.0`）：对不受限的个人与企业授予完整 MIT 权利；但实施或共谋严重侵犯人权——强迫劳动、童工、就业歧视、战争罪关联（UNGP/ILO 口径）——的组织不获任何许可，权利自动终止且无治愈期，也不得通过关联公司、承包商等第三方间接使用。

因此本项目是 source-available，不是 OSI 定义的开源许可证（GitHub 许可检测会显示 Other，这是有意取舍）。完整条款以英文 [LICENSE](LICENSE) 为准，中文翻译见 [LICENSE.zh-CN.md](LICENSE.zh-CN.md)（仍在描述前任许可证，待更新），分档说明见 [LICENSING.md](LICENSING.md)，第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 鸣谢

感谢所有依赖项目的维护者和贡献者，特别是 [Three.js](https://github.com/mrdoob/three.js)、[Orillusion](https://github.com/Orillusion/orillusion) 和 [Unity](https://github.com/Unity-Technologies)——本项目在渲染、引擎架构和编辑器交互上从它们身上学到了很多。也感谢 [OpenAI](https://github.com/openai) 和[智谱 GLM](https://github.com/zai-org) 活动期间提供的 Token 支持。
