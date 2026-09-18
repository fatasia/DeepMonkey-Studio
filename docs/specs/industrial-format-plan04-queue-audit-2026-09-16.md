# industrial-3d-format-work-plan PLAN-04 审计:统一任务通道现状

日期:2026-09-16。对应 [工业三维格式接入工作计划](industrial-3d-format-work-plan-2026-09-16.md) PLAN-04「统一上传队列与 ConversionTaskService(API/上传/MCP/SDK 同一任务 ID)」的首批代码审计。本批只审计不改代码:统一属于跨模块架构改动,按仓库纪律需用户批准后实施。

## 现状:两套并行任务系统

| | `ConversionQueue`(conversion.ts,legacy) | `ConversionTaskService`(conversionTasks.ts,新) |
|---|---|---|
| 身份 | 无独立任务 ID;以 model 记录为上下文(`ConversionContext{model,sourcePath,modelDir}`),状态挂在 model 元数据上 | 独立 `randomUUID` 任务 ID,`ConversionTaskRecord{id,projectId,pluginId,...}` |
| 入口 | 资产库上传(`assetLibraryRoutes.ts` enqueue) | REST `/api/projects/:id/conversion-tasks`(submit/get/list/cancel) |
| 提供者 | 按 ModelFormat 硬编码 Provider 表(Direct/PreciseCad/Command/Missing,含 IFC/GLB/STEP/DWG 等 15+ 格式) | 插件注册表(`ConverterPluginRegistration`,manifest 声明 inputFormats/limits),格式归一 `normalizeFormat` |
| 取消/恢复 | 无 per-task cancel token;队列串行 running 标志 | AbortController per task;queued/cancelling/cancelled/terminal 状态机;等待转换器时 `waiting_converter` |

## 缺口清单(PLAN-04 验收口径)

1. **任务 ID 不统一**:资产库上传转换没有可查询的任务 ID;前端/MCP/SDK 无法用同一 ID 追踪两条通道的进度。
2. **Provider 双轨**:新 Service 的插件注册表与 legacy Provider 表并存,同一格式(如 GLB/IFC)可能走不同执行体,预算/诊断口径不同。
3. **MCP/SDK 面**:conversionTaskRoutes 只覆盖 REST;MCP 工具面与 SDK 尚未以同一 task ID 暴露(需在统一后一次接线)。
4. **持久化**:ConversionTaskService 任务在内存 Map,进程重启即失;legacy 挂元数据可持久。统一时需决定权威存储(倾向 Service 记录入 MetadataStore)。

## 统一方案建议(待批准后实施)

- 以 `ConversionTaskService` 为唯一权威:Plugin manifest 覆盖 legacy Provider 表的格式能力声明;legacy Provider 逐个改写为插件 Registration(execute 适配现有 Provider)。
- 资产库上传改为先 `service.submit` 再把返回 task.id 写入 model 元数据(上传响应携带 conversionTaskId),保留现有对象存储拓扑不变。
- MCP/SDK 在 REST 合同之上做薄暴露,不新增第二套状态机。
- 迁移期兼容:旧 model 元数据状态只读渲染,不再接受新任务。

## 完成条件对照

- [ ] 同一任务 ID 贯通 API/上传/MCP/SDK(本审计为前置事实,未实施)
- [x] 通道现状与缺口以文档固化(本文件)
- [ ] 统一实施 + 迁移测试(依赖用户对跨模块重构的批准)
