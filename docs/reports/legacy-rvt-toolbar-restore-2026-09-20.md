# 历史 RVT 与场景工具栏恢复

## 已完成

- 历史 RVT 插件：既有 Revit Add-in 仍安装，配置指向的 Worker 发布目录缺失。使用现有源码执行 `dotnet publish`，复用已安装的 2026 Add-in，无新增依赖、证书或数据库配置变更。
- 使用本地 `BIMFACE示例模型.rvt` 执行 `native-glb` 转换，Worker 返回成功。输出保留在 `test-output/legacy-rvt-restore-20260920/`：geometry.glb 10,145,352 字节、hierarchy.json 75,842 字节、properties.json 2,807,656 字节及压缩副本。样本及输出未提交。
- `pnpm studio restart web --no-open` 成功；API、Web 及配套服务健康。认证访问 `/api/converters` 返回 `bim.revit-native.available=true`、provider 状态 `detected`。
- 工具栏偏移根因：方向立方体的 1000px 容器查询覆盖了工具栏的居中布局。移除此跨组件覆盖，窄画布将方向快捷按钮置于立方体下方，继续复用既有工具栏断点。
- 聚焦测试 `SceneToolDock.test.tsx`：2/2 通过；改动文件 `git diff --check` 通过。

## 浏览器复验

两轮截图复验涵盖 1280×900、980×800、1920×1080。对应画布宽 728、470、1368px，工具栏与画布中心误差分别小于 0.001、0.001、0.001px。980px 下创建菜单展开正常、未裁切，Escape 可关闭。未修改或保存场景数据。

按 digitaltwin 技能，以西门子工业工作区的对齐与信息密度为本次局部修复标准，不新增颜色令牌。十维检查：布局 9、令牌 9、排版 9、交互状态 9、动效不适用、3D 画质不适用、信息设计 9、反馈 9、响应式与主题部分验证（深色三档已测，浅色未测）、语义 9。这是局部定位复验，不代表全站视觉验收通过。

## 项目级后验收

历史插件保留独立 Revit 运行依赖，不计入 builtin-only RVT 能力；本次只验证固定样本原生转换与 API 可用状态，未覆盖所有 Revit 版本及 UI 上传到发布的全链路。全量 Web、浅色主题与全站视觉回归后置。未 push。

## 2026-09-20 网格与场景客户端打包复验

- 三维网格改为整数 texel 间距与近距离 nearest 放大采样，远距离仍保留 mipmap 抗闪烁；Three 与 Deep 网格合同同步。普通视角、近距离放大两轮浏览器截图中，主/次网格边界清晰，无原先的线宽扩散。
- `666666` 的 Deep Native 真实候选从 14 项阻断收敛为 `ready`。本机 Native 窗口证据覆盖 runtime、primitive、camera、solid environment 与 directional light；默认无效字段不再误报，studio 环境与光照进入 v13 运行包。
- Three WebView 发布改为直接生成 Windows EXE。用版本 1 原始归档调用产品接口，返回 `application/vnd.microsoft.portable-executable`，32,958,976 字节，PE 头 `MZ`；产物复制到 `D:/Download/666666.three-webview.exe`。
- 启动器健康检查窗口由 60 秒改为默认 180 秒，覆盖 Windows 冷缓存下 Native/工业 Worker release 编译，避免 API 即将就绪时回收 MinIO 与整个运行环境。

聚焦验证：Web 8 files / 95 tests、Native 归档 90/90、启动器 6/6、Web/API typecheck 通过；`pnpm studio start web --core-only --no-open` 后 API/Web 健康。视觉十维局部评分：布局 9、令牌 9、排版 9、交互 9、动效不适用、3D 清晰度 9、信息设计 9、反馈 9、响应式 8、语义 9。未执行全站/全量回归，未 push。

补充：Deep Native Windows 主程序已切换为 GUI subsystem（PE subsystem=2），重新发布的版本 6 EXE 位于 `D:/Download/666666.deep-native.exe`，双击不再创建控制台窗口；重定向 stdout 的验证命令仍能正常输出。Three 构建增加冻结归档 SHA-256 缓存，同一发布版本再次下载实测 223 ms 返回 32,958,976 字节 PE；新归档首次构建仍需生成专属 Tauri 壳，后续需继续改为预构建壳+快速注入，才能把首次下载也稳定压到秒级。
