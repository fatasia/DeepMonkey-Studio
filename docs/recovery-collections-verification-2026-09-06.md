# 旧快照空集合恢复误报：限定修补

状态：已完成。只处理已证实等价的5种可选空集合；运行时配置默认值和浮点尾差不在本修复内。

诊断采用diagnosing-bugs：最小红测为同一快照仅从省略annotations变为annotations:[]，实际返回有恢复修改。逐项核对加载器后确认annotations、cameraViews、assetBindings、selectionSets、interactions缺省为空，比较器将这5种顶层空数组规范为省略。原副本不改写；null、非空集合、未知字段、嵌套配置、数组顺序和微小真实数值差异均保留。

## 实际验证

- 聚焦 `workspaceRecoveryStore/workspaceRecoveryDecision`：2文件15项通过，红测先失败再转绿。
- Web typecheck退出0；r17 Web build及全量400文件1613项通过；2041源文件均≤800行。
- r17 index SHA256：`1b5b55a13c0a0173dfd5c9c67c025855d97f2f5c6c68d8a98e362a8404f16251`。API/contracts仍r15，不需重建。
- `gate-recovery-collections.mjs` → `recovery-collections-lwjM2W`：两轮暗1440/亮980共4/4。真实IndexedDB副本→进入Studio→等价副本清理且不弹窗；真实改名→提示→Esc保留副本；应用API内容不变、业务写0、控制台错误0。
- 全局相邻 `gate-dialog-escape.mjs` → `dialog-escape-RbbjsC` 两轮4/4；实际历史、发布busy、恢复版本冲突和Esc保留原语义。
- 两轮截图亲审：`r1-dark-1440-equivalent-no-dialog.png`、`r2-light-980-real-edit-preserved.png`。本批没有改布局或视觉样式，沿用现有恢复弹窗验收；不据此新增全站视觉达标声明。

首个浏览器夹具从应用转换快照，和Studio实际browse接口返回不同，出现真实差异而提示恢复；已改为读取相同browse来源，不删除其他字段来放宽比较。失败产物`koE0HT`不计通过。

下一步：对配置默认值逐项证明加载语义与用户意图后再处理；禁止全局舍入浮点、忽略所有空字段或修改用户原快照以掩盖误报。仿真与AI按用户要求排最后。
