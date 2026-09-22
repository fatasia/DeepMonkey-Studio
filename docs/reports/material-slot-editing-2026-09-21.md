# 材质槽实例编辑接线（2026-09-21）

本切片在现有材质 Inspector 内增加 glTF 材质范围选择，槽身份、实例外观和正式发布使用同一源材质索引。

## 已有实现与复用

此前 `SceneMaterialState`、模型/构件 overrides、场景历史、快照保存恢复、GLTF 实例材质克隆均存在。缺少稳定槽选择；`getSelectionMaterial` 只展示第一材质，而修改遍历全部 mesh 材质。此次不重建材质库、不以运行 UUID 或显示名称作为保存身份。

## 实现边界

- `CompatibleGLTFLoader` 使用 parser associations 给材质记录 `gltf:N` 源索引，Three `Material.clone()` 保留该身份；重复名称不会合并槽。
- `SceneMaterialState.slotOverrides` 只存实例级槽覆盖。合同验证数量上限、键格式、字段类型并拒绝嵌套。
- `MaterialScopeEditor` 默认全部材质，可选择具名槽；槽基础色、PBR、现有资源/贴图参数通过现有编辑回调提交。全局覆盖先应用、槽覆盖后应用；未命中槽不改变其它表面。
- 现有实例独立材质克隆保持跨模型隔离。模型 overrides 随现有捕获/撤销/保存恢复路径保存，未另建编辑状态仓库。
- 文件贴图上传回调携带槽身份，并在上传开始捕获目标模型与贴图类型；返回时不跟随新选择，目标删除/锁定则不应用。仍复用原上传服务。
- Deep 编译按源 `/material/N` 对应同槽，保留每个模型独立 material；不存在的槽明确拒绝，不能静默落到别的表面。
- `getModelMaterialStates(id)` 提供所有去重材质的真实基础参数，用于多选混合值；非 glTF 可只读枚举，但不给不稳定编辑槽身份。

## 验证

- 现有实例共享资产、稳定槽 helper、GLB 编译及 Inspector 合计 26 项通过。
- 真实 CompatibleGLTFLoader 两次独立解析与槽身份检查：3 项通过。
- 场景合同及新增槽数据校验：12 项通过。
- 实际 ViewerEngineObjectState 材质消费与 Inspector：2 项通过，验证单槽、其它槽、其它实例隔离，以及全局/槽覆盖优先级。
- Web 类型检查通过；真实页面撤销重做、刷新及 Native EXE 画面对拍仍统一终验，以上测试不等同于完整视觉验收。

## 下一衔接点

当前可编辑槽仅模型根的 glTF 稳定源材质。BIM Fragments/非 glTF 及构件级槽身份需要各自稳定源合同，未冒充完成。上传的新贴图仍受现有 Native 自定义贴图适配限制；基础 PBR 槽覆盖已进正式包。恢复某槽源材质、完整 UV/资源混合状态、高级物理材质与材质库工作流继续补齐。此切片不代表全部属性面板完成。
