# @bim-studio/scene-sdk

版本化场景协议、命令校验、宿主兼容协商与纯生命周期时钟。此包不包含 DOM、渲染器、编辑器或网络客户端；**不能把它当作可直接嵌入网页的 3D ViewerSDK**。

```ts
import { parseSceneCommand, SceneBehaviorScheduler } from "@bim-studio/scene-sdk";

const command = parseSceneCommand({
  id: "move-1", type: "object.set-transform",
  target: { kind: "object", sceneId: "scene-1", objectId: "device-1" },
  position: [1, 2, 3],
});
const clock = new SceneBehaviorScheduler({ fixedStepMs: 10 });
const ticks = clock.advance(25); // onUpdate 与两个 onFixedUpdate 事件
clock.dispose();
```

`parseSceneCommand` 返回独立副本，非法命令抛 `SceneCommandValidationError`；如需不抛异常的验证，用 `validateSceneCommand`。`resolveSceneExtensionCompatibility` 比较 API 版本、宿主、渲染器、能力和授权范围，但不负责安装或执行插件。宿主必须消费命令与生命周期事件，明确权限并处理失败。

当前包为 `private: true`，仅提供本地 `pnpm pack` 消费验证，不发布 registry。默认出口为 `dist/index.js` 和 `dist/index.d.ts`；`development` 条件仅用于仓库源代码开发。协议的 `SCENE_API_VERSION` 与 npm 包版本是两个不同的版本轴。

仓库内的完整可运行样例在 `scripts/fixtures/sdk-consumer/`，验证结果在 `docs/sdk-external-consumer-verification-2026-09-06.md`。本地分发 tarball 时应一并提供样例目录；它不是 SDK 包的运行依赖。
