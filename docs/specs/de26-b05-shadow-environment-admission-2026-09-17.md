# B05：阴影与环境贴图分配前准入

日期：2026-09-17。承接 `b73c7a6` 的 DeviceSession 所有权预算，覆盖 CSM、共享局部阴影图集、局部阴影 fallback、studio IBL、HDR IBL 和预过滤 IBL 的纹理与 setup buffer。

- 复用 `createAdmittedTexture` / `createAdmittedBuffer`；拒绝发生在 GPU 创建之前，旧资源继续计入候选峰值。
- `DeviceResourceBudgetError` 从 WebGPU 入口导出。局部阴影创建遇到预算拒绝直接返回错误，不进入禁用阴影回退；原有 GPU validation 失败回退保持不变。
- 共享图集同步失败立即解除 abort listener；预过滤 IBL 后续纹理被拒绝时释放此前候选纹理，不上传部分内容。
- 不改变质量档位、流式预算、环境事务或取消机制。尚未迁移的直接 `create → own` 入口仍只能在所有权登记时拒绝，不属于分配前硬预算。

验证：WebGPU + streaming 150 个测试文件、1,175 项通过、22 项跳过；类型检查、lab 构建、runtime purity、repository governance 通过。新增测试覆盖预算错误类型、错误直传、零 fallback 分配、abort listener 清理及 IBL 候选回滚。Lab SHA-256：`38ad9f44ffaae6463aa713520a607ca6ef5d26c11e9e167083c3061724c8e4c8`。

本片未取得新的真实 GPU 读回；lab 服务可用，但工具浏览器会话列表为空。上一片的 `deviceBudgetProbe` 仍待执行，不能用旧资源计量报告替代准入验证。
