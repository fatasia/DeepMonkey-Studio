# 正式 Web 与对象资源路由共存

## 现状核查

1. 已查全仓源码与未跟踪项：API routes.ts 已注册 `/assets/*`，productionWeb 只注册 `/*`，Vite 正式入口引用 `/assets/<hash>.js/css`；容器文件存在但所有请求由对象路由返回 404。
2. Fastify 路由、ProductionWebOptions 与 ObjectStore 已定义；对象 key 用既有 isPublicAssetKey 校验，不改存储合同或公开 URL。
3. 固定 Fastify/@fastify/static 已在用，插件支持 wildcard:false，为已有静态文件注册精确路由；无新增依赖。
4. registerRoutes 先于 registerProductionWeb，正式 API 同源部署、Docker 与 Windows 都消费同一入口；开发 Vite 独立服务不触发。
5. 已有 productionWeb 原文件、Brotli、SPA、API 404 测试，但没有同时存在对象 `/assets/*` 的用例。真实 Docker 页停留“正在加载工作台”，日志同时间 JS/CSS 404，目录文件已 read-only 核对。
6. 已查 SDK/Docker 发行规格、1336 handoff 与发布链要求，最终部署不能只验证 HTML/WASM 返回 200。

**已有（不重建）**：同源正式托管、Brotli、SPA fallback 与对象存储路由。

**真实缺口**：编译资源路径被更具体的对象 wildcard 抢走。为已构建静态文件注册精确路径，保留对象 wildcard 接受真实项目资源；补相同注册顺序下两者并存、压缩资源和 API 404 测试。
