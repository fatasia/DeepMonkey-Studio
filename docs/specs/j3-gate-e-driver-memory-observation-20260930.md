# Gate E 的 Windows 驱动显存观测

## 现状核查

2026-09-30：检索 packages/apps、scripts 和未跟踪文件的 GPU memory/恢复/进程采样；检查 contracts 与 DeviceSession resourceMemory、Native cache metrics；依赖使用已有 Windows PerformanceCounter 和 Node，无新包；消费方已有 paired-summary 与 attach 型 process-tree sampler；检查既有恢复实帧与采样脚本，读取 Gate E 设备/窗口/retry 规格、交接和估时。

- 已有（不重建）：单进程与进程树 Windows 采样、Web GPU 所有权账本、Native cache 字节、真实设备恢复门。账本不等于驱动显存。
- 真实缺口：tree sampler 对计数器名使用完整相等 `pid_<id>_`，实际 PID/LUID 名无法命中；且取得首个进程后停止，不能覆盖整树。计数器缓存未跟随进程实例生命周期更新。
- 修改：复用现有 sampler，按真实 PID 前缀选择所有活进程/适配器实例，实例变化时更新并释放缓存。GPU 样本只接受一次完整读取；无有效样本保留 null。记录实际计数器身份供复核。GPU 阶段前后泄漏预算仍属后继，不以进程峰值关闭完整 Gate E。

## 验证预登记

聚焦选择器覆盖多PID/多LUID、PID边界、死进程和非法名字；PowerShell语法门。实际用 fresh Chrome GPU 子进程树接入同一 sampler，检查有身份的真实GPU样本；计数器不可用时记录原始错误，不把缺失写作0。

## 实测结果

选择器和PowerShell语法通过。`node scripts/j3-gpu-process-memory-observation.mjs` 一次fresh Chrome实际WebGPU提交与Windows计数器读取成功，3个完整进程树样本/3个GPU样本，实际LUID实例明确：pid_14444_luid_0x00000000_0x00010BE5_phys_0，专用显存峰值68177920字节、错误null。进程树峰值551616512字节；墙钟2981.9ms包括CIM采样，不是GPU帧时。

证据 `test-output/interrupted-0930/driver-memory-observation/evidence.json`、metrics.json、sampler.log，入口日志driver-memory-observation-run.log。完成的是既有采样器匹配/整树聚合修复；该fresh Chrome只做了实际附件提交，未执行恢复前后泄漏预算，也未测Native进程树。不关闭完整Gate E。
