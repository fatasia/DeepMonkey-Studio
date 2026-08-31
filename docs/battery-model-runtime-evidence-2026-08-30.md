# 电池模型真实运行与治理证据（2026-08-30）

## 1. 结论与声明边界

本次验证证明三条正式 Python 模型链、产品能力网关、PINN 影子请求、PINO 域外回退和发布目录可在本机真实运行。它不等于 ONNX 已获生产批准，也不等于性能、长稳、实体 HIL 或实车门禁通过。

- 正式主模型：BMSFormer、SOCFormer、BatteryMFormer standard。
- 孪生主轨迹：确定性电热工程基线。
- 正常影子链：BatteryMFormer PINN、SPM-PINO、TwinMoE，生产流量均为 0。
- 安全回退：域外或高风险时跳过神经路由，由 SPM 守恒求解接管。
- ONNX：三个制品均为 `candidate`，产品部署保持关闭，Python 仍是正式运行时。

## 2. 真实服务冒烟

使用源工程已有 `.venv-models` 和 Uvicorn，在独立端口 `127.0.0.1:18031` 启动电池服务；产品 API 使用隔离数据目录在 `127.0.0.1:14101` 启动，并通过 `BATTERY_MODEL_SERVICE_URL` 接入该服务。验证结束后两个进程均已终止，两个端口均无监听。

`GET /health` 返回 `ok=true`，并解析到三个实际 checkpoint：

| 模型 | Ready | 实际 checkpoint |
|---|---:|---|
| BMSFormer | 是 | `models/bmsformer-batterylife-expanded.pt` |
| SOCFormer | 是 | `models/socformer-batterylife-expanded.pt` |
| BatteryMFormer | 是 | `checkpoints/batterymformer-expanded` |

使用工程 LFP 业务记录完成真实 HTTP 推理：

| 模型 | 输入 | 结果摘要 | 单次耗时 |
|---|---:|---|---:|
| BMSFormer | 9391 条 | `currentSoh=98.728`，`high` | 2148 ms |
| SOCFormer | 首圈 93 条 | `finalSoc=0.024`，93 个输出点，`high` | 116 ms |
| BatteryMFormer | 9391 条 | `predictedCycleLife=2657`，200 个轨迹点，`medium` | 1615 ms |

上述时间混合了请求序列中的冷启动与热运行，只证明“能够完成真实请求”，不能作为吞吐、P95/P99、Unity/客户端对比或硬件选型依据。

产品 `battery.model.predict` 能力也完成了端到端请求。SOCFormer 证据记录为：

- `actualRuntime=python-service`、`routingPolicy=primary-python`、`fellBack=false`；
- 输入域 `supported`，信号覆盖率 1，非法值和物理范围越界均为 0；
- 生成独立 `traceId`、稳定的 SHA-256 `inputFingerprint` 和目录指纹；
- 业务结果与推理证据的置信度均为 `high`。

## 3. 正式、影子与回退边界

产品目录接口真实返回 8 项运行能力：三个正式主模型与电热基线拥有主输出权；PINN、PINO、TwinMoE 为 `advisory` 且生产流量为 0；SPM 为 `fallback`。

源服务 `release/status` 返回：

- `status=shadow-only`、`productionOutputEnabled=false`、`productionTrafficPercent=0`；
- `decision=NO-GO; remain shadow-only`；
- 自动回滚目标为 `physical SOC + SPM + manual risk review`；
- 实体 HIL 和真实车队条件不可用，不能由 SIL/V-HIL 或公开数据回放替代。

本次同时验证：

- BatteryMFormer `variant=physics` 实际由 PINN checkpoint 执行，服务返回版本 `batterymformer-spm-pinn-v9-fieldcal-seed7181`；该结果仍为影子建议。
- PINO checkpoint 就绪且研究门禁通过，但 `productionOverride=false`。
- 30 分钟工况超过 PINO 当前 10 分钟验证域后，PINO 被跳过，`spm-conservation-solver` 接管，`fallbackActivated=true`、`adoptedAsPrimary=false`。
- 多电芯输入返回 HTTP 422 和 `multiple_cells_not_supported`，没有进入推理。
- 产品 HTTP transport 在 1 ms 测试预算下返回明确的“电池模型服务超时”，不会把超时伪装成模型结果。

## 4. ONNX 候选清单与合同

独立导出目录 `test-output/battery-onnx-audit-current` 含三个候选 ONNX、三个哈希化运行适配器、BatteryMFormer 工况嵌入、候选报告和 Node 运行报告。清单身份如下：

| 模型 | 模型版本 | 输入合同 | 输出合同 | 前处理 / 后处理 |
|---|---|---|---|---|
| BMSFormer | `bmsformer-li-multichem-v2` | `bmsformer-normalized-health-window-v1` | `soh-fraction-v1` | `bmsformer-health-window-v1` / `bmsformer-soh-product-v1` |
| SOCFormer | `socformer-li-hybrid-v2` | `socformer-normalized-sequence-window-v1` | `soc-fraction-v1` | `socformer-sequence-anchor-v1` / `socformer-hybrid-soc-product-v1` |
| BatteryMFormer | `batterymformer-expanded` | `batterymformer-early-cycle-multimodal-v1` | `soh-trajectory-and-rul-v1` | `batterymformer-multimodal-v1` / `batterymformer-rul-product-v1` |

候选身份指纹：

| 模型 | checkpoint SHA-256 | ONNX SHA-256 | runtime adapter SHA-256 |
|---|---|---|---|
| BMSFormer | `129f84739cb4dd8d016c1659c598e5433be62f7cfc04c651f361510febc7f4ca` | `71a730c4b31e997f2d47ef05269e04f956705a984e408065a1a0e08282db1a13` | `06849ecdc8163d43657a0e6d085648ceb05ceb729b9135ae1df63259a38198d8` |
| SOCFormer | `9e8cf6e75ae0f94be95740414d8e35b47b5e52f982049c5e8e5a1dc95e7891ad` | `14b824392efb9809a0d6cba753da2f12f0fb2ba0186ca0cf7c3c2555cd8a18df` | `fcaa92d9b580be90da45ef377525f25d35e6441595e0f2d05bf9d6d5e005a287` |
| BatteryMFormer | `5a02f88b51ee06f386ad7a2672b1ec2d7bf16528fc9ba0336a1e70ed43eae1e8` | `725e40fb0065d169d7906712ff4a17077345d02403180b59f2f1384bd386da74` | `94d1d830d7fb4fda65cacde2688a11bec28d10768491945257c92857c5b6da1d` |

三个候选的边界、域外、非法输入、5 次重复运行和各 3 次业务回放均通过；Node 产品运行时也能加载并完成三模型请求。但每份清单仍明确记录：

- `decisionStatus=candidate`；
- `independentDatasetSplit=false`；
- `externalLockboxCases=0`；
- 没有 `approvedBy`、`approvedAt` 或批准证据指纹。

因此产品发布接口返回 `onnxMigration.ready=false`，且未配置 `BATTERY_ONNX_MANIFEST_FILE` 时保持 Python 正式主输出。清单中非空但错误的合同版本现在也会被拒绝，不能仅靠字符串存在绕过运行合同。

## 5. 已修复的证据缺口

1. Python 服务使用 `{ model, variant, result }` 信封，原证据层只读取顶层 `confidence`，导致业务结果为 `high` 而审计记录为 `unknown`。现已同时支持 Python 信封与 ONNX 直接结果，并完成真实 API 复验。
2. ONNX 清单原先只验证合同版本非空。现已按模型固定验证输入、输出、前处理和后处理四个版本，错误版本不能进入生产资格评估。

这些修复只增强证据一致性和发布失败关闭，不改变模型算法、输出权限或批准状态。

## 6. 仍未闭合的治理项

| 缺口 | 当前影响 | 闭合条件 |
|---|---|---|
| 正式独立数据切分与外部锁箱缺失 | ONNX 只能是候选 | 独立执行、记录样本范围和结果，并由发布责任人签署 |
| Python 实际 checkpoint 哈希未随单次推理返回 | Python 证据只能追到目录版本/指纹，不能证明本次进程加载的具体文件字节 | 源服务在加载 checkpoint 后计算并返回只读 SHA-256，产品网关校验它与目录登记一致 |
| 缺少候选制品包的聚合指纹 | 单文件可校验，但整包替换/缺件没有一个统一身份 | 对清单、ONNX、适配器和工况包生成确定性 bundle fingerprint |
| 回退已实测但没有签署的回滚演练记录 | 能证明功能回退，不能证明发布过程的恢复时间和责任闭环 | 记录演练 ID、触发条件、原/目标版本、恢复耗时、结果哈希和审批人 |
| 无长稳、并发、进程崩溃恢复和资源水位证据 | 不能声明工业长稳或性能门槛通过 | 在目标部署硬件上执行 soak、故障注入、内存/句柄泄漏和 P95/P99 基准 |
| 无实体 HIL 与实车车队 | 影子专家不能获得生产控制权 | 客户硬件、真实车辆/电池和独立验收签署 |

## 7. 可复核入口

- 服务访问日志：`test-output/battery-service-smoke-current/service.stdout.log`
- 服务启动告警：`test-output/battery-service-smoke-current/service.stderr.log`
- ONNX 候选清单：`test-output/battery-onnx-audit-current/candidate-manifests.json`
- ONNX 张量/边界/业务回放：`test-output/battery-onnx-audit-current/candidate-report.json`
- Node 候选运行：`test-output/battery-onnx-audit-current/candidate-node-runtime-report.json`
- 发布与运行目录：`packages/contracts/src/battery.ts`
- 推理证据：`apps/api/src/batteryInferenceGovernance.ts`
- 发布制品校验：`apps/api/src/batteryOnnxDeployment.ts`

本轮验证通过 API 全量测试、Contracts 全量测试、相关类型检查和单文件 800 行门禁。测试输出目录是本地审计制品，不进入生产安装包。
