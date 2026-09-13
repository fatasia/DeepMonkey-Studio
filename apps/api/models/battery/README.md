# 项目内置电池验证模型

这组自包含资产由本仓 2026-08-30 的 ONNX 等价转换结果迁入，运行不依赖源训练工程、Python 服务或外部项目目录。来源与每个制品的 SHA-256、checkpoint 身份、输入输出合同见 `candidate-manifests.json`，运行时逐个校验模型、适配器与工况嵌入。

三个 CPU 模型：BMSFormer（SOH）、SOCFormer（SOC）、BatteryMFormer（RUL）。仅服务端按需加载，不进入 Web 静态包。源码与编译后的 API 均从 `apps/api/models/battery` 定位，部署 API 时需携带整个 `models` 目录。

批准状态仍为 `candidate`，独立生产审批未完成。API 默认执行真实本地验证推理，输出 `productionApproved:false` 和 advisory 证据，不提升为生产批准，也不会静默调用 localhost:8030。

已有正式批准清单可通过 `BATTERY_ONNX_MANIFEST_FILE` 显式配置；历史外置服务只在显式配置 `BATTERY_MODEL_SERVICE_URL` 后启用。PINN/PINO/TwinMoE 不在此模型包内，默认能力目录不提供其运行入口。
