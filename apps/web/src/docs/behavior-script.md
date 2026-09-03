# 编写和运行行为脚本

行为脚本用于实现编辑器内置面板无法覆盖的二维、三维和数据联动，例如操作摄像机、播放模型动画，以及根据实时数据驱动模型。脚本属于应用文档，可随版本保存；单场景只读 Windows 客户端是独立交付物，不会执行作者行为脚本。

## 创建行为脚本

在二维或三维编辑器选中组件，在交互面板展开“高级脚本”；需要逐帧和固定时间步时，在三维编辑器打开“脚本”工作台。默认 Worker 模式通过受控命令修改场景，避免耗时逻辑阻塞渲染；旧版可信主线程脚本只作为迁移记录保留，不会自动进入 Worker 运行时。

脚本工作台会从当前项目生成对象、组件、数据键、事件、页面、场景和相机视角提示。右侧“数据与事件”资源区可以搜索并一键插入读取、写入、监听和发出代码，同时自动补齐相应能力、权限或 `onEvent` 生命周期。工具栏的问题数可直接定位到失效 ID；“一键补齐声明”会根据代码补充生命周期、能力和权限。`Ctrl+Enter` 会先应用当前草稿再运行，不会运行上一次保存的代码。

```ts
studio.camera.setPose([12, 6, 12], [0, 1, 0], { fov: 55 });
studio.log("已切换到总览位置");
```

## 使用原生 JavaScript 和多个文件

工作台使用原生 JavaScript/ES Module，不要求学习额外 DSL。每个 `.js` 或 `.mjs` 文件会导入成一个独立脚本模块，不会合并成难以维护的大文件；单个上传脚本不能为空且不超过 2 MB。可以分别启用、挂载、下载或删除脚本，未应用的编辑器草稿会阻止提交、拉取和推送，避免版本记录与屏幕内容不一致。

多个脚本共享数据键和业务事件，但不能用相对路径互相导入。跨脚本协作使用 `ctx.emit`、`onEvent` 或应用变量；通用代码应打包为项目依赖。顶部只允许静态 `import`，动态 `import()` 会被运行时拒绝。

`three` 是内置模块，可直接导入；普通 JavaScript 写法也可以使用生命周期参数中的 `ctx.THREE`。Worker 没有 DOM，因此 `window`、`document` 和 React 组件渲染不可用。React 等包即使能安装，也只适合不依赖 DOM 的纯函数；可视界面仍应通过平台组件和稳定扩展接口实现。

```js
import * as THREE from "three";
import { clamp } from "lodash-es"; // 需先在“项目依赖”中安装同名模块

export function onUpdate(ctx) {
  const speed = clamp(Number(ctx.getData("motor.speed") ?? 0), 0, 3);
  ctx.self?.setRotation(0, speed * ctx.elapsedTime, 0);
  ctx.log(THREE.REVISION);
}
```

## 安装并离线使用依赖

从脚本工具栏打开“项目依赖”，可以选择三种来源：

- **npm**：填写包名、项目内模块名和精确版本，例如 `1.2.3`；不接受 `latest`、`^1.2.3` 等浮动版本。
- **本地 JS**：上传 `.js` 或 `.mjs` 文件；服务端会打包为浏览器 ESM，本地工作区要求文件已经是无外部引用的单文件 ESM。
- **外部 URL**：填写不含账号密码的 HTTP(S) 地址；安装时下载并转成本地模块，不在每次运行时访问原地址。

安装结果会记录来源、解析版本、大小、许可证信息（可读取时）和 SHA-256 完整性摘要。运行时只读取项目缓存并再次校验摘要；服务端模式把缓存写入对象存储，本地桌面工作区写入 IndexedDB。npm 和外部 URL 首次安装或更新需要可用网络，本地上传不需要；安装完成后，预览和支持脚本的应用运行时不再依赖原 npm/CDN。删除前会检查哪些脚本仍在 `import` 该模块。

```js
import dayjs from "dayjs";

export function onStart(ctx) {
  ctx.log(dayjs().format("YYYY-MM-DD HH:mm:ss"));
}
```

项目依赖需要是浏览器可执行、可打包的 ESM。依赖本身若含未解析静态引用或动态 `import()` 会被拒绝；Node.js 文件系统、进程、原生扩展和安装脚本不能在浏览器 Worker 中使用。

## 响应数据和交互

使用生命周期函数订阅对象点击或数据产品更新。处理函数应保持短小；耗时任务放在数据中台，场景脚本只消费结果。

脚本挂载到三维对象或二维资源后，`ctx.self` 就是当前实例，不需要在代码里重复写死对象 ID。把同一段行为复制给另一个对象时，只需更换“挂载到”；如果目标被删除，编辑器会直接标记失效并要求重新选择，而不会悄悄退回整个场景。

```ts
function onStart(ctx) {
  ctx.self?.show();
}
```

```ts
function onData(ctx) {
  const speed = Number(ctx.getData("agv.speed") ?? 0);
  const agv = ctx.object("agv-01");
  agv?.setPosition(speed * ctx.deltaTime, 0, 0);
  agv?.setColor(speed > 2 ? "#f59e0b" : "#22c55e");
  ctx.setData("agv.lastSpeed", speed);
  if (speed > 2) ctx.emit("agvOverspeed", { speed });
}
```

`getData` 需要 `data.read`，`setData` 需要 `data.write`。写回值会进入应用变量并继续驱动 2D、3D 和 Unity 数据绑定；`emit` 会作为 `bim-studio:behavior-event` 业务事件交给宿主。

三维对象的点击、双击、移入和移出等交互会进入 `onEvent`。事件携带稳定对象引用，脚本无需直接监听 DOM 或 Three.js 指针事件。

```ts
function onEvent(ctx) {
  if (ctx.event?.name === "click") {
    ctx.log("点击对象", ctx.event.target);
  }
}
```

一个脚本通过 `ctx.emit(name, payload)` 发出的事件也会以 `business.event` 分发给同一应用中其他启用了 `onEvent` 的行为，事件包含 `sourceModuleId`，可用于跨脚本解耦联动。

## 使用脚本 AI

脚本中的统一 AI 入口提供“生成、解释、诊断、任务”四类操作。常用行为优先由确定性生成器产出；需要模型理解时，模型只返回结构化意图或说明，再经过白名单编译和静态检查。生成结果先进入预览，插入编辑器后仍是未保存、未运行的草稿，可以立即撤销；模型不可用时保留本地静态诊断，不把降级结果伪装成模型执行成功。

运行中的脚本也可调用 `studio.ai.invoke(capabilityId, input)`。必须同时声明 `studio.ai` 能力和 `ai.invoke` 权限，宿主才会把请求交给已启用的 AI 插件；插件失败只应中断本次调用。不要把模型文本直接当作可执行代码、现场控制命令或已验证证据。

## Worker 高频 API

- `ctx.object(id)` / `studio.object(id)`：按稳定 ID 取得受控对象句柄。
- `setPosition/setRotation/setScale`：修改模型或 Primitive 变换。
- `show/hide/select/focus/setColor/setOpacity`：控制显隐、选择、聚焦和外观。
- `setMaterial`：增量设置允许的 PBR 与 UV 参数；Worker 不读取原始材质对象。
- `playAnimation/pauseAnimation/stopAnimation/seekAnimation`：控制导入模型的动画 Clip。
- `studio.camera.setPose`：设置相机姿态；聚焦目标使用 `studio.object(id).focus()`。
- `studio.component(id).update(...)`：修改二维组件；`studio.unity(id)` 控制清单允许的 Unity 属性、动作或场景。
- `ctx.getData/setData/emit` 与 `studio.getData/setData/emit`：读取变量、写回联动和发出业务事件。
- `studio.net.fetch/request`：通过服务器网关访问获准的数据接口。

生命周期可选项为 `onStart`、`onUpdate`、`onFixedUpdate`、`onData`、`onEvent`、`onStop` 和 `onDispose`。权限可选项为 `scene.read`、`scene.write`、`data.read`、`data.write`、`ai.invoke`、`network.connect`、`renderer.extend` 和 `editor.extend`。按最小权限声明；`studio.net` 需要 `network.connect`，读取/写入数据分别需要 `data.read`/`data.write`。

第一/第三人称、场景环境、时间线、页面导航、模型屏幕、空间音频、路线控制以及 `raw` 底层对象目前属于编辑器配置或可信交互脚本能力，不应在 Worker 行为脚本中假设可用。准确签名和运行边界见[`studio` 应用 API 手册](/docs/studio-api)。

二维大屏中的实时三维组件会注册场景运行时，所以二维组件事件可以直接调用同一组对象、相机和动画 API。未加载的三维视口仍可执行导航、显隐、颜色、透明度和动画等可移植动作；需要直接操作 `THREE.Object3D` 时，应将组件设为“实时”或先载入视口。

## 原生 Three.js 能力边界

Worker 行为脚本可以使用内置 `three` 模块和生命周期中的 `ctx.THREE` 完成数学、颜色、矩阵等纯计算，但不会拿到场景、相机或渲染器的原始对象。已有可信交互 API 中的 `studio.raw` 属于主线程长尾逃生口，不是默认 Worker 合同，也不应作为可移植脚本的前提。高频能力应优先使用稳定 `studio` API。

## 脚本专用 Git

从脚本工具栏打开“脚本版本”，可以查看状态和提交历史，并把当前多个脚本作为一个快照提交。仓库只包含 `scripts/manifest.json` 和各脚本文件，不跟踪二维页面、三维场景、拓扑、素材、数据或项目依赖。

远端同步是可选项，支持系统 Git 能访问的 HTTPS 或 SSH 地址。地址中禁止嵌入密码；凭据交给操作系统 Git 凭据管理器或 SSH。推送不会强制覆盖远端；拉取只接受通过清单、路径、大小和字段校验的快进结果。拉取完成后会列出新增、修改和删除项，只有用户点击“确认替换并保存”才会写入项目；取消会保留当前脚本，保存失败会恢复原脚本。

脚本 Git 当前依赖服务器进程中的系统 Git。本地桌面的“本地工作区”可以离线编辑和运行脚本、使用已缓存依赖，但不提供本机 Git 仓库；界面会明确显示不可用。需要离线或内网 Git 时，应以本地服务器模式运行，并连接系统 Git 可访问的本机或局域网远端。

## 调试和故障隔离

先在编辑模式运行脚本，查看控制台日志和错误位置。单个脚本异常会被暂停，不应中断页面保存、数据刷新或其他脚本。发布前执行一次停止、启动和场景重载，确认资源清理完整。

Worker 会锁住直接 `postMessage`、`fetch`、XHR、WebSocket、子 Worker、缓存和动态模块加载；联网必须经过 `studio.net`，AI 必须经过 `studio.ai`，两者均由宿主鉴权和审计。这是面向可信项目脚本的兼容性加固，不是执行敌对代码的强安全边界：Worker 仍共享浏览器进程与同源能力。不要安装或运行来源不明的代码；若要开放任意第三方代码，需要另行采用独立源 CSP、SES 或独立解释器等强隔离方案。

需要二维联动时，先完成[编辑二维与三维](/docs/dashboard-scene#编辑二维与三维)。AGV 相关例子见[实时与仿真切换](/docs/agv-runtime-simulation#绑定实时数据)。
