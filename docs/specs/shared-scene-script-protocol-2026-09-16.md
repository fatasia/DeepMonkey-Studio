# 共享场景脚本协议

Contracts 持有 Scene API 版本、能力、权限和兼容性判断，SDK 保留原导出并负责运行模块组装。发布预检和纯状态包可以直接依赖 Contracts，避免反向引入运行 SDK。

`resolveSceneScriptProtocolCompatibility` 区分禁用、旧可信运行时、不支持版本、未知能力和未知权限；SDK 的 `resolveSceneBehaviorModule` 使用同一判断，复制生命周期、权限、目标和依赖，隔离作者对象后续变动。

已完成：六个文件组成的独立 HEAD 导出通过 Contracts 构建、SDK 类型检查和 88 项测试；版本及两份有序能力/权限数组与 HEAD 完全相同。证据位于本机 `test-output/protocol-head-validation/`。

本切片只提交协议基础和 SDK 适配器。当前工作树中 studio-core 的发布预检已改用 Contracts 并通过测试，其完整应用发布依赖随对应功能切片提交。
