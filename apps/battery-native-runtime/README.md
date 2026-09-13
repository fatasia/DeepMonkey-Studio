# Battery native runtime

Rust 服务直接加载两个独立 ONNX 包：

- `batterymformer-spm-pinn.fp32.opset18.onnx`：BatteryMFormer SPM-PINN 寿命物理专家；
- `spm-pino-v13-6-native-v10-guard.onnx`：SPM-PINO 多物理神经算子，配合 TwinMoE 风险路由与 SPM 域外回退。

制品、运行适配器与 BatteryLife 工况嵌入均位于 `models/`。产品运行时不依赖 Python、PyTorch、原 checkpoint 或原模型项目。

```powershell
$env:BATTERY_NATIVE_MODEL_ROOT="$PWD/apps/battery-native-runtime/models"
cargo run --manifest-path apps/battery-native-runtime/Cargo.toml
```

本地工作台启动器默认管理该进程，并把 `BATTERY_MODEL_SERVICE_URL=http://127.0.0.1:8030` 传给 API。两个 Python 脚本只用于离线重建制品，不进入产品运行链：

- `tools/battery-native/export_pino_onnx.py`
- `tools/battery-native/export_pinn_onnx.py`

PINN 导出器同时生成 manifest，记录 checkpoint、置信门、ONNX、适配器和嵌入包哈希，并执行 PyTorch/ONNX Runtime 数值对齐。

## 数字孪生运行合同

`/research/digital-twin/*` 已原生承接源项目中可用于在线运行的核心能力：

- 在线 SOC / SOH / 温度状态同化；
- 10 分钟内 SPM-PINO 多物理短时推演，按 TwinMoE 风险收益选择正式轨迹，域外由 SPM 守恒模型接管；
- 仅接纳相似度不低于 0.70、验证收益不低于 2% 的迁移校准，并限制电压与 SOC 修正幅度；
- CLF-CBF 影子安全投影，不直接下发控制指令；
- 保存场景摘要、路由、域判断、校准轨迹、安全投影和运行计数用于证据回放。

SPM-PINO 的已验证范围为 LFP、0.25–10 分钟、±1.8C、10–45°C、初始 SOC 20–85%。单次请求可包含多段工况，但总时长不超过 120 分钟；超过 10 分钟的预测会被明确标记为域外，而不是伪装成域内神经算子结果。
