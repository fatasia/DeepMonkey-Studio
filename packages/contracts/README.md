# @bim-studio/contracts

Deep Monkey Studio 共享的 TypeScript 数据合同与可序列化纯辅助函数。它不是数据库、API 服务或场景渲染器。

```ts
import { assertPathSafeResourceId, type JsonValue } from "@bim-studio/contracts";

assertPathSafeResourceId("scene-1");
const value: JsonValue = { energy: 12.5, unit: "kWh" };
```

类型合同不会自动验证任意网络输入；仅在明确调用的运行时校验范围内提供保证。消费者仍需要验证外部数据并处理版本差异。

当前 `private: true`，仅本地 `pnpm pack` 验证，不发布 registry。默认 JS / 声明出口分别为 `dist/index.js` / `dist/index.d.ts`，`development` 源码出口仅用于仓库开发。

仓库内的独立消费者样例在 `scripts/fixtures/sdk-consumer/`，验证结果在 `docs/sdk-external-consumer-verification-2026-09-06.md`。这些文档路径不是包的运行依赖。
