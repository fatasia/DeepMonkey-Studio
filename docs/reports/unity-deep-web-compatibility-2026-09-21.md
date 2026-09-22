# Unity WebGL 原包在 Deep Web 环境的追加验收

本项测试对象是项目插件导出的真实 Unity WebGL 包；不是 Unity 插件安装包，也不重新导出样本。按用户最新指令，Unity Native 支持与兼容性检查明确排除。

## 已核对

| Unity | 原包（仓库相对路径） | ZIP SHA-256 |
|---|---|---|
| 2022.3.62f1 | `tools/unity/.smoke-runs/2022.3-20260915-082342-229/Build/bim-studio-webgl.zip` | `ad7f76bc71b8bf94c08ccc735e8f824cee32fffca85b8dd48eebe2d82b302306` |
| 6000.0.52f1 | `tools/unity/.smoke-runs/6000.0-20260915-082342-229/Build/bim-studio-webgl.zip` | `a86c6e6f86316e2edff423b8ddd4b94963ce1bb2c6853204cc2c0dfd789420fb` |

两包各 19 条目，manifest 声明插件 0.6.1、`BridgeSmoke`、动作 `focus`、回传事件 `device-click`，含 ACK/heartbeat/data-layers/properties/actions/events。实际 ZIP 中存在 Loader/Framework/WASM/Data，入口包含 `unity-bridge.js` 与 `BimStudioUnityBridge.register`。逐载荷大小和哈希见 `test-output/unity-deep-web-20260921/original-artifacts.json`。

当前作者页面的调用路径是 `DashboardCanvasNode` → `UnitySceneEmbed` → iframe → Unity Loader/Bridge；组件不按 Three/Deep 引擎分支。源码支持复用同一 Web 嵌入协议，但这不证明 Deep Web 页面已经完成加载和交互实测。`onlineFlowUnityRuntime.mjs` 的 `runtimeDocument()` 是协议测试桩，不可替代真实 Unity 包。

## 最终浏览器验收

本轮 CUA 查询返回 `apps=[]`、`browsers=[]`；尝试创建 IAB 返回 `Browser is not available: iab`，没有可操作的浏览器。没有改用非授权浏览器自动化，没有把源码或 ZIP 检查记为页面通过。此项转入最终浏览器验收，不等待浏览器阻塞其他开发。

复用上述包，依次验证：自研 Deep Web 宿主已生效；Unity Loader 完成并出现真实场景；Bridge ready 与心跳；真实 `focus` 动作/ACK、`device-click` 事件与变量回写；运行态键鼠、设计态输入隔离；取消/切页卸载和重新加载。保存宿主引擎证据、包哈希、状态记录、画面与控制台结果。不要把 Unity 自己的 WebGL 渲染误称为 Deep 渲染其内部场景。
