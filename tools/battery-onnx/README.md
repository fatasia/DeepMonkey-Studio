# 电池 ONNX 候选验证

该工具从“分子元宇宙”源工程读取正式 checkpoint，只把候选 ONNX 与可复核报告写入指定输出目录，不复制训练工程或大模型权重。

```powershell
& 'D:\Documents\New project 3\battery-model-service\.venv-models\Scripts\python.exe' `
  tools\battery-onnx\export_primary_candidates.py `
  --source-root 'D:\Documents\New project 3\battery-model-service' `
  --output-root test-output\battery-onnx
```

脚本会在导入 NumPy、Torch 和 ONNX Runtime 前自动注册 Torch 原生 DLL 目录，Windows 干净进程无需额外修改 `PATH`；若使用自定义 Python 环境，请确认该环境能发现源工程的 Torch 安装。

当前脚本验证三个正式主模型的 FP32 Tensor Contract：

| 模型 | 合同 | 当前候选体积 |
| --- | --- | ---: |
| BMSFormer | `20 × 6` 健康窗口 → SOH | 约 196 KiB |
| SOCFormer | `16 × 7` 序列窗口 → SOC | 约 130 KiB |
| BatteryMFormer | 曲线、掩码、工况嵌入、SOH、循环特征 → 5000 点 SOH/RUL 轨迹 | 约 34.4 MiB |

每个候选现在同时生成 `*.runtime-adapter.json`。BMSFormer/SOCFormer 适配器只包含正式特征统计与置信门槛；BatteryMFormer 额外把原 Python pickle 转成约 4.6 MiB 的连续 little-endian Float32 工况包及索引，API 无需加载训练工程或 pickle。模型、适配器和工况包都按需加载，均不进入 Web 首屏。

可用 `--model battery.bmsformer`、`--model battery.socformer` 或 `--model battery.batterymformer` 单独验证。BatteryMFormer 制品只用于服务端 Worker/插件制品库，不进入 Web 首屏。

`candidate-report.json` 现在除了张量层比较，还会默认回放源工程的 TEMPEST 280Ah/700 循环外部实测、工程 LFP 和工程 NMC 三套记录，复用前处理并按正式适配器逻辑回放业务后处理：

- BMSFormer 对比 SOH 与预测容量；
- SOCFormer 对比累计容量物理锚混合后的 SOC 序列；
- BatteryMFormer 对比 5000 点 SOH 轨迹与 80% 阈值 RUL。

可以重复使用 `--record-file` 指定多个同合同 CSV。导出器还会生成合同同构的 `candidate-manifests.json`，但其中批准状态固定为 `candidate`、独立数据集和外部锁箱固定为未完成，生产加载器会明确拒绝。只有补齐正式独立测试分割、更多化学体系外部锁箱、域外策略、异常业务输入和人工签署后，才能生成生产版 `BatteryOnnxEquivalenceManifest`。

三模型 Node 前后处理与 `onnxruntime-node` 运行时已经接入。正式部署必须显式设置：

```text
BATTERY_ONNX_MANIFEST_FILE=<生产批准清单 JSON>
BATTERY_ONNX_ARTIFACT_ROOT=<ONNX、runtime-adapter 与工况包目录>
BATTERY_ONNX_MODELS=bmsformer,socformer,batterymformer
```

API 启动时会验证清单、模型、适配器及 BatteryMFormer 工况包的目录边界、体积和 SHA-256；任一不一致都会阻止 ONNX 启用。未配置时保持 Python 正式主输出；ONNX 加载、推理或输出合同失败时自动回退 Python。PINN/PINO/TwinMoE 始终保持原 Python 影子链，不受正式主模型运行时切换影响。

候选导出完成后，可用真实 `onnxruntime-node` 再跑一次三个 Node 产品适配器：

```powershell
pnpm verify:battery-onnx-candidates -- `
  --artifact-root test-output/battery-onnx `
  --record-file 'D:\Documents\New project 3\public\samples\multiscale-battery-assessment-engineering-lfp-demo.csv'
```

该命令会生成 `candidate-node-runtime-report.json`，验证实际五输入/窗口 ONNX 会话、产品前后处理、输出形状与有限值。报告明确标记 `productionApproved: false`；工具构造的候选身份只存在于当前进程，不能被 API 的正式清单加载器接受。
