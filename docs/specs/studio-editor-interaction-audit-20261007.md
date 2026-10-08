# 编辑器引用与重复刷新审计（2026-10-07）

## 现状核查

1. 已检索WindowedSceneRows、FlatSceneObjectList、LayerTree、场景行消费、2.5s刷新及未跟踪文件；行测量callback ref、结构索引和虚拟列表已存在。
2. 已读SceneRow/Props、ProjectRecord、AppState及现有refresh回调合同；保持同一项目字段和模型progress更新。
3. React19、Vitest、测试hook与Three186均已在用，无新依赖。
4. AppStudioShellView创建modelRows→FlatSceneObjectList→WindowedSceneRows；后者的render闭包读取最新选择和对象状态。SceneSync每2500ms调用stable refreshProject，资源导入也调用同一回调。
5. 已读虚拟行、FlatSceneObjectList、large SSR、刷新hook测试与真实composer-wired CPU profile。该profile累计采样中WindowedSceneRows函数inclusive1.188ms、FlatSceneObjectList1.125ms、PrimitiveRow9.337ms；不是浏览器完整提交时间，不能推断该函数导致76.8ms提交。
6. 已校准react-rt、engine-switch、首阶段收尾和冷加载规格。真实115输入生产对照由主线程验，当前不启动GPU。

**已有（不重建）**：可变高度虚拟列表、稳定DOM绑定、行结构索引、完整项目快照去重和stable轮询引用。

**真实缺口**：去重ref只在render同步；同一事件批次的相同新快照仍可重复安排React更新。并发refresh与A→B→A迟到读取只按项目ID守卫，旧结果可能覆盖最新快照。

## 窄修方案

复用现有ref去重，读取提交前检查最新请求代际；项目ID变化使旧请求失效。接受新快照时先更新ref再setState，后续相同快照直接返回。保留真实progress、姓名等全字段变化与原刷新周期/回调身份；请求失败仍按调用方现有catch处理。

不对WindowedSceneRows或MeasuredRow加盲目memo。当前行render会读取latestProps；只比较row对象会隐藏选中、可见性或工具状态。大型树的首次构造与React开发版开销继续由真实生产对照定位。

## 检查

刷新/场景同步/虚拟行/实际FlatSceneObjectList四文件26项通过，Web typecheck退出0。新增对抗覆盖提交前连续相同快照、慢poll覆盖新manual请求、A→B→A迟到及same-project callback稳定；原progress与全字段变化继续通过。日志 `test-output/studio-editor-interaction-audit-{tests,types}.log`。

profile函数采样归因记录 `test-output/studio-editor-interaction-profile-audit.json`。当前修复不宣称整个React提交时长或生产帧时已降低；真实115输入对照仍由主任务完成。

发布说明已链接数据中心指南；在线指南已核实GitHub官方静态托管说明、展开站点1GB与Release单附件小于2GiB限制。README未改。
