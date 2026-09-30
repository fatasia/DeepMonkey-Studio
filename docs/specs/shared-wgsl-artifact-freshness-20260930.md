# 共享 WGSL 的 WASM 构建指纹

## 现状核查

2026-09-30：已检索 Native/WASM 源码、未跟踪文件和 scripts 的 include_str!/include_bytes! 与 wasmSourceFingerprint 消费方；检查 contracts、WASM Cargo 依赖、已有指纹测试、工业格式权威计划及当前任务清单。

- 已有（不重建）：build-wasm-bundle 与 check-runtime-artifact-freshness 共用脚本内 SHA-256 指纹；Rust 源树、Native assets、Cargo 与构建脚本已入指纹。WASM 依赖 Native；不需要新合同或依赖。
- 真实缺口：Native 直接包含 packages/deep-engine/wgsl 的 BRDF、GI、CSM、输出、Fog、Bloom 单源文件，但现有指纹漏掉跨包输入。只改共享核时可能错误接受旧 WASM。
- 补法：从已有 Rust 输入中收集字面量 include 的 canonical WGSL 文件，去重并沿用路径与字节哈希。未消费的相邻 WGSL 不触发重建；缺少实际输入直接报错。范围限现有 canonical 目录，不新增依赖扫描框架。

## 验证

预登记：已有 Rust/assets 变化门保留；验证跨包 WGSL 变化使指纹失效、重复 include 只计一次、未使用文件变化不影响指纹、缺少已包含文件拒绝。通过聚焦 Node 测试后执行一次产品 WASM 构建与运行产物新鲜度门。

聚焦 Node 门通过，当前输入723文件；一次 wasm-release/Oz 产品构建成功，WASM raw 5217.5 KB、WASM+JS Brotli 1488.5 KB。日志 `test-output/interrupted-0930/shared-wgsl-wasm-build.log`。全运行产物门等待本轮 Browser hydration 源码冻结后统一 engine/Web 构建，不把单独 WASM 构建计为全门通过。
