# PostgreSQL 元数据快照写入保护

S1 增加数据库级 CAS，防止多个 API 实例用旧整文档快照覆盖新模型指针。仍使用现有 PostgreSQL 表和 MinIO，未修改账号、连接配置或正常业务库。

## 行为

- `bim_studio_state` 增加非空 BIGINT `revision`，旧行默认 0。读取文档时同时读取版本；版本使用十进制字符串，避免 JavaScript 安全整数截断。
- 提交版本绑定候选快照创建时的已读版本。数据库仅在版本相等时原子替换文档并递增版本；任务和模型指针仍在同一份文档提交。
- 版本冲突不自动重放旧候选。重新读取数据库真值，原请求返回 `metadata_revision_conflict` / HTTP 409；调用方重新读取后决定重试。
- 同时初始化空表使用 `INSERT ... ON CONFLICT DO NOTHING`，后初始化者读取先落库的文档，不能覆盖它。
- 与终态不可改写保护组合：旧成功回调第一次被 CAS 拒绝，刷新后再次带不同产物提交也被终态检查拒绝。

## 实际验证

复用 `isolatedPostgresFixture` 创建独立临时 PostgreSQL cluster，未连接正常业务数据库。6 个真实数据库场景通过：旧表迁移与冲突后重试、相同版本并发只成功一次、SQL 风格字符串作为普通数据、旧转换发布保留胜出指针、数据库约束失败不推进版本/不暴露候选、双实例初始化空状态表。

7 个版本协议测试覆盖超出 JS 安全整数的 BIGINT、非法版本、空/错误回执和初始化 SQL。与 13 个模型转换持久化场景组合共 26 项通过；API TypeScript 通过。

13:08 合并后 API 全量：208 文件通过，1,349 测试通过、4 项既有跳过，耗时 39.72 秒；日志 `test-output/api-cas-regression-20260918.log`。真实 PostgreSQL 并发组没有跳过。

```powershell
pnpm --filter @bim-studio/api exec vitest run src/postgresStateRevision.test.ts src/postgresStore.concurrency.test.ts src/modelConversionDurability.test.ts
```

数据库工具未安装时集成组会显式跳过；本轮运行没有跳过。

## 部署和剩余范围

升级前停止旧写入实例，完成表迁移后只运行新版写入代码；旧二进制的无条件 upsert 不遵守 CAS，不能混跑并据此宣称受到保护。新增列兼容旧数据，未删除或重建业务表。

这不是多实例任务调度完成：worker 所有权租约、过期接管、跨实例队列/查询刷新及提交回执丢失后的显式确认仍需继续验证。在这些项完成前仍保留单 API 写实例部署要求；本轮完成的是数据库拒绝旧快照覆盖。JSON 文件存储仍为单实例模式。
