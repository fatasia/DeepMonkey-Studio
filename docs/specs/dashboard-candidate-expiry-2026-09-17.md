# Dashboard 候选过期回收

内存候选仓库在登记新包时清理过期记录，避免从未下载的旧包跨发布批次持续积累。

- 复用登记时钟，按 `expiresAt <= now` 判断；未到期候选不淘汰。
- 不增加定时器；已读取的下载副本不受删除影响。自定义持久化仓库不变。
- 单次清理只遍历元数据，不复制旧包；时间复杂度 O(n)，有效候选数量仍无硬上限。完全闲置时记录留至下一次登记或过期读取。
- 非整数/非有限时钟在写入和清理前拒绝；原权限校验与复制隔离保持。

## 验证

`pnpm --filter @bim-studio/api exec vitest run src/dashboardNativeCandidateRegistry.test.ts src/dashboardNativeCandidateService.test.ts`：2文件13项通过。

新增覆盖边界前1ms保留、恰好到期回收、未过期包继续下载、错误项目拒绝、修改返回字节不污染原包，以及三种无效时钟不写入/不删除。API typecheck通过。同族检查发现Native场景候选已有清理逻辑，未重复修改。

本片无UI变更、依赖或存储拓扑变化。工程十维自评均9；证据为上述行为测试与类型检查，不作为整条离线交付完成依据。
