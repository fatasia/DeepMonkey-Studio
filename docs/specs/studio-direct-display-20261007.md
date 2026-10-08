# 无 Composer 作者场景的 Deep 显示域

## 现状核查

1. 全仓检索 studioDeepFog、EnvironmentView、GridSession、pbrFog、output shader 和未跟踪修改；三个无 Composer guard 会拒绝空场景。
2. RenderView 继承 PbrFrameUniformView；雾 ABI 已有两 vec4，parameters.w 空闲。不存在可选的 outputNone 路径，原输出固定 ACES→sRGB。
3. Three、WGSL 单源同步工具、Vitest 和 CPU 颜色镜像均已在用；不增依赖。
4. StudioDeepRenderView→PbrMainBindings/updateFrameUniforms→scene/grid shader→output 为现有消费链。Three 直接渲染在 tone/output shader 之后混合 fog；固定网格 MeshBasicMaterial.toneMapped=false。
5. FogIntegration、MainBindings、GridResources、EnvironmentView 与 GridSession 已有合同测试。GPU 窗口归切换分支，本切片先 CPU。
6. 已核对当前交接、显示合同与本轮切换规格；不修改作者场景参数，不单独删除 guard。

**已有（不重建）**：作者雾及曝光、HDR/直接输出、固定网格贴图和单源输出 WGSL。

**真实缺口**：Three 无 Composer 的显示域顺序、纯色背景免 tone map、固定网格免 tone map及最终无二次输出转换。显式逐帧 direct-display 标记复用雾参数保留槽；默认 Composer 路径保持原值。

## 方案

无 Composer 直接渲染的颜色在 sRGB 显示域进行雾和透明混合，因此该帧中间颜色保存显示值：对象 ACES→sRGB→fog，网格 sRGB→fog，纯色背景只做 sRGB，最终输出直接呈现。该标记不允许同时启用 HDR 后处理或作者调色。原 Composer 帧继续使用线性 HDR，最终转换不变。

新字段是已有 RenderView 的作者路径说明，不扩大受支持的常规材质类型。固定网格另走原专用资源。GPU 实测在统一窗口记录。

## 实现与检查

- `PbrFrameUniformView.authorDirectDisplay` 从实际 Composer 状态传到两种 Studio RenderView 消费路径，保留雾 32-byte 和全景 96-byte ABI。全景对原有 HDR 与免 tone-map 两路分别处理。
- 场景着色器先 Three ACES 与 sRGB 再混雾；网格只 sRGB 与雾，最后按透明度预乘。输出 shader 的负 toneMapping 分支直接呈现颜色，恢复 Composer 后逐帧恢复原输出设置。
- 纯色背景免曝光与 tone mapping；noFog 材质保留显示转换；无 Composer 帧不执行 OutlinePass。非 SDR 画布以及实际继承的 HDR 后处理组合会在编码前拒绝。
- AuthorGridResources 销毁时清空 CPU mip 缓存，保留原异步准备与取消逻辑。
- 逐帧关闭 TAA 抖动、接触阴影、时间上采样与已分配的 SpatialAA；直接输出跳过后处理尾链并重置其历史，恢复 Composer 时复用资源。capture/allocation 计划及执行回执同步使用该帧开关，分辨率不继承先前的降档。

CPU 验证：Deep 9 文件 94 项测试通过，完整 PBR、网格、全景 WGSL 均经本机 Naga 编译；Web 6 文件 58 项通过，含真实 Studio bridge 无 Composer 网格准备、两个 RenderView 路径及切回 Composer。Deep/Web 类型检查通过。证据位于 `test-output/studio-direct-display-*-tests.log` 和 `*-typecheck.log`。

全量 Deep 测试发现的两处回归已修：c8F32Inputs 重新固定演进后的完整 shader 哈希，保留所有局部 exact seam 和漂移拒绝；validateFrame 在异步网格准备前先检查设备代际，等待后再次检查。最后 9 文件 76 项（含关闭/恢复 TAA 与 SpatialAA、C8、deviceEpoch）通过，Deep src/lab/examples 类型检查再次通过，日志 `test-output/studio-direct-display-effects-final.log`。

`pbrRendererFrames.ts` 为 800 行，未新增体量豁免。该轮整仓 source-size 检查发现其他分支的四处超限，记录在 `test-output/studio-direct-display-size-gate.log`；最终整仓门禁由主任务统一重跑。

尚待统一 GPU 窗口：空作者场景及带雾网格与 WebGL 同相机截图对照。CPU shader 编译与生命周期验证不替代该视觉验收。
