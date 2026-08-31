# Virtual commissioning plugin

本包只承载虚拟调试的确定性领域逻辑，不包含 Three.js、React、现场协议或设备写入。

## 运行边界

- `runVirtualDebugScenario`：固定时间步执行控制命令、故障注入和断言，生成可回放轨迹与 SHA-256 证据指纹。
- `createVirtualDebugProvider`：将内核包装为 `@bim-studio/plugin-runtime` 能力 provider，可放入 Web Worker 或 Node Worker。
- 故障默认锁存，只有 `reset` 命令可以清除；这与现场联锁调试更接近，也避免测试误报“自动恢复”。

3D 层只消费轨迹进行对象高亮和时间回放，不在渲染循环中执行控制逻辑。
