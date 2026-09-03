# Industrial Studio Revit Agent

该 Agent 使用已安装的 Autodesk Revit 将 RVT 导出为 IFC 或 FBX，不解析 RVT 二进制。生产主链建议使用 Leia 派生插件输出 `geometry.glb`。

## 依赖

1. Windows 转换机安装合法授权的 Revit（建议 2024–2026）。
2. 安装 [Revit Batch Processor](https://github.com/bvn-architecture/RevitBatchProcessor)。
3. 安装与 Revit 版本匹配的最新版 Autodesk IFC Exporter。

## 配置

在项目根目录 `.env` 或系统环境变量中设置：

```text
REVIT_BATCH_PROCESSOR_PATH=C:\Users\name\AppData\Local\RevitBatchProcessor\BatchRvt.exe
RVT_CONVERTER_COMMAND=node
RVT_CONVERTER_ARGS=["tools/revit-agent/agent.mjs","--input","{input}","--output","{output}"]
```

Agent 每次只处理一个模型，使用 Detach 模式打开工作共享文件。内置目标通过 `RVT_EXPORT_FORMAT=ifc|fbx` 设置，默认生成 `model.ifc`；设置为 `fbx` 时生成 `model.fbx`。

API 会按以下顺序识别转换产物：

1. `geometry.glb`（Leia 派生无界面插件，推荐）
2. `model.glb`
3. `model.ifc`
4. `model.fbx`

因此 Leia Worker 只需遵循 `--input`、`--output` 参数约定，并在输出目录写入 `geometry.glb`；如果另外输出 `hierarchy.json` 和 `properties.json`，API 会自动写入模型清单。生产环境建议为不同 Revit 大版本配置独立转换节点。

## 限制

- 运行机器必须安装能打开源 RVT 的 Revit 版本。
- 新版本 RVT 不能交给旧版 Revit。
- Revit 弹窗和损坏模型可能让任务失败，失败信息会保留在转换任务中。
- Revit Batch Processor 是 GPL-3.0；本项目通过独立进程调用，没有复制其源码。部署前应由公司确认第三方软件许可。
