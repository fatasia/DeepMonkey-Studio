# DE26/H09：受限 Agent 场景事务首片

日期：2026-09-18

本片把 V8 的最小边界落到 `@bim-studio/scene-sdk`：Agent 只提交现有 `SceneCommand`，宿主仍是场景状态唯一所有者。没有新增消息总线、场景状态源或聊天编辑器。

## 已实现

- `prepareSceneCommandTransaction` 对 Agent 输入重新执行 Scene SDK 结构校验。
- 预检 `scene.write`、逐命令 capability、活动场景 ID、重复命令 ID 和 64 条批量上限；任一失败整批拒绝。
- 生成稳定的纯数据计划和可读 diff，计划可 JSON 序列化，命令载荷与外部输入脱钩。
- `commitSceneCommandTransaction` 先 CAS 读取 `baseRevision`，再交给宿主 driver 提交；宿主没有通过 revision 检查时不会写入。
- driver 报错、部分失败、取消或结果形状异常都必须进入 rollback；成功和回滚都返回带 command IDs、diff、revision 的 receipt。

## 边界

`SceneCommandTransactionDriver` 是唯一写入入口，必须由 Web/Native 宿主接入已有命令执行器或 `SceneMutationGateway`。本片没有虚构渲染端 revision，也没有把普通逐命令执行冒充原子事务；未接 driver 的宿主仍保持未验证。

## 验证

```text
pnpm --filter @bim-studio/scene-sdk test
6 files / 93 tests passed
pnpm --filter @bim-studio/scene-sdk typecheck
passed
```

聚焦测试覆盖计划 diff 脱钩、权限/能力/场景/重复 ID 拒绝、迟到 revision 不写入、部分结果回滚、全成功 receipt 和提交前取消。
