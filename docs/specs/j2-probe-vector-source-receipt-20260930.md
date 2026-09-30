# GI 既有十向量门的源码身份修复

## 现状核查

2026-09-30：已检索 Native/WASM 与 deep-engine/lab 的 probe sampling 消费方、未跟踪文件、probe GI 类型与 ABI、Cargo/package 依赖、既有十向量测试及 B5 规格。现有 Native 向量门已装入 canonical provider 且真实 GPU 十向量通过；不重建算法、输入和阈值。

真实缺口：Chrome 的 Native-family compute 仍只读 raw wrapper，缺少新共享 provider；源码 hash 无法与完整 Native compute 对上。改为 Native receipt 保存实际 compiled compute 文本和三个直接输入 hash（wrapper、canonical kernel、Rust adapter）。Chrome 直接编译该同一文本；读取 receipt 前核对源码闭包与完整文本 SHA。Chrome-only/historical 不计为本次 Native 执行。

验证：原十向量及固定阈值保留；CPU 检验完整源码及输入漂移拒绝，再执行默认双端 fresh 命令。可视化按深色 1920×1080，仅调整展示尺寸，不改数值夹具。

Node 聚焦6测通过（源码receipt1测、既有fresh Native runner5测）。默认 `node scripts/j2-probe-gi-parity.mjs` 实际执行 Native 十向量各两draw与 Chrome 两轮20行，passed/stable/identityMatched均true，双端最大差5.960464477539063e-8。日志 `test-output/interrupted-0930/probe-gi-vector-source-after.log`，实际receipt与两张深色1080截图在 `probe-gi-parity/`。这仅恢复既有有限storage向量门，不关闭完整GI或Gate D。
