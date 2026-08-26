# 转换插件合同与真实格式支持

## 定位

模型导入仍以现有资源库为入口。`ConverterPlugin` 是 M5 新增的轻量扩展边界，用于把需要原生 SDK、许可证或独立进程的格式移出 API 主进程；它不是一套新的重型 CAD 平台。

插件清单必须声明版本、输入格式、结构化输出、运行位置、最小权限与资源上限。任务只允许读取当前项目的输入对象，并将产物写入 `projects/{projectId}/conversions/{taskId}/output/`。同一输入哈希、插件版本和配置后续可作为确定性缓存键。

## 当前真实支持

| 输入 | 当前处理方式 | 运行时产物/查看方式 | 真实状态 |
| --- | --- | --- | --- |
| IFC | 保留源文件 | 浏览器转 Fragments | 可用 |
| glTF | 保留源文件 | Three.js glTF 查看 | 可用 |
| GLB | 服务端优化并按规模生成 LOD | 优化 GLB | 可用 |
| FBX | 保留源文件 | Three.js FBX 查看 | 可用 |
| DXF | 保留源文件 | 二维 DXF 查看 | 可用 |
| STEP / STP | `occt-import-js` 解析与三角化 | GLB + hierarchy.json + properties.json | 可用 |
| DWG | 外部 LibreDWG 命令 | DXF | 配置转换器后可用，否则 `waiting_converter` |
| RVT | Windows Revit Agent / Revit Add-in | IFC 或原生 GLB，可带层级与属性 | 配置转换器且存在兼容 Revit 后可用 |

因此不能表述为“所有格式都会转为 GLB”。直接查看格式继续保留源格式；需要三角化或原生宿主导出的格式才优先生成 GLB。

## M5 任务 API

- `GET /api/converters`：查询插件清单和当前可用性。
- `POST /api/projects/{projectId}/conversion-tasks`：提交任务。
- `GET /api/projects/{projectId}/conversion-tasks`：查询项目任务列表。
- `GET /api/projects/{projectId}/conversion-tasks/{taskId}`：查询任务。
- `POST /api/projects/{projectId}/conversion-tasks/{taskId}/cancel`：取消任务。

状态机为：

```text
queued -> running -> succeeded
   |         |  \-> failed
   |         \-> cancelling -> cancelled
   \-> waiting_converter -> cancelled
```

Parasolid x_t/x_b 与 JT 已按产品范围决策移除，不进入格式目录、上传入口或转换任务状态机。

## 当前纵向切片边界

- 已完成合同、插件目录、受控状态迁移、提交/列表/查询/取消 API、AbortSignal 取消、进度与产物约束测试。
- 新任务目前保存在 API 进程内存中；持久化、重试、超时执行器、内容哈希缓存、日志对象和失败产物清理仍属于 M5 后续实现。
