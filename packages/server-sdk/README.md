# @bim-studio/server-sdk

可注入服务器配置、凭据存储与 `fetch` 的 ESM API 客户端，并提供服务器配置、远程渲染会话和云渲染工作端合同适配。包本身不提供服务器、登录界面或场景渲染器。

```ts
import { ServerClient, ServerRequestError } from "@bim-studio/server-sdk";

const client = new ServerClient({
  profile: { baseUrl: "https://example.invalid" },
  authStore: {
    getAccessToken: () => undefined,
    setAccessToken: () => {},
    clearAccessToken: () => {},
  },
  fetch: async () => new Response(JSON.stringify({ ready: true })),
});
const result = await client.request<{ ready: boolean }>("/api/meta");
```

上例是无凭据的模拟传输，不会访问该网址。真实宿主必须自行提供经过授权的服务器地址与凭据存储策略，不应把凭据硬编码到客户端代码。API 路径必须位于同源 `/api/` 下；支持 `AbortSignal`，204 返回 `undefined`。HTTP 失败抛 `ServerRequestError`，保留 `status` 与结构化 `body`，调用方应按失败类型提供恢复动作。

当前包为 `private: true`，默认出口是 `dist/index.js` 和 `dist/index.d.ts`；本轮只验证本地 tarball，不公开发布。读请求恢复策略、真实鉴权、远程渲染服务本身不能由模拟传输样例替代验收。

仓库内的完整样例在 `scripts/fixtures/sdk-consumer/`，验证结果在 `docs/sdk-external-consumer-verification-2026-09-06.md`。本地分发时应一并提供样例目录；运行 SDK 不依赖仓库源码。
