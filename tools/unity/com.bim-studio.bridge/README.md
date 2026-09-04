# Deep Monkey Studio Unity WebGL 桥接插件

通过 Unity Package Manager 的 `Add package from disk` 选择本目录的 `package.json`，也可以将本目录复制到项目的 `Packages/com.bim-studio.bridge`。

1. 运行 `Deep Monkey Studio/一键构建并导出 WebGL ZIP`。首次使用时，插件会自动创建或修复常驻的 `BimStudioBridge` 对象和 `Assets/Resources/BimStudioManifest.asset`；只在必要时要求保存当前场景，并自动把它加入 Build Settings，不会删除已有场景。
2. 导出前插件会扫描所有已加载场景中的数据、属性、动作和事件组件，自动合并清单、注册稳定业务对象并回填对象 ID。也可随时点击清单中的**从场景自动同步**预览结果。已有的属性类型、标签和选项不会被覆盖。
3. 如果集成清单仍有空标识或配置错误，插件会自动打开清单检查器；重复标识、错误属性类型、无效对象引用等问题会在导出前阻止构建。
4. 插件一次完成 WebGL 构建、生成 `bim-studio.manifest.json`、注入 `unity-bridge.js`，并输出可直接导入的 ZIP。
5. 将 ZIP 拖入 Deep Monkey Studio 的 Unity 组件即可；重复导入相同内容会复用已有版本，不会制造重复资源。平台检查器会展示对象、动作、事件、数据层和属性数量，并可直接测试所选动作与查看 Bridge 状态。

如果团队希望在首次导出前先检查集成配置，仍可使用 `Deep Monkey Studio/准备项目（通信桥与集成清单）`，但它不再是必做步骤。

运行时消息以 UnityEvent 形式暴露在 `BimStudioBridge` 上。`onData` 保留原始绑定值以兼容已有项目；平台变量、仪表盘筛选或绑定数据行变化时，`onDataLayers` 接收集成清单声明的数据层映射。`onAction`、`onScene`、`onProperties` 分别用于对象交互、场景切换和属性输入。Unity 可通过 `BimStudioEvents.Emit` 将选择、告警或自定义业务事件回传平台。

0.5.0 起，Unity 主线程会对每条宿主消息返回 ACK，并响应 5 秒运行心跳；平台检查器展示消息往返耗时、FPS、活动场景和通信降级状态。0.6.0 新增相机、灯光、可选 uGUI 双向绑定和统一脚本控制。0.6.1 将插件包版本写入 manifest；平台导入时会验证 Loader、Framework、WASM 与 Data 是否齐全，并记录 Brotli/Gzip、运行载荷和调试符号证据；导出的播放器还会把 Unity loader 的真实启动进度回传平台，供进度展示、停滞诊断和加载取消使用。旧构建仍可运行，但发布检查会提示其缺少可靠通信或压缩合同。

常见的无代码集成只需在集成清单检查器中选中场景对象，然后点击**添加数据 / 属性绑定**、**添加动作绑定**或**添加事件回传**。各绑定 Inspector 都能就地新建清单标识；动作绑定还能把当前 GameObject 一键注册成稳定业务对象，不必在清单和对象之间反复切换。数据可映射到显示状态、Animator 浮点/布尔/触发器、材质数值/颜色、位置/旋转/缩放、相机视野、灯光启停/强度/颜色/范围/聚光角度或 UnityEvent；事件回传组件的 `Emit()` 可直接连接 Button、Collider、动画事件或任意 UnityEvent。普通显隐、动画、材质、变换、相机、灯光、平台动作和 Unity 事件回传都不需要编写脚本。

项目安装 `com.unity.ugui` 时会自动启用 `BimStudioUGuiBinding` 可选适配器。它覆盖 Text、Slider、Toggle、Dropdown、InputField、Image、CanvasGroup 和 Selectable 的常用属性，并支持 Slider/Toggle/Dropdown/InputField 双向回传；平台回写使用 `SetValueWithoutNotify`，不会形成事件循环。Button 可继续把 `onClick` 直接连接到 `BimStudioEventEmitter.Emit()`。uGUI 只是可选层，不会让核心桥接插件强制依赖 UI 包。

导入平台后，同一份 manifest 同时驱动图形化属性面板和行为脚本 API。脚本通过 `studio.unity("组件ID").setProperty(...)`、`setProperties(...)`、`invoke(...)`、`switchScene(...)` 控制运行时，平台会在发送前校验组件、属性、动作、对象和场景白名单。

导出前插件会同时校验清单和场景中的无代码绑定：空标识、引用未声明的数据层/属性/动作/事件或业务对象都会阻止构建，避免把“能打包但无法联动”的 ZIP 导入平台。

插件基于稳定的 WebGL `SendMessage`/`.jslib` 边界，正式维护 Unity 2022 LTS 和 Unity 6。协议本身不绑定 Unity 版本，但其他版本不在当前本机构建门禁范围内，项目仍应对实际使用的编辑器补丁版本做烟测。

仓库验证命令：`tools/unity/run-bridge-smoke.ps1`。未安装 WebGL Build Support 的编辑器只做插件编译检查，并与真实 WebGL 构建结果分开报告。
