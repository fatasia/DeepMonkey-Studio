# Studio 源材质透明度回归修复

## 现状核查

1. 检索 Web delivery/viewer 与 Deep glTF 的 baseColor、normal、alpha、transmission 和姿态消费，含未跟踪的 authorModelDecode/worker/transfer 文件。既有 Worker 解码链不重建。
2. 读取 contracts/sceneMaterial.ts 与 Deep renderPacketTypes.ts：实例 opacity 和源 baseColorAlpha/alphaMode 已分别定义；材质编辑契约没有第二套 opacity 覆盖。
3. 核对 Web package.json：Three 0.186.1、Deep、gltf-transform、Vitest、sharp 已在用，不加依赖。
4. 沿作者快照 → compileSceneRenderPacket → decodeAuthorModel → decodeDeformablePacketGlb，以及 Three sourceMaterialOpacity 查消费方。Three 源透明度乘实例倍率；编译器却把源 alpha 强制替换为实例值，并将源 BLEND 改为 OPAQUE。
5. 查 compileSceneRenderPacket、authorModelWorker、sourceMaterialOpacity 测试与真实同相机 SMT 截图。旧编译器测试错误地要求源 BLEND 在实例 opacity=1 时变成 OPAQUE，需要纠正；截图显示盖板玻璃变成白板。
6. 查 studio-deep-author-visual-contract-20261007、n5-material-import-profile-20261003、studio-handoff-20261007-1336 与 active-task-recovery-ledger。GPU/GI 与宿主性能由其他并行任务负责。

**已有（不重建）**：GLTF 源材质解码、Worker 转移、透明渲染算法、Three 源 opacity 缓存、材质槽编辑、姿态编译。

**真实缺口**：场景包编译覆盖了已正确解码的源透明语义，默认实例透明度破坏玻璃。修复限定源 alpha × 实例 opacity，保留 BLEND/MASK 与现有 MASK+BLEND 不支持的明确拒绝。实际 SMT 材质、纹理与姿态另作记录，不能以源 SHA 相同宣称视觉一致。

## 验证

47 项聚焦测试通过，覆盖默认玻璃、实例透明度倍率、MASK 阈值、显式材质槽编辑、Worker高级材质导入与逐实例损失提示。新增 Worker 测试的参数类型推断错误已纠正，末轮 Web typecheck 通过。

Studio 导入明确启用已有 `advancedMaterials:true`，编译器与 Worker 两条解码路径同值传入。源材质损失经 `compilation.materialLosses` 和现有 Deep 提示消费，不悄悄吞掉；Native 默认严格子集保持原选择。

实际 SMT（6,259,040B）通过同一 WebIO/Draco 规范化语义、真实解码和场景编译核查：玻璃最终 tuple 为 BLEND / alpha1 / transmission1 / IOR1.4500000476837158 / roughness0 / metal0，未降为不透明板。4 张 2048×2048 的 baseColor/MR 贴图进入包；源模型没有法线贴图。7 几何、7 实例、153498 顶点、3 个活体蒙皮姿态；主体与 PCB 的 KHR_materials_specular 仍各有一项既有 profile 降级。证据：`test-output/studio-engine-lod-switch-20261007/smt-material-packet-audit.json`。

## 透射与高光后续

以上4张纹理/2项specular损失是修复前的CPU记录。最新源码导入已保留6张纹理和两项高光颜色槽，损失为0，见 `studio-source-specular-audit-20261007.md`。

核查时透射仅从环境/局部反射立方体读取，无法显示玻璃内部。核心 owner 已补 `pbrSceneTransmissionWgsl.ts`，复用 OIT 前不透明场景颜色，保留源alpha1的透射语义。其真实GPU探针和SMT同相机验收由主任务继续；仅保留alpha合同不能证明最终视觉一致。
