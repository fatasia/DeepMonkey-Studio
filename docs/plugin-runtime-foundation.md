# M6 插件平台基础

## 定位

`@bim-studio/plugin-runtime` 是编辑器、场景与资源转换共享的轻量插件合同和生命周期内核。它解决四件事：

1. 用版本化、可序列化的 `PluginManifestV1` 声明插件要求。
2. 在启用前协商 API、宿主、扩展点、能力与权限。
3. 注册、启用、禁用和卸载宿主已经安装的插件工厂。
4. 把单个插件的启动/清理异常收敛为诊断结果，不让异常中断其他插件。

它不是插件商店、下载器、签名验证器或通用代码沙箱。

## 首批扩展点

| 扩展点 | 用途 | 本阶段边界 |
| --- | --- | --- |
| `editor.panel` | 在编辑器左、右、底部或模态区域注册工具面板 | 只定义稳定声明；具体 React 面板由编辑器 Host Adapter 注册 |
| `scene.extension` | 挂接 Scene SDK 行为、控制器和渲染扩展 | 复用 Scene SDK 的 host/renderer/capability/permission 协商 |
| `converter.plugin` | 声明输入格式、输出格式、执行位置和资源预算 | 只声明转换能力；不表示转换器已安装或格式可成功转换 |

ConverterPlugin 只允许 `server-worker` 或 `tauri-sidecar` 执行，必须声明超时、最大输入和内存预算。浏览器主线程不作为原生转换器执行位置。

## 示例清单

```ts
const manifest: PluginManifestV1 = {
  schemaVersion: 1,
  id: "acme.factory-tools",
  name: "Factory tools",
  version: "2.1.0",
  apiVersion: "1.0",
  hosts: ["browser", "tauri"],
  capabilities: ["studio.object", "converter.execute"],
  permissions: ["scene.read", "scene.write"],
  extensionPoints: [
    {
      kind: "editor.panel",
      id: "acme.factory-panel",
      title: "Factory",
      placement: "right"
    },
    {
      kind: "converter.plugin",
      id: "acme.xt-converter",
      inputExtensions: ["x_t", "x_b"],
      inputMediaTypes: ["model/vnd.parasolid.transmit.text"],
      outputFormat: "glb",
      outputMediaType: "model/gltf-binary",
      execution: "server-worker",
      limits: {
        timeoutMs: 600_000,
        maxInputBytes: 2_147_483_648,
        memoryMb: 4096
      }
    }
  ]
};
```

清单没有下载 URL、脚本源码或远程模块入口。`PluginRegistry.register()` 只接受 Host 已经解析和安装好的 `InstalledPluginFactory`，因此注册动作不会隐式下载或执行远程代码。

## 生命周期与故障隔离

```text
registered -> enabling -> enabled -> disabling -> registered
                  |                       |
                  +------ faulted <-------+
```

- 注册和每次启用前都会执行兼容协商，不能凭一次注册绕过授权。
- 激活上下文只提供清单中已授权的 capability/permission 和 `AbortSignal`。
- 激活或清理异常变成 `activation-failed` / `deactivation-failed` 结果与最多 50 条诊断，不向批量启用流程抛出。
- 卸载时即使清理失败也会移除注册项，并返回 warning，避免损坏插件永久卡住管理界面。
- `enableAll()` 隔离每个插件的结果，一个插件失败不会阻断其他插件。

## 兼容规则

- `schemaVersion` 当前固定为 `1`。
- 插件 API 使用 `major.minor`：major 必须相同，Host minor 必须不低于插件 minor。Host 的 `sceneApiVersion` 独立协商 Scene SDK，避免平台插件 API 与场景 API 被错误绑定。
- 插件版本使用语义化 `major.minor.patch`。
- 宿主、扩展点、capability 和 permission 必须全部满足，缺失项排序后返回，便于 UI 稳定展示和自动化测试。
- `scene.extension` 继续执行 Scene SDK 自己的 API、renderer、trusted execution、capability 和 permission 协商，不把 Scene 权限与 Converter 权限混为一套实现。

## 明确未完成

当前切片没有实现以下能力，产品和文档不得提前标记为已完成：

- 插件包签名、证书链、制品哈希和可信发布者策略。
- 插件商店、制品下载、依赖解析、升级回滚与离线缓存。
- Worker、进程、容器或 Tauri sidecar 的安全沙箱与资源强制执行。
- Editor Panel Host Adapter、Scene Extension Loader 和 Converter Worker Adapter 的实际接线。
- 插件数据迁移、配置 UI、审计日志和管理员审批流。

后续 Host Adapter 必须保持“清单协商 → 用户/管理员授权 → 隔离加载 → 可观测运行 → 可清理卸载”的顺序，不允许直接把远程模块交给动态 `import()` 或主线程 `eval`。
