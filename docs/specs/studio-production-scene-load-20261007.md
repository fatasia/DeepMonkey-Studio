# 生产工作台场景读取诊断

## 现状核查

1. 检索 Web hooks/controllers/api/adapters 与 Server SDK 源码及未跟踪文件，读取 sceneWorkspaceLoadRef 的全部写入点。工作区恢复、只读交付、目录读取已有，不另建加载器。
2. 读取 SceneSnapshot/SceneModelState、AppRoute/workspaceRoute、ServerClient/profile/auth 合同。完整应用路由与旧 scene 路由已有明确解析；scene browse 返回 scene+project。
3. 核对 Web/Server SDK package：现有 React/Vite/Vitest，无需新依赖。
4. 沿 useAppSceneSyncEffects → recoverSceneRouteRead → api.getSceneForBrowse → ServerClient → BrowserHostAdapter/fetch 查消费；再核当前生产 App/api bundle 的同路径源码。
5. 查 scene route recovery、sync effects、workspace load gate 测试与实际 production tab 的只读采样：route、admin、engine 有效，workspace ref 已占位，尚未有 activeScene；目录 GET 成功，不足以证明场景 browse 初始化成功。
6. 查 studio-engine-lod-switch-20261007、studio-deep-author-visual-contract-20261007、1336 handoff、active-task-recovery-ledger。真实生产场景必须恢复后才允许计入性能/视觉验收；不保存测试模型到用户场景。

**已有（不重建）**：完整/旧路由解析、认证恢复、目录请求与恢复读取、500ms busy门、取消清 ref、应用快照恢复。

**真实缺口**：临时生产验收 Vite preview server 仅代理 `/assets/<uuid>...`，没有代理真实 `/assets/projects/.../geometry.glb`。模型请求返回 SPA HTML（HTTP200），导致 applyScene 的第一模型失败、未完成 activeScene 设置。该问题限定验收服务器配置，不算产品渲染/恢复链修复。

## 已排除

- 当前 `apps/web/dist/index.html` 无 scene-viewer-delivery meta。activeManifest 会改为 published 路由及 scene-viewer 用户；实际 admin/studio 不符合，因此不是只读交付清单污染。
- 生产 `App-CPtE-mZd.js` 的读取恢复代码与当前源码同序：ref占位 → loadGate.engage → recovery立即read。没有等交付manifest。
- BrowserHostAdapter 读取 origin/token 都是同步；ServerClient 在 fetch 前只有这两个 await，未持有初始化清单 Promise。
- 切换 cleanup 调用 cancelRead/release 并清 workspace ref，未发现永久保留 cancelled ref 的源码路径。

## 实测与修复归属

主任务在同origin调用生产 API 模块 `getSceneForBrowse`，31.5ms 返回5模型；Network重载也捕获 browse HTTP200。旧 Resource Timing 只有250条导致初始化请求被挤掉，已撤销“未发browse”的初步判断。

相同SMT geometry URL 的修复前独立 HTTP 对照：5180返回 `200 text/html`、前16B为 `<!doctype html>`；4100返回 `200 model/gltf-binary`、前4B为 `glTF`。主任务已在 `production-preview.mjs` 增加精确 `/assets/projects/`、`/assets/library/` 代理并重启，保留 Vite `/assets/*.js` 静态文件。

现有读取恢复、进度门与同步 effect 的21项聚焦测试全部通过。没有修改应用恢复链、清场景或保存用户模型；代理重启后主任务已使用真实SMT继续生产Deep材质与切换回归。
