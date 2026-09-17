# 下载取消前置检查

DMDA、ZIP和独立EXE下载在等待冻结清单后先检查请求取消，再验证和序列化归档。存储适配器即使没有响应取消，也不会继续生成无人接收的大包。

既有归档校验、候选有效期复查、权限和发送前取消检查不变。本片不涉及包体裁剪或交付格式变化。

## 验证

- 真实本机HTTP连接，阻塞清单读取后主动断开客户端，确认服务端AbortSignal已取消；释放仍返回清单的适配器并等待路由处理器结束。
- 三种下载路径分别断言归档创建、序列化和ZIP/EXE生成都未调用。
- 下载回归加新增测试：2文件35项通过；API typecheck通过。
- 首轮测试等待断开连接上的 `onResponse` 导致三项超时；改为观察路由处理器结束后通过，未改产品行为迎合测试。

复跑：`pnpm --filter @bim-studio/api exec vitest run src/dashboardOfflineDownloadCancellation.test.ts src/dashboardOfflineArchiveDownloadRoutes.test.ts`。

工程十维自评均9：窄范围复用现有取消信号、三条同族真实连接测试、无新依赖。同步CPU校验已开始后的抢占式取消不由本片提供。
