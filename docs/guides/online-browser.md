# 在线体验

[打开 DeepMonkey Studio](https://fatasia.github.io/DeepMonkey-Studio/)，直接进入 SMT 产线编辑器，无需登录或安装。

- 旋转、缩放、选择对象，编辑场景、二维页面和脚本；保存后刷新继续编辑。
- 在「场景管理 → 资源」搜索、预览和导入 275 项模型、HDRI 和 PBR 素材；二维资源和看板模板沿用内置库。
- 在「数据」查看 30 行设备遥测示例；这些数据用于演示，不代表现场设备状态。
- [系统介绍与功能视频](https://fatasia.github.io/DeepMonkey-Studio/video.html)支持在线播放、中文字幕和下载。

工程和导入的素材保存在当前浏览器的 IndexedDB。其他浏览器不会共享这些编辑；清除站点数据会删除本地工程。工业格式转换、服务端数据流程、外部数据库和 Agent 使用 [Windows 编辑器或 Docker](https://github.com/fatasia/DeepMonkey-Studio/releases/tag/v0.2.0)。

## 素材容量

Pages 展开后的站点上限是 1 GB，月流量软上限 100 GB。[GitHub 官方限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)。本次选取 259 个模型、5 个 HDRI 和 11 个 PBR 材质，资源约 636 MiB，给编辑器、只读示例和视频预留空间。

完整素材库压缩后约 4.59 GB，分卷在 [素材库 Release](https://github.com/fatasia/DeepMonkey-Studio/releases/tag/asset-library-v1)。需要全库在线访问时，资源应由支持 HTTPS、CORS 和缓存的对象存储托管；目录、搜索和预览仍复用现有素材库。素材的来源、许可证及使用范围保留在每项详情中。

## 自己部署

浏览器体验复用完整 Web 编辑器和既有本地工作台存储。只有包含 `studio-pages-workspace` 标记的页面启用此模式；普通 Web、Windows 和 Docker 入口继续使用原来的 API。

```sh
node scripts/prepare-full-editor-pages.mjs test-output/editor-pages - /DeepMonkey-Studio/ test-output/pages-demo
```

`pages-demo` 包含经哈希验证的冻结场景、素材、数据及 `workspace.json`。输出目录包含完整编辑器、`404.html`、`.nojekyll` 和托管清单。Pages workflow 从 v0.2.0 Release 下载前端、只读样例、视频和字幕，核对 `SHA256SUMS.txt` 后部署，并检查展开后的总大小。

需要多用户共享工程或服务端能力时，改用 [独立 API 托管](full-editor-hosting.md)。静态只读交付仍复用 SceneViewer 构建链，入口为 `scripts/prepare-pages-scene-viewer.mjs`。
