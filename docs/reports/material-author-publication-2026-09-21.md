# 材质作者参数到正式发布接线（2026-09-21）

本切片复用现有材质 Inspector 和渲染合同，补上 GLB 实例材质修改不能发布到 Deep 的缺口。

## 已有链路与确认缺口

- `ObjectAppearanceEditor` 已有粗糙度、金属度、自发光、双面及贴图入口；`MaterialTextureSettings` 已有共用 UV 变换与法线强度，不重建面板。
- 编辑通过 `sceneAppearanceCommands.updateSelectionMaterial` → `ViewerEngineRig.setModelMaterial` / selection material，写入实例 overrides，遵守锁定。`captureSceneModelState` 保存 override，`applyModelState` 在显式颜色覆盖之后恢复材质；现有历史捕获链复用。
- `compileSceneRenderPacket.assertStaticModel` 原来把所有非中性 `material` 都拒绝，即已有 UI 调整粗糙度后 GLB 发布失败。基础体编译已有同类基础 PBR 支持，因此只补模型分支，不重写基础体。
- 原材质槽、多材质源数据继续保留；此次为现有实例全局覆盖，未实现新的槽级覆盖 UI。

## 实现

`sceneMaterialOverrides.ts` 明确接受颜色、粗糙度、金属度、自发光颜色/强度、双面。每个模型实例生成独立 material，不修改共享 GLB 源材质；未覆盖字段保留原值。#RRGGBB 按 Three 的线性工作色彩转换一次；自发光 factor 与 strength 分离。恢复顺序与 Web 相同，material.color 优先于 colorOverride。

Inspector 的粗糙度/金属度保留滑块，旁边加精确录入，复用现有 `DeferredNumberInput`：Enter/失焦提交，Escape 取消，编辑中保留草稿；不为每次键入创建命令。沿用 base.css 的既有样式体系及 Inspector 栅格。

## Deep Web 与 Native 消费核对

- Deep `threeBridge/materials.ts` 已区分基础色/发光纹理与线性数据纹理；`decodedTexture.ts` 按 semantic 选择 sRGB / linear GPU format；Native `gpu_texture_upload.rs` 按 prepared encoding 创建对应纹理。
- `pbrDisplayColorWgsl.ts` 已有线性 HDR 调色、曝光、两种 ACES 路线和输出 sRGB，未新增重复色彩管线。
- Native `runtime_package/render_packet.rs::normalize_emissive` 已消费 emissiveStrength 并合成线性因子；本次继续使用既有正式包合同。
- 非中性的涂层/透射等高级 Three physical 属性仍未获得通用桥支持；不能把透明度叫作玻璃透射。自定义贴图、线框、shader effect 等未适配状态继续精确拒绝，未删除整体门禁。

## 验证与后续

2026-09-21 17:59：编译器、基础体、Inspector 共 31 项通过；补复用延迟输入后 Inspector/AppFormControls 共 4 项通过。Web 类型检查通过。
新增发布测试覆盖：JSON 保存恢复后的参数、颜色转换/优先级、独立实例不污染、移除覆盖回源、正式 runtime package 构造与校验、非法数值和不支持纹理拒绝。

真正的页面编辑→撤销重做→刷新→EXE 画面对拍仍留在集中验收，不能以这组编译测试宣称整条用户流程已过。后续连接点为材质槽级覆盖、逐项恢复来源、多贴图采样语义、高级物理材质和 HDR 作者设置；烘焙/探针制作流程继续独立推进。本切片对标 Unity Inspector 的精确参数编辑，视觉截图与十维评分按用户要求集中执行，当前不作未测评分。
