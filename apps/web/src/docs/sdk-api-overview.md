# SDK 与 API 总览

这页先回答“应该调用哪一层”。完整示例分别见 [Deep Engine 独立 SDK](/docs/deep-engine-sdk)、[`studio` 应用 API 手册](/docs/studio-api)、[图文 API 与平台参考](/docs/api-reference) 和 [SDK 可运行样例](/docs/sdk-examples)。

![编辑器、SDK、Studio API 与 Worker 的调用关系](docs-assets/api-call-flow.svg)

## 四层入口

- **编辑器行为脚本**：在当前项目内控制对象、相机、动画、数据和事件。使用运行时注入的 `studio` 与 `ctx`，不依赖 npm 安装，也不能访问 DOM 或原始渲染器。
- **Deep Engine Web SDK**：在自己的网页或播放器中创建 WebGPU 渲染器。使用 `@bim-studio/deep-engine` 的公开 exports，不引用 `src/` 私有路径。
- **Studio HTTP API**：管理登录会话、项目、应用、资源、数据连接和发布。浏览器通过当前 API Origin 访问 `/api/...`，服务端负责权限和审计。
- **云渲染 Worker API**：为独立渲染 Worker 提供 `/v1/health`、会话和观看页接口。调用必须使用 Bearer Token；Worker 根地址没有业务路由。

## Deep Engine 最小接入

公开包当前以源码构建的本地 tarball 交付。完整安装、兼容边界和释放顺序见 [Deep Engine 独立 SDK](/docs/deep-engine-sdk)。

```ts
import { DeepApp, PbrRendererPlugin } from "@bim-studio/deep-engine/app";

const app = await DeepApp.create({
  state: { view },
  mode: "always",
  plugins: [new PbrRendererPlugin({
    canvas,
    gpu: navigator.gpu,
    packet,
    view: frame => frame.state.view,
  })],
});

await app.advance(performance.now());
await app.dispose();
```

宿主持有业务状态、输入和 `requestAnimationFrame`；引擎负责插件依赖、资源校验、渲染阶段和逆序释放。加载失败必须调用 `dispose()` 清理已创建的 GPU 资源。当前 Web SDK 已有仓外消费门禁；Native 仍是独立播放器目标，尚未承诺稳定的外部嵌入 ABI。

## Studio 脚本最小接入

行为脚本由编辑器保存并在 Worker 生命周期中运行：

```ts
export function onData(ctx) {
  const value = Number(ctx.getData("motor.temperature") ?? 0);
  const motor = ctx.object("motor-01");
  motor?.setColor(value >= 80 ? "#ef4444" : "#22c55e");
  ctx.emit("motorTemperatureChanged", { value });
}
```

脚本声明按最小权限填写 `data.read`、`data.write`、`network.connect` 或 `ai.invoke`。异常 Promise 应写入日志并保留上一个稳定值；不要把失败响应改写成成功状态。

## HTTP 与 Worker 约定

- Studio API 的项目、应用、资源和发布接口使用当前登录会话；不要在浏览器代码中拼接数据库请求。
- Worker API 的地址配置填写服务根 Origin，例如 `https://worker.example.com`，SDK 会负责 `/v1` 路径；重复填写 `/v1` 会造成 `/v1/v1/health`。
- `GET /v1/health` 返回合同版本、容量、GPU 与编码器证据；只有带正确 Token 且 `status=ready` 才能创建会话。
- `POST /v1/sessions` 创建会话，`GET /v1/sessions/:id` 查询状态，`DELETE /v1/sessions/:id` 幂等停止；`404`、`401`、`409`、`502` 的判断见 [图文 API 与平台参考](/docs/api-reference#404-与其他错误的判断)。

## 版本与安全边界

SDK 的 exports、合同版本和示例一起发布；接入方应锁定包版本并在升级时执行 `pnpm gate:deep-engine-consumer`。令牌、供应商密钥和数据库凭据只进入服务端环境，不写入脚本、截图、Wiki 或示例代码。截图只展示脱敏项目、假数据和可公开的 URL；截图来源和生成提交号记录在发布证据中。

## 继续阅读

- [Deep Engine 独立 SDK](/docs/deep-engine-sdk)：渲染器、插件、资源和生命周期。
- [`studio` 应用 API 手册](/docs/studio-api)：对象、相机、动画、数据和事件。
- [图文 API 与平台参考](/docs/api-reference)：HTTP、云渲染和供应商接口。
- [SDK 可运行样例](/docs/sdk-examples)：可复制的 Worker 示例和运行结果。
