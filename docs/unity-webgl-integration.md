# Unity WebGL 集成指南

本文定义 iTwin Studio 嵌入 Unity WebGL 场景的当前接入方式、协议边界和兼容性门禁。当前交付与本机验证目标是 **Unity 2022 LTS 与 Unity 6.0**，不把协议绑定到某个 Unity Editor 小版本；现有 Unity 2023 工程可按同一协议接入但不在本轮本机构建门禁内，Unity 2021 不在项目范围；移动端不在本阶段支持范围内。

## 1. 能力状态

截至 2026-08-27，项目已实现以下浏览器侧能力：

- 二维看板可添加 `unity` 组件，配置 Unity WebGL 播放页 URL、允许的消息来源、场景列表、当前场景和事件清单。
- Unity 构建可通过版本化 manifest 声明播放器入口、Unity 版本、场景、事件和数据层；多个看板组件可复用同一个构建清单，播放 URL 仍可按组件覆盖。
- Unity 播放页通过 iframe 运行；设计态隔离 Unity 输入，运行态恢复输入。
- iTwin Studio 使用版本化 `postMessage` 协议下发初始化信息、全局变量、筛选参数、组件数据、属性值、Unity 动作和目标场景；属性值在运行时修改时通过 `properties` 消息增量更新，交互流可通过 `action` 消息触发 Unity 动作。
- 播放页通过 `unityInstance.SendMessage()` 把消息交给 Unity 场景中的 `BimStudioBridge.ApplyStudioMessage(string)`。
- Unity 可通过 `.jslib` 调用浏览器桥，向看板回传业务事件或运行错误。
- 看板接收 Unity 事件后，将事件值写入 `unity.{组件数据键}.{事件名}`，并触发该组件的点击联动。
- 项目内可直接导入 Unity WebGL ZIP；服务端会做 CRC、路径穿越、压缩包大小和文件数校验，自动托管入口与 manifest，并保留不可变版本和内容哈希。
- 资源版本可在组件内切换；manifest 中声明的 dataLayers 可直接映射到看板变量，objects、actions、properties 会随清单透传给运行时。
- 仓库提供中文 Unity Package `com.bim-studio.bridge@0.6.0`：自动扫描绑定组件、生成并校验 manifest、修复常驻桥对象、构建 WebGL，再把完整构建目录压缩成可直接拖入平台的 ZIP；Unity 主线程回传消息 ACK、运行心跳、FPS 和活动场景。0.6.0 统一支持模型、Animator、材质、变换、相机、灯光和可选 uGUI 双向绑定。

以下能力尚未完成，不应在交付时宣称已经支持：

- CDN 自动发布、增量更新和缓存刷新已明确排除在当前范围外；平台内置托管继续承担快速复用、测试和中小规模交付。
- 数据连接仍统一在平台侧配置，Unity Inspector 只声明稳定的数据层、属性、动作、业务对象和回传事件。插件已提供中文无代码绑定、就地创建标识、GameObject 一键注册和 UnityEvent 事件回传，避免在 Unity 工程中重复保存数据源凭据。
- 平台图形化面板和 Worker 行为脚本共享 manifest：`studio.unity(id).setProperty/setProperties/invoke/switchScene` 只接受当前资源版本声明的组件、属性、动作、对象和场景。模型、相机、灯光、动画及 uGUI 因而可以用页面配置或脚本编辑，两种方式具有相同的校验和运行语义。
- 已使用本机 Unity 2022.3.62f1 与 Unity 6.0（6000.0.52f1）完成插件编译、真实 WebGL 构建、桥注入、manifest 和 ZIP 产物门禁；最终浏览器画面与具体业务项目仍需按交付项目验收。

FineVis 官方文档给出的参照能力包括 Unity WebGL 资源包上传、基于 FVS-Unity-SDK 的资源配置、多场景、FineVis 数据源绑定以及联动、跳转、传参等自定义事件。本文采用相同的“宿主数据与交互驱动 Unity 场景”方向，但不把 FineVis 已有的资源管理能力误写为本项目现状。参见 [FineVis FVS-Unity 组件](https://help.fanruan.com/finereport/doc-view-4832.html)。

## 2. 设计决策

### 2.1 版本中立，而非按 Unity 版本写四套适配

集成只依赖 Unity Web 平台长期公开的三个边界：

1. 自定义 Web 模板负责生成播放器页面。
2. 构建加载器提供 `createUnityInstance()`，成功回调返回 `unityInstance`。
3. 浏览器使用 `unityInstance.SendMessage(objectName, methodName, value)` 调用 GameObject 上的公开方法；Unity 使用 `.jslib` 调用页面 JavaScript。

Unity 2022、2023 的官方 WebGL 模板文档和 Unity 6 的 Web 模板文档均保留这一路径。iTwin Studio 因而版本化自己的消息协议，而不判断 `Application.unityVersion` 后分支调用内部加载器 API。官方依据见 [Unity 2022 WebGL templates](https://docs.unity3d.com/2022.3/Documentation/Manual/webgl-templates.html)、[Unity 2023 WebGL templates](https://docs.unity3d.com/2023.2/Documentation/Manual/webgl-templates.html) 和 [Unity 6 Web templates](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-templates.html)。

“版本中立”表示桥接层不主动依赖某一版本私有实现，不表示未经构建验证即可承诺所有补丁版本。每个受支持版本仍需通过第 10 节的验收矩阵。

### 2.2 内置资源托管与外部 CDN 双路径

项目现在同时支持两条路径：在组件中导入 ZIP，由服务端校验并版本化托管；或继续填写外部 manifest/player URL。大构建仍建议独立 CDN 部署，以获得压缩头、缓存和独立发布节奏；内置托管用于快速复用、测试和中小规模交付，不在浏览器端临时解压。

## 3. 总体链路

```text
iTwin Studio 看板组件
  │  postMessage: init / parameters / data / scene
  ▼
Unity 播放页 iframe（受控 HTTP(S) origin）
  │  unityInstance.SendMessage("BimStudioBridge", "ApplyStudioMessage", json)
  ▼
Unity GameObject + C# 接收器
  │  业务逻辑：切场景、刷新设备、定位对象、播放动画
  │
  │  C# -> .jslib -> window.BimStudioUnityBridge.emit(...)
  ▼
Unity 播放页
  │  postMessage: ready / event / error
  ▼
iTwin Studio 变量与交互流
```

宿主与 Unity 播放页应部署在不同 origin 时也可工作。双方通信只走结构化消息，不要求 iframe 直接读取父页面 DOM。

## 4. Unity 工程接入

### 4.0 推荐的零代码路径

1. 在平台 Unity 资源面板下载 `com.bim-studio.bridge-0.6.0.tgz`，通过 Unity Package Manager 的 **Add package from tarball** 安装。
2. 给业务对象添加中文 Inspector 中的“数据 / 属性绑定”“动作绑定”或“事件回传”组件；标识和业务对象可以在当前 Inspector 就地创建。
3. 运行 **BIM Studio/从场景自动同步集成清单** 检查自动发现结果。插件会保留已有标签、类型和选项，同时补齐数据层、属性、动作、事件、对象路径与动作目标 ID。
4. 运行 **BIM Studio/一键构建并导出 WebGL ZIP**。构建前会再次自动同步和校验，并自动注入浏览器桥。
5. 把 ZIP 拖入平台 Unity 组件。平台会展示 manifest 发现数、Bridge 状态，并可直接发送测试动作；场景、数据层、属性、动作和回传事件随后进入平台数据与交互配置。

这条路径不要求用户手写 Web 模板、`.jslib` 或桥接 C#。后续小节保留的是协议说明和定制工程的手动接入参考，不是普通用户的必做步骤。

### 4.1 创建自定义 Web 模板

在 Unity 工程中创建：

```text
Assets/
  WebGLTemplates/
    BimStudio/
      index.html
      unity-bridge.js
```

可从该 Unity 版本内置的 Default 或 Minimal 模板复制后修改。不同 Unity 版本生成的 loader 文件名和构建配置字段可能变化，因此应复制**当前 Editor 自带模板**，不要把某个旧版本的完整 `index.html` 长期复制给所有版本。

将项目的 `apps/web/public/unity-bridge.js` 作为接入基线复制到模板目录，并在播放器页加载：

```html
<script src="unity-bridge.js"></script>
```

在模板原有的 `createUnityInstance()` 成功回调内注册实例：

```js
createUnityInstance(canvas, config, onProgress)
  .then(function (unityInstance) {
    window.BimStudioUnityBridge.register(unityInstance, "BimStudioBridge");
  })
  .catch(function (error) {
    window.BimStudioUnityBridge.error(error);
  });
```

`BimStudioBridge` 是 Unity 场景中的接收 GameObject 名称，可以在 `register` 的第二个参数中修改，但必须与场景对象名完全一致。注册成功后桥会向父页面发送 `ready`；宿主收到 `ready` 后会再次发送完整 `init`，因此不会依赖 iframe `load` 与 Unity 运行时初始化的先后顺序。

Unity 官方说明 `createUnityInstance()` 由对应构建的 loader 脚本提供，并返回可用于交互的 Unity 实例；`SendMessage` 用于调用场景 GameObject 上的方法。参见 [Unity Web template structure and instantiation](https://docs.unity3d.com/6000.0/Documentation/Manual/web-templates-structure.html) 和 [Unity 2022 WebGL templates](https://docs.unity3d.com/2022.3/Documentation/Manual/webgl-templates.html)。

### 4.2 添加 C# 接收器

创建常驻 GameObject `BimStudioBridge`，挂载以下接收器。示例只解析稳定信封字段，把动态 JSON 留给项目自己的 JSON 方案；Unity `JsonUtility` 不适合作为任意对象、数组和字典的数据绑定解析器。

```csharp
using System;
using UnityEngine;
using UnityEngine.Events;

public sealed class BimStudioBridge : MonoBehaviour
{
    [Serializable]
    private sealed class Envelope
    {
        public string source;
        public int version;
        public string type;
        public string widgetId;
    }

    [Serializable]
    public sealed class JsonMessageEvent : UnityEvent<string> { }

    public JsonMessageEvent onInit = new JsonMessageEvent();
    public JsonMessageEvent onParameters = new JsonMessageEvent();
    public JsonMessageEvent onData = new JsonMessageEvent();
    public JsonMessageEvent onProperties = new JsonMessageEvent();
    public JsonMessageEvent onAction = new JsonMessageEvent();
    public JsonMessageEvent onScene = new JsonMessageEvent();

    private void Awake()
    {
        DontDestroyOnLoad(gameObject);
    }

    // 必须为 public，名称必须与网页桥中的 ApplyStudioMessage 一致。
    public void ApplyStudioMessage(string json)
    {
        Envelope envelope;
        try
        {
            envelope = JsonUtility.FromJson<Envelope>(json);
        }
        catch (Exception exception)
        {
            Debug.LogError($"Invalid iTwin Studio message: {exception.Message}");
            return;
        }

        if (envelope == null || envelope.source != "bim-studio" || envelope.version != 1)
        {
            Debug.LogWarning("Ignored unsupported iTwin Studio message.");
            return;
        }

        switch (envelope.type)
        {
            case "init":       onInit.Invoke(json); break;
            case "parameters": onParameters.Invoke(json); break;
            case "data":       onData.Invoke(json); break;
            case "properties": onProperties.Invoke(json); break;
            case "action":     onAction.Invoke(json); break;
            case "scene":      onScene.Invoke(json); break;
            default: Debug.LogWarning($"Unknown iTwin Studio message type: {envelope.type}"); break;
        }
    }
}
```

实际项目可以在各事件监听器中使用已选定并锁定版本的 JSON 库解析 `payload`。不要在桥接公共层强制绑定某个业务数据模型；数据层、设备属性和动画指令应由 Unity 应用自己的适配器负责。

## 5. Unity 向宿主发送事件

### 5.1 `.jslib` 插件

Unity 官方推荐把 Unity 调用浏览器 JavaScript 的代码放入 `Assets/Plugins` 下的 `.jslib`。参见 [Interaction with browser scripting](https://docs.unity3d.com/6000.0/Documentation/Manual/web-interacting-browser-js.html)。

创建 `Assets/Plugins/BimStudioBridge.jslib`：

```js
mergeInto(LibraryManager.library, {
  BimStudioEmit: function (eventNamePtr, payloadJsonPtr) {
    var eventName = UTF8ToString(eventNamePtr);
    var payloadJson = UTF8ToString(payloadJsonPtr);
    var payload = null;

    try {
      payload = payloadJson ? JSON.parse(payloadJson) : null;
      window.BimStudioUnityBridge.emit(eventName, payload);
    } catch (error) {
      window.BimStudioUnityBridge.error(error);
    }
  },

  BimStudioError: function (messagePtr) {
    window.BimStudioUnityBridge.error(UTF8ToString(messagePtr));
  }
});
```

对应 C# 封装：

```csharp
using System.Runtime.InteropServices;
using UnityEngine;

public static class BimStudioEvents
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void BimStudioEmit(string eventName, string payloadJson);

    [DllImport("__Internal")]
    private static extern void BimStudioError(string message);
#endif

    public static void Emit(string eventName, string payloadJson = "null")
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        BimStudioEmit(eventName, payloadJson);
#else
        Debug.Log($"[BimStudio event] {eventName}: {payloadJson}");
#endif
    }

    public static void Error(string message)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        BimStudioError(message);
#else
        Debug.LogError(message);
#endif
    }
}
```

业务侧示例：

```csharp
public void OnDeviceClicked(string deviceId)
{
    BimStudioEvents.Emit("device-click", "{\"deviceId\":\"" + deviceId + "\"}");
}
```

生产代码应使用 JSON 序列化器生成 `payloadJson`，不要直接拼接外部输入。事件名应使用稳定、可迁移的业务名称，例如 `device-click`、`alarm-acknowledged`、`camera-arrived`，不要使用场景层级路径或临时 GameObject 名称作为公共契约。

## 6. 消息协议 v1

所有消息都是可结构化克隆的普通对象。当前桥接版本为 `1`，不兼容变更必须提升版本，不能静默改变字段语义。

### 6.1 宿主到 Unity

公共信封：

```json
{
  "source": "bim-studio",
  "version": 1,
  "type": "init | parameters | data | dataLayers | properties | action | scene",
  "widgetId": "dashboard-node-id",
  "payload": null
}
```

| `type` | `payload` | 发送时机 | Unity 侧责任 |
| --- | --- | --- | --- |
| `init` | `{ "scene": string, "parameters": object, "filters": object, "data": any, "dataContext": { "value": any, "rows": array, "samples": array }, "dataLayers": object }` | iframe 加载及收到 `ready` 后 | 建立完整初始状态；处理重复调用时保持幂等 |
| `parameters` | `{ "variables": object, "filters": object, "dataLayers": object }` | 全局变量、筛选条件或数据层改变 | 只刷新依赖这些参数的对象和逻辑 |
| `data` | 任意 JSON 值 | 绑定组件的数据改变 | 更新设备、指标、图层或动画输入 |
| `dataLayers` | manifest 数据层键到当前 JSON 值的映射 | 变量、筛选或数据结果改变 | 通过 `onDataLayers` 增量更新已声明数据层；无需自行从参数信封拆包 |
| `properties` | manifest 属性键到当前值的映射 | 设计器属性值改变 | 更新材质、对象状态或业务参数 |
| `action` | `{ "action": string, "objectId": string|null, "value": any }` | 平台交互流触发 Unity 动作 | 对声明对象执行聚焦、选择、播放等工程内动作 |
| `scene` | 场景名字符串 | 当前 Unity 场景配置改变 | 切换到目标场景；空字符串表示使用构建默认场景 |

宿主可能连续发送 `init`、`parameters`、`data` 和 `dataLayers`。Unity 接收器必须把消息当作“最新状态”，不要假设每种消息只出现一次。`data` 保留原始组件值以兼容既有工程，`dataLayers` 是面向 manifest 的稳定增量通道。

### 6.2 Unity 到宿主

```json
{
  "source": "unity-webgl",
  "version": 1,
  "type": "ready | event | error",
  "widgetId": "dashboard-node-id",
  "eventName": "device-click",
  "payload": { "deviceId": "pump-01" },
  "message": "optional error message"
}
```

| `type` | 必需字段 | 用途 |
| --- | --- | --- |
| `ready` | 公共信封 | `unityInstance` 已注册，可以接收消息 |
| `event` | `eventName` | 把 Unity 交互写入看板变量并触发组件联动 |
| `error` | `message` | 在 Unity 组件上显示明确的运行错误 |

`widgetId` 在第一次宿主消息到达后由播放器桥记住。Unity 过早发送的业务事件可能没有 `widgetId`，宿主仍会按 iframe 来源接收；工程应优先等待 `ready` 完成和首个 `init` 后再发业务事件。

## 7. 多场景

iTwin Studio 只发送目标场景名，不替 Unity 工程选择加载策略。Unity 侧应按项目规模实现以下任一种方式：

- 小型互斥场景：`SceneManager.LoadSceneAsync(sceneName, LoadSceneMode.Single)`。
- 需要保留公共灯光、相机、桥接器或 UI 的项目：保留 Bootstrap 场景，并用 `LoadSceneMode.Additive` 异步加载业务场景，再卸载上一个业务场景。
- 大型场景：结合项目既有的 Addressables/AssetBundle 策略；桥协议仍只传稳定的业务场景 ID，由 Unity 内部映射到实际地址。

`BimStudioBridge` 应位于 Bootstrap 场景或使用 `DontDestroyOnLoad`，否则切场景后宿主仍会发送消息，但目标 GameObject 已不存在。场景切换应具备：

- 同一目标场景重复请求幂等；
- 请求排队或取消，避免快速切换产生多个同时加载任务；
- 加载失败调用 `BimStudioEvents.Error(...)`；
- 切换完成可发 `scene-ready` 业务事件，供看板解除加载态或继续动作链；
- 场景名称使用资源清单中的稳定 ID，不直接暴露构建路径。

Unity 官方提供异步和 Additive 场景加载能力，但加载策略、依赖释放和业务状态恢复属于 Unity 工程责任。参见 [SceneManager.LoadSceneAsync](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/SceneManagement.SceneManager.LoadSceneAsync.html) 与 [LoadSceneMode.Additive](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/SceneManagement.LoadSceneMode.Additive.html)。

## 8. 数据、参数与联动约定

### 8.1 绑定边界

- **变量 `variables`**：页面级或应用级业务状态，例如当前设备、时间窗口、模式、用户操作结果。
- **筛选 `filters`**：二维筛选控件形成的字段条件，可跨二维页面保持并刷新绑定数据。
- **组件数据 `data`**：Unity 组件在 Data 面板中绑定的原始值；保持兼容已有监听器。
- **数据上下文 `dataContext`**：统一暴露 `value`、`rows`、`samples`，供数据层绑定使用，例如 `data.value`、`data.rows`。
- **数据层 `dataLayers`**：按 manifest 的 layer key 输出；绑定键可引用完整变量键、`variables.*`、`filters.*` 或 `data.*`。导入资源版本时同名层自动绑定，切换版本会清理失效层、属性和默认动作。
- **场景 `scene`**：当前 Unity 业务场景 ID。

Unity 工程应维护一层映射表，例如：

```json
{
  "dataLayers": {
    "device-status": {
      "keyField": "deviceId",
      "target": "EquipmentRegistry",
      "handler": "ApplyStatusRows"
    }
  },
  "events": ["device-click", "scene-ready"]
}
```

当前 iTwin Studio 会读取第 11 节定义的版本化构建清单，把清单随 `init` 消息交给 Unity，并根据平台变量、二维筛选和组件数据结果持续解析/推送 `dataLayers`。Unity 工程仍负责把稳定 layer key 映射到自己的 GameObject、ECS、材质、动画或业务系统；平台不依赖反射扫描场景层级。

### 8.2 Unity 事件驱动二维动作

当 Unity 发出：

```js
window.BimStudioUnityBridge.emit("device-click", { deviceId: "pump-01" });
```

若组件数据键为 `factory`, iTwin Studio 将写入：

```text
unity.factory.device-click = { "deviceId": "pump-01" }
```

并触发该 Unity 组件的点击交互流。后续动作可使用该变量进行页面跳转、过滤、显示隐藏或其他已支持的看板动作。事件负载应保持小而稳定；大批量遥测继续走数据源/数据管道，不通过 `postMessage` 逐点推送。

## 9. 安全与部署要求

### 9.1 Origin 与 iframe

- Unity 播放 URL 和“允许的消息来源”必须是合法 `http:` 或 `https:` URL；生产环境使用 HTTPS。
- iTwin Studio 向 iframe 发送消息时使用精确 `targetOrigin`，接收时同时校验 `event.origin` 和 `event.source === iframe.contentWindow`。
- 播放器首次 `ready` 在尚未获知宿主来源时使用 `window.parent.postMessage(..., "*")`；收到第一条通过协议校验的宿主消息后，后续事件固定回传到该消息的 `event.origin`。宿主仍同时校验来源和 iframe 窗口。
- 当前 iframe sandbox 允许脚本、同源能力、指针锁和下载。Unity 播放页必须部署在受控 origin，不与管理后台 Cookie、敏感 API 或用户上传的任意 HTML 共用同源权限。
- 若 Unity 播放页不应被其他站点嵌入，应在其响应头设置适合部署拓扑的 `Content-Security-Policy: frame-ancestors ...`；同时让该策略允许 iTwin Studio 的实际 origin。

### 9.2 消息与数据

- Unity 和宿主都必须校验 `source`、`version`、`type`、事件名、消息大小和业务字段，不执行从消息传入的代码、方法名或任意 URL。
- 不在 URL、变量、筛选、组件数据或事件载荷中传递访问令牌、数据库凭据和个人敏感信息。
- 对消息频率和负载大小设置预算；建议交互消息小于 64 KiB，批量数据通过正常数据接口加载。该数值是项目运维建议，不是浏览器协议上限。
- Unity 事件清单应作为发布白名单；未知事件记录诊断而不是自动创建任意动作。
- Unity 构建产物按不可变版本发布，记录内容哈希；更新 URL 或构建内容后重跑兼容验收。

### 9.3 Web 构建托管

- 按 Unity 目标版本文档配置 `.wasm`、`.data`、框架脚本的 MIME 类型、压缩响应头和缓存策略。
- 播放页与构建文件跨域时，CDN/服务器需返回正确 CORS 头；不要以关闭浏览器安全策略作为解决方案。
- Service Worker、缓存和 CDN 回源必须按版本目录隔离，避免 `index.html` 与旧 `.wasm/.data` 混用。
- 发布前用与生产一致的 HTTPS、反向代理、CDN 和响应头验证，不只测试 Unity 的本地 Build And Run 服务器。

## 10. 版本兼容矩阵与发布门禁

| Unity 版本 | 接入路径 | 协议目标 | 当前实机构建证据 | 发布要求 |
| --- | --- | --- | --- | --- |
| 2022 LTS（2022.3） | WebGL template + `createUnityInstance` + `SendMessage` + `.jslib` | 支持 | **2022.3.62f1 已真实构建并回灌 ZIP**：19 文件、`BridgeSmoke` 场景、manifest、浏览器桥自动注入与注册均通过 | 补 HTTPS 浏览器交互与性能工作负载证据 |
| Unity 2023 | WebGL template + `createUnityInstance` + `SendMessage` + `.jslib` | 协议兼容 | 当前不在本机版本门禁内 | 客户已有 2023 工程时按同一协议单独验收；不作为项目默认验证版本 |
| Unity 6（6000.0） | Web template + `createUnityInstance` + `SendMessage` + `.jslib` | 支持 | **6000.0.52f1 已真实构建并回灌 ZIP**：19 文件、`BridgeSmoke` 场景、manifest、浏览器桥自动注入与注册均通过 | 补 HTTPS 浏览器交互与性能工作负载证据；6000.3 按当前项目范围不再验证 |
| Unity 6.6（6000.6）WebGPU | 同一 Web template 与 Bridge 协议，图形 API 改为 WebGPU 并保留后端回退 | 待验证 | Unity 已于 2026-08-24 宣布 WebGPU 正式支持；本机尚未安装 6000.6，不能用 6000.0 WebGL 构建替代 | 安装并冻结 6000.6 后，用同一资产完成 WebGPU/WebGL 回退、Bridge 双向控制、GPU 帧时、首帧、同画质与短时稳定性对照 |

其中“协议目标支持”只表示接入不使用该版本私有 API；只有实际构建证据完成后，该版本才能进入项目的“已验证支持”清单。Unity 2023 不是当前本机默认验证线；既有 2023 工程仍可通过同一桥接协议接入和单独验收。

每个版本至少验证：

1. Release Web 构建可在目标 Chrome/Edge 版本通过 HTTPS 加载，控制台无新增错误。
2. iframe 加载后只报告一次有效 `ready`，重复 `init` 不产生重复对象或重复订阅。
3. 变量、筛选、标量数据、数组数据和空值更新正确；页面刷新后状态恢复。
4. 20 次快速场景往返无失联、残留业务场景或持续增长的内存。
5. Unity 点击事件写入预期变量并只触发一次看板动作；未知和超大事件被拒绝或诊断。
6. URL origin 与配置 origin 不匹配时，消息被宿主拒绝并显示可定位的错误。
7. Unity 运行异常能通过 `error` 显示；iframe、构建文件或网络失败有明确降级，不出现永久黑屏。
8. 发布环境的压缩、MIME、CORS、CSP、缓存和 CDN 行为与本地一致。

测试记录应包含 Unity Editor 精确版本、构建配置、Git commit、构建产物哈希、浏览器版本、OS、GPU/驱动、部署 URL、控制台日志和结果截图。没有这些证据，不应把“接口相同”当作“版本已验证”。

## 11. FineVis 对标差距与后续实现顺序

FineVis 官方方案的产品优势不是 iframe 本身，而是 Unity SDK、资源包、配置解析、属性面板、数据源和交互在设计器内形成闭环。当前已完成的闭环和剩余项如下：

1. **已完成**：`schemaVersion: 1` manifest 已覆盖场景、事件、动作、数据层、对象和类型化属性；服务端记录 ZIP 内容哈希和不可变版本。
2. **已完成**：服务端 ZIP 大小/文件数/解压大小/路径安全校验、Zip Slip 防护、对象存储同步、版本激活和删除生命周期。
3. **已完成核心闭环**：设计器根据 manifest 生成场景、动作、数据层、对象和类型化属性配置；同名数据层自动绑定，并随平台变量、二维筛选、标量/行集数据持续增量推送；Unity 事件可驱动平台交互，平台动作可下发 Unity。
4. **已完成**：中文 Unity Editor Package 0.6.0 可从核心及可选 uGUI 场景绑定自动发现数据层、属性、动作、事件和业务对象，导出前自动同步 manifest，输出 `.jslib`，构建后自动复制浏览器桥并向生成的 `index.html` 注入实例注册代码。
5. **已完成当前版本门禁**：0.6.0 已在 2022.3.62f1 与 6000.0.52f1（含 `com.unity.ugui`）完成插件编译、真实 WebGL 构建、manifest 生成、浏览器桥注入和 ZIP 回灌；Unity 主线程 ACK、5 秒心跳、FPS/活动场景遥测和通信降级恢复均通过编译、构建与浏览器故障恢复门禁。
6. **部分完成**：浏览器端已有 20 秒启动超时、明确错误、一键重试、消息确认超时和心跳恢复；继续补生产 HTTPS/CSP/CDN 门禁、依赖诊断、缓存失效和大包分段进度体验。

### 当前构建清单格式

```json
{
  "schemaVersion": 1,
  "bridgeVersion": 1,
  "playerUrl": "./index.html",
  "unityVersion": "Unity 6",
  "scenes": ["Factory", "PumpRoom"],
  "events": ["device-click", "alarm-acknowledged"],
  "dataLayers": [
    { "key": "telemetry", "description": "设备实时遥测", "keyField": "deviceId", "target": "EquipmentRegistry" }
  ]
}
```

`playerUrl` 可相对 manifest 地址解析，因此整个构建目录可以按版本移动到不同 CDN 路径；仅允许 HTTP(S) 入口。宿主会校验 `schemaVersion` 和 `bridgeVersion`，清单错误会在 Unity 组件内直接显示，不以空白 iframe 掩盖失败。

当前可命名为“Unity WebGL 资源包与双向 Bridge 集成”；在多版本浏览器矩阵、生产托管门禁和大包运维闭环完成前，不宣称“所有 Unity 主流版本已完整验证”。

## 12. 相关实现

- 宿主协议：`apps/web/src/unityBridge.ts`
- Unity iframe 运行时：`apps/web/src/components/UnitySceneEmbed.tsx`
- 播放页 JavaScript 桥：`apps/web/public/unity-bridge.js`
- 看板组件配置与事件映射：`apps/web/src/components/DashboardWorkspace.tsx`
- 公共组件契约：`packages/contracts/src/index.ts`
- Unity Editor Package：`tools/unity/com.bim-studio.bridge`
- 多版本验证脚本：`tools/unity/run-bridge-smoke.ps1`
- 真实 ZIP 回灌验证：`tools/unity/verify-build-import.ts`

外部参考：

- [FineVis FVS-Unity 组件](https://help.fanruan.com/finereport/doc-view-4832.html)
- [Unity 2022.3 WebGL templates](https://docs.unity3d.com/2022.3/Documentation/Manual/webgl-templates.html)
- [Unity 2023.2 WebGL templates](https://docs.unity3d.com/2023.2/Documentation/Manual/webgl-templates.html)
- [Unity 6 Web templates](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-templates.html)
- [Unity 6 browser scripting interaction](https://docs.unity3d.com/6000.0/Documentation/Manual/web-interacting-browser-js.html)
- [Unity 6000.6 WebGPU 正式支持公告](https://discussions.unity.com/t/webgpu-out-of-experimental-in-unity-6-6/1734694)
