# Deep Monkey Studio Revit Worker

这是 Deep Monkey Studio 自研的 C# Revit 转换宿主，由两个部分组成：

- `BimStudio.RevitWorker.exe`：API 启动的轻量命令行客户端，负责投递任务并等待结果。
- `BimStudio.RevitAddin.dll`：加载到 Revit 中的常驻 Add-in，负责打开 RVT 并导出原生 GLB 或 IFC。

## 安装

标准目录安装的 Revit 会被自动发现；非标准目录可在仓库根目录的 `.env` 按年份配置，例如 `REVIT_2023_PATH`、`REVIT_2026_PATH`。然后执行：

```powershell
pnpm revit:install
```

脚本会：

1. 将 Worker 发布到 `tools/revit-worker/publish`。
2. 自动扫描并针对本机已安装的 Revit 2019 及以上版本分别编译 Add-in。
3. 把 Add-in 安装到 `%APPDATA%\Autodesk\Revit\Addins\<版本>`。
4. 创建或复用当前用户的 `Deep Monkey Studio Internal` 代码签名证书，签署 Add-in，并将证书加入当前用户的受信任根与受信任发布者，避免无人值守启动停在插件安全确认框。

安装或更新 Add-in 后，需要重启已经打开的 Revit。

## 工作方式

API 调用 Worker 时传入 `--mode native-glb` 或 `--mode ifc`。如果指定版本的 Revit 尚未就绪，Worker 会启动它并等待 Add-in 心跳；之后任务通过以下目录交换：

上传界面可以选择具体 Revit 版本，也可以使用“自动匹配”。自动匹配先通过 Revit API 读取 RVT 的保存版本，再选择能够打开它的最低已安装版本。例如 Revit 2019 文件在已安装 2023 与 2026 时会选择 2023；较新版本的文件不会被分配给较旧的 Revit。选择结果随模型任务保存，不受后续全局配置变化影响。

```text
%LOCALAPPDATA%\BimStudio\RevitWorker\<版本>\
  ready.json
  jobs\
  results\
```

Revit 在每个作业结束后关闭当前模型，但保持应用进程运行，下一项任务可以直接复用。每个 Revit 版本同一时间只处理一个作业。

Add-in 使用后台定时器维护心跳并检查作业文件；发现任务后通过 Revit `ExternalEvent` 唤醒主线程执行转换。因此 Revit 即使长时间停留在主页，后续任务也不需要用户操作或重新启动进程。异常中断留下的 `.processing.json` 会在下次 Add-in 启动时重新排队。

## 输出

- `native-glb`：`geometry.glb`、`hierarchy.json`、`properties.json`，以及两个 JSON 的预压缩 `.gz` 文件
- `ifc`：`model.ifc`

原生链路采用分离式数据结构：

- `geometry.glb` 保存几何、材质和构件稳定标识；API 发布前会进行去重、焊接和 Draco 压缩。
- `hierarchy.json` 保存模型、楼层、类别、构件四级结构。
- `properties.json` 使用规范化 schema v2，保存项目信息、ElementId、UniqueId、类别、族、类型、楼层、工作集、阶段、宿主/组/装配/设计选项关系、材质，以及全部可读取的实例参数和类型参数。类型与材质只存一份，再由构件 ID 引用，避免大量重复。
- 浏览器请求属性或层级 JSON 时，API 优先返回对应 `.gz`，不支持 gzip 的客户端仍可读取原始 JSON。

GLB 压缩默认启用；排查兼容问题时可在 API 环境中设置 `RVT_GLB_DRACO=false` 临时关闭。IFC 链路由浏览器端 That Open Components 转换为 Fragments。

## 手动检查

```powershell
.\tools\revit-worker\publish\BimStudio.RevitWorker.exe `
  --input D:\Models\sample.rvt `
  --output D:\Models\output `
  --mode native-glb `
  --revit-version 2026
```

若 Worker 提示 Add-in 没有就绪，检查 Revit 是否完成许可登录、Add-in 是否被禁用，以及 `%APPDATA%\Autodesk\Revit\Addins\<版本>` 下的清单与 DLL 是否存在。

第一次安装内部签名证书时，Windows 可能要求确认将 `Deep Monkey Studio Internal` 加入当前用户的受信任根。若机器上还安装了未签名的 Revit Batch Processor，它自己的安全确认框也会阻塞 Revit；本方案不再依赖 RBP，可以把 `BatchRvtAddin<版本>.addin` 移到 Addins 目录下的 `Disabled` 文件夹，需要恢复 RBP 时再移回。

## 商业使用说明

Worker 和 Add-in 是本项目自研代码，但运行时调用 Autodesk Revit API，因此转换机仍需具备合法的 Revit 授权。该方案没有引入 ODA、xeoRVT 或 Revit Batch Processor 运行依赖。
