# B5 场景级命令失败回滚与跨场景守卫（2026-10-02）

## 现状核查

1. 全仓现状/未跟踪已读：SDK lighting/environment命令与Viewer实装、draft成功回写、P4-B5双轮happy path已验。不重复建立新状态树/宿主。
2. 契约：GlobalLightingState、SceneEnvironmentState、WeatherMode均已有；SDK原事务rollback/CAS已存在。原EditorSceneStateReader只读材质/变换/相机，缺场景级读回；本批增可选现成getter，不修改公共contracts。
3. 依赖：零新依赖；既有Vitest/真实Viewer/API跑门复用。
4. 消费方：SDK事务→driver capturing→ViewerSceneCommandPort；SceneCommandExecutor也直接消费命令。draft只在committed后回写，失败时引擎的场景元数据必须恢复，否则引擎/作者档不一致。
5. 测试：B5原21×2只证明成功混批/幂等，没有“第一条成功、后一条失败”原子回滚。现driver注释“场景级无需逆算子”是不成立的事实；SDK收据rolled-back却保留实际灯光/天气改变。executor仅相机校验sceneId，新lighting/environment误漏，两类零targets命令可跨scene执行。
6. 规格：P4-B5原验收scope、本批简洁UX指令与41个已有作者测试。两子线只F5/DeepSL package，无文件冲突，root本批独占driver/executor。

**已有（不重建）**：命令/宿主setter/getter/draft/保存/权限/事务调度。
**真实缺口（P1）**：场景级引擎效果没有逆算子，混批失败仍残留；直接executor新场景命令漏scope guard。

## 最小方案

- 在已有逆算子栈添加lighting/environment绝对快照，apply前真实getter读回/深clone，未注入getter的未知宿主明确拒绝（不假应用）；weather仅请求变更时捕获/恢复。
- rollback复用现有反向栈，不建第二快照树，不碰作者history/ReactUI，不添加用户步骤。
- lighting/environment纳入同相机sceneId守卫，跨scene命令连接前拒绝。
- 先新红反例三条（成功灯光→失败、成功环境+weather→失败、无读回fail-closed）与两scope负控；修后正式driver/executor/删除/材质同族回归。

## 结果

- 修前三反例 **0/3通过**：两条回滚收据下实际灯光/天气仍变，直接executor两scene命令跨场景未拒；证据 `test-output/p4-b5-scene-atomicity-20261002/before.json`。
- 修复：lighting/environment进入已有绝对逆栈，getter无注入明确unsupported、捕获先于mutation；weather仅请求时捕获。后命令失败或setter变更后抛错都恢复旧状态；没有第二状态树/React页面变化。
- scope guard按已有camera同规纳入两场景命令，跨scene端口不触达。
- 最终原studio+behavior全族 **266/266**、Web完整typecheck **exit0**。5新用例（两later-failure原子回滚、缺getter零变更、after-mutation throw恢复、直接跨scene拒绝）皆过；邻居旧删除/材质/成功B5透传保绿。证据 `final-family.json` / `final-tsc.log`。
- 原B5实际21×2保存重载证据保留不重跑；本片补失败原子回滚子门，未把成功收据假称完整失败门。
- 本批零新增UI/按钮/面板/用户步骤，符合用户“保简洁、重体验”要求。旧未知宿主未读回时拒绝不是表面禁用；真实Viewer有getter零新增用户配置。
- 多宿主销毁/取消时序与Native验证保持P3/E后继，未认证。no cargo/no帧时/no commit/push。
