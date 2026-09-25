# 工作区外 SDK 消费样例

这是三个私有包的**协议与传输适配**样例，不是可嵌入的 3D ViewerSDK，也不是插件安装器。没有实际服务器请求、登录凭据或业务数据写入；`ServerClient` 使用注入的内存 `fetch`。

## 一键复核

在仓库根目录已有依赖顺序生产构建后运行：

```sh
node scripts/gate-sdk-consumer.mjs
```

门禁不会构建共享 `dist`。它会先核对包出口实物，再执行 `pnpm pack`，把当前构建归档到系统临时目录中的 `bim-sdk-consumer-*`，在工作区之外安装并运行本目录样例。Node ≥24、仓库固定版本 pnpm、既有 TypeScript/esbuild/Playwright 和本机 Chrome 必须已安装；不下载额外工具。

仅使用本地 `file:` tarball；全新 store/cache、`--offline --ignore-scripts`。消费者自己的 `pnpm-workspace.yaml` 中 `overrides` 把转写为精确版本的 `@bim-studio/contracts` 传递依赖指向同一份本地 tarball，避免未发布私有包需要 registry 元数据。pnpm 11 已不读取 `package.json` 的 `pnpm.overrides`，不能沿用旧配置位置。这个覆盖不修改 SDK 内的依赖声明，也不证明包已公开发布。三个源包与归档均必须保持 `private: true`。

## 样例职责

| 文件 | 验证内容 |
|---|---|
| `runtime.ts` | 资源 ID、命令复制/非法值/访问器拒绝、版本与权限协商、生命周期时钟；模拟 HTTP 成功/204/409/跨源拒绝/取消 |
| `negative-types.ts` | 四个非法使用应产生类型错误，防止声明意外退化为 `any` |
| `node.ts` | 从外部已安装包执行同一份检查 |
| `browser.ts` | 同一份检查经真实浏览器打包后运行，以 DOM 输出结果供只读复核 |
| `tsconfig*.json` | 严格 NodeNext / Bundler；`skipLibCheck: false`，不启用仓库 `development` 出口 |

将 `runtime.ts` 中合法的 `position` 改成自己的三维坐标即可体验命令验证；命令不会自动施加到场景，渲染宿主负责调度与执行。该模块的自动生命周期测试不执行用户脚本，更不代表拥有脚本编辑器或调试器。

门禁保留外部消费者与归档，便于另一位开发者检查 `package.json`、安装产物、默认出口和编译输出。精确目录、命令日志、声明解析路径、浏览器输入图、运行结果与截图记录在 `test-output/runs/2026-09-06/sdk-consumer-*/report.json`。不自动清理用户目录；这些临时消费者不应提交。

## 边界

本门禁验证 ESM 的 Node 与浏览器消费，不验证 CommonJS、任意浏览器/构建器、Tauri/云渲染服务、线上凭据、任意项目插件迁移。S4 的“文档中心一键插入 → 修改运行 → 打包插件 → 另一项目安装”仍需单独产品化验收。
