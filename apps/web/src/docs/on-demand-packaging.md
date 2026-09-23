# 按需打包

按需打包把同一套场景合同和运行包按用户角色分成 Deep Engine SDK、Scene Viewer 和 Full Studio 三档。它不复制引擎能力，也不改变发布格式；先完成核心能力和 V5 全量验证，再进入产物优化阶段。

## Deep Engine SDK

SDK 通过公开子入口提供渲染、glTF、几何、纹理、灯光、后处理、运行包和宿主 facade。它不加载 React、ECharts、Monaco、工业转换器或 Studio 页面。集成方可以在自己的 Web 应用中按需导入 `@bim-studio/deep-engine/app`、`/webgpu`、`/gltf`、`/runtime-package` 和 `/host`。

## Scene Viewer

Scene Viewer 是已存在的只读发布场景构建目标，使用 `VITE_SCENE_VIEWER_BUILD=true` 和 `pnpm --filter @bim-studio/web build:scene-viewer`。它保留场景加载、相机、选择、媒体、告警和必要交互，不包含项目管理、脚本编辑、资源上传、属性编辑和 AI 工作台。客户打开 Viewer URL 或静态发布目录即可查看场景。

## Full Studio（当前项目）

Full Studio 就是当前项目启动后的完整编辑器，保留 2D 看板、3D 属性面板、脚本、资源、工业格式、数据接入、AI 和发布能力，继续使用 `pnpm studio start web`。不新增第二套 Studio 实现，也不为了追求小包体删除工作流能力。

## 使用边界

SDK 适合引擎集成方，Viewer 适合现场查看和客户交付，Full Studio 适合创作与运维。三档共享场景合同、资源哈希、发布清单和能力回执；第三方许可证、SBOM 和资源目录按档位分别审计。Docker 镜像延后到核心功能、全量测试和发布验证完成后按单独指令制作。
