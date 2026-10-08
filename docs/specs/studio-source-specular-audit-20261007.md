# SMT 高光贴图导入核查

## 现状核查

1. 全仓检索 KHR_materials_specular、specularColorTexture、specularIntensityMap，核对未跟踪的作者解码与材质证据脚本；未发现另一套可用的 specular 导入。
2. 读取 renderPacketTypes、decodedTexture、materialParameters、materialAdvancedParameters：已有 IOR 和高级标量层；没有高光颜色/强度因子及贴图槽。
3. 核对 Deep/Web package.json：Three、gltf-transform、sharp 已在用，真实图片核查无需新依赖。
4. 沿 optionalMaterialFallback → materialGltfMap → 纹理解码 → materialBindings → PBR F0 查消费方。specular 在导入前投影为核心 PBR；Three 桥也明确拒绝对应贴图和非中性因子，GPU 只使用 IOR 的灰色介电 F0。
5. 查 n5-material-profile、ThreeProjectionBridge.advancedMaterials 测试、真实 SMT 包材质报告及同相机 Three/Deep 截图。主体和 PCB 各有一项 specular 降级；源模型没有法线贴图。现有测试验证降级，不能证明高光纹理支持。
6. 查 deep-material-gaps、n5-material-import-profile、studio-handoff-20261007-1336、active-task-recovery-ledger。核心透射与 GPU 宿主由并行 owner 修复，本任务先核图片和最小接线范围。

**已有（不重建）**：材质损失记录、IOR、五种核心纹理语义、UV/采样器/纹理变换、纹理预算与缓存、材质 uniform 池、高级渲染变体。

**真实缺口**：KHR_materials_specular 不在受支持 profile；其两张 RGB 高光颜色图片没有进入包，也没有被 shader 消费。不能把颜色贴图烘入 baseColor 或修改 opacity 来代替。

## 真实图片核查

源 texture4/5 对应两张 4096×4096 灰度 JPEG，RGB 完全一致，alpha255。原字节提取后目视确认：主体包含壳体、窗口、孔位的黑白高光遮罩；PCB 包含灰色板面、黑孔和白引脚。主体白色像素76.20%、黑色15.54%；PCB白色1.38%、黑色52.70%。与同尺寸、同 UV 的 MR 蓝通道关联，介电权重平均为90.17%/99.30%，不能以金属材质为由忽略。

IOR1.45 的灰色 F0 为0.03373595。按 sRGB 解码高光颜色、关联介电权重，整个 atlas 的 F0 平均绝对偏差为0.006454/0.025481。atlas 包含未使用的 UV 空白，统计不是屏幕面积或渲染误差。黑/灰遮罩丢失会增加对应表面的镜面分量，可能降低暗部反差；尚未做相同相机的扩展开关对照，不能把卷轮细节丢失全部归因于它。玻璃透射、灯光和 AA 是其他已确认缺口。

证据：`test-output/studio-engine-lod-switch-20261007/smt-specular-texture-audit.json` 和两张 `smt-specular-material-*.jpg`。复用脚本 `apps/web/scripts/audit-specular-textures.mts`，真实 GLB 核查 EXIT0（约6秒）。

## 最小补齐范围

1. 包合同添加可选 `specularFactor`、`specularColorFactor`、`specularTexture`、`specularColorTexture`；中性默认1/[1,1,1]。factor 为0..1，高光颜色为非负有限 RGB，可超过1。两个槽复用已有 TextureSlot 的 UV/变换，不能用 baseColor 代替。
2. 导入仅在已有 advancedMaterials 能力开启时保留扩展，读取 factor、color 和两种纹理；未开启保留现有 loss。几何严格解码前剥离已接管的扩展，纹理 manifest 读取其 UV；真实 SMT 应由4张变为6张源材质纹理。
3. specularTexture 使用线性 alpha；specularColorTexture 使用 sRGB RGB。PNG/JPEG、KTX2、预算、Worker 转移、缓存与 prepared packet 都消费同一语义，源图不烘入其他通道。
4. 核心 owner 在透射 GPU 回归安全点后接高级 uniform、绑定和 F0/F90：`F0=min(IOR_F0×specularColor,1)×specularFactor`，金属分支保持原值；直射、IBL 和漫反射能量分配同时更新。中性默认保持 stock 行为。预计新增两张 sampled texture，需检查 adapter 的每阶段上限并在 requestDevice 前验证，不能把资源超限变成切换卡死。
5. 聚焦验收覆盖真实源 tuple、UV1/纹理变换、alpha 与颜色空间、非法值、非中性与默认守恒、未启用能力的明确行为。随后使用 SMT 同相机扩展开关对照，区分高光差异与其他材质缺口。Native/运行包 ABI 未支持前保留明确拒绝，不伪装三引擎一致。

语义依据：[Khronos KHR_materials_specular](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_specular/README.md)。材质文件归本任务，GI/session 由引擎 owner 并行维护；透射取样算法沿用其现有实现。

## 实现与验证

CPU 导入、Three 投影、Browser packet、纹理准备/驻留和 GPU 高级变体已接通两个高光槽。未开启 advancedMaterials 时保持原 stock shader 和192B材质 ABI；高级变体采用320B参数块。颜色图按 sRGB RGB 读取，强度图按线性 alpha 读取，UV0/UV1和各自变换独立。TextureArray 和 RT path-tracing 尚未接入这两个槽，前者保持常规材质绑定，后者对非中性扩展明确拒绝；Native 运行包仍明确拒绝该合同。

高级管线在 requestDevice 前核实 sampled-texture 上限：普通档19，附加 RT 阴影或虚拟阴影页各增加1。不满足时返回 `advanced-materials/texture-limit`，不改材质或降低纹理语义。

真实 SMT 源码导入报告 `smt-material-packet-specular-audit.json` 已由4张变为6张2048²纹理，body texture4和PCB texture5均进入对应材质槽，材质损失为0；玻璃仍保持源BLEND、alpha1、transmission1。报告只证明CPU导入与包编译，画面仍以真实GPU对照为准。

聚焦CPU检查：导入/纹理/运行包等15文件224项、材质GPU接口等10文件102项、Web变体13项通过；闭包追加4文件35项通过。Deep完整typecheck（src/lab/examples）和build、Web typecheck通过。真实GPU首次发现 `renderPacket.usedTextureIds` 仅保留旧五槽，会在prepare后滤除已解码的高光图；已补七槽及驻留依赖、局部LOD闭包、VT反馈和材质账本，并增加实际prepared纹理保留断言。第二次被fixture同ID改图未升revision拦截，已修fixture，保留生产revision校验。

GPU探针入口 `packages/deep-engine/lab/specularMaterialGpuProbe.ts` 使用生产PbrRenderer、正式HDR读回，覆盖强度0、颜色/alpha遮罩、UV1、真实morph pose和金属分支不变。首次生产SMT还发现变形material/pose组只有旧13条绑定，高级layout要求17条；已补16..19高光图/采样器，保留11/12姿态流，中性材质填充既有fallback，关闭高级变体仍为旧布局。三文件29项聚焦测试与完整Deep typecheck/build通过。

Root在正常浏览器执行修正后的160×96真实GPU探针，8项全部通过、diagnostics为空、每case2次draw。Stock左右HDR均值0.079686；强度0为0；颜色遮罩黑侧0.000416/白侧0.079687；线性alpha遮罩黑侧0；UV1左右反转；morph case与静态遮罩相同；金属两case均1.175337。两向方向光提供双面平面探针的照明，发光独立控制0.17965排除了全黑空帧。该探针验证的是材质采样/姿态链，不替代SMT画质评分。

这是19槽旧版GPU结果：实际served bundle SHA为 `a5a1fa576eb5021b31d4832fa8f5fdb0ee842763a40b9feb02b690853c753709`，当时7项源文件SHA逐项匹配；当时core source SHA为 `b2bb9054c502dc9ccf3d32483faa2f34f37be06fe282e40d066aee7cc0e6ed35`，dist SHA为 `1a82b85e93f0ac78d5176b4d57642b1e99544a8baf74bb21a5bea5b893f5038c`。下节16槽结果和新身份覆盖当前代码；证据仍保存于 `test-output/specular-material-20261007/`。

主任务随后成功让正式SMT切入Deep，并继续无诊断采集的CPU profile与实际拖动回归。SMT同相机视觉验收与发布包冻结仍由Root继续，不能把上述GPU小探针或SHA当成整场视觉验收。

## 默认16槽设备现状核查

用户真实Quark设备仅提供16 sampled textures，19槽高级layout使Deep无法启用。六步复查：源码及未跟踪项已核frame/material/ForwardPlus全部槽和cube-array；合同StudioEnvironment已有cube view、mip选择和两个局部探针；沿用WebGPU资源与纹理复制，无新依赖；四个生产环境factory持有实际GPUTexture，MainBindings统一消费；此前GPU探针在较高上限adapter通过，未覆盖真实16槽；本节按最新用户要求接入全效果低上限，旧19槽拒绝不再视为交付完成。

已有环境、双探针和LOD不重建。真实缺口是高级layout资源重复：未消费的legacy shadowMap占1槽，global specular/primary/secondary三个cube占3槽。高级变体移除legacy槽并把三个cube合为一个cube-array，19→16。无局部探针时直接借同一六面GPUTexture的cube-array view，零复制；有探针时利用COPY_SRC按源mip精确复制进18层数组，各源LOD通过元数据偏移，禁止重采样或丢弃探针。stock布局和shader仍保持原字节。

## 16槽源码与构建检查

8文件95项通过：普通/姿态layout的纹理与采样器均不超过16，完整mip复制/不同探针分辨率LOD偏移、全局环境借用零复制、低能力拒绝、实际首帧specular-only关键管线均覆盖。non-RT advanced申请16纹理槽，RT阴影为17、虚拟阴影再加1；storage/group预算保留现有能力。`typecheck`（src/lab/examples）与统一`build`通过；统一构建含当前GI生命周期、单stage遥测、palette缓存和warmup完成通知修复。

20:42构建身份：source `ed7b83192e3a30f8ba80b54febf56c403672d7f5d45af387a3e841eea2541f08`，dist `0b64714145149d45c87cf37b3a04f1431f895efe45d79c0ced885eedfe7e8b04`；1938源文件/2248构建文件。逐文件清单与哈希算法见 `core-build-identity.json`。

Root真实GPU执行16槽探针通过：`sampledTextureLimit:16`、8/8断言true、diagnostics为空，结果另存 `result-16-slot-gpu.json`。正式SMT随后发现HDR factory的specular纹理少COPY_SRC：默认Studio factory探针未覆盖此分配点。已补具体usage，并增加实际 `createHdrEnvironment`→`PbrReflectionArray`工厂消费测试，2文件7项通过。该修复保留反射输入校验；不删除材质和探针。

HDR修复后统一build通过；source `4204a28683b369c878623cf6b955bcce3f5561843d8c5557955d6c40e3f642d1`，dist `7fde1d8ec671c4e95a379b6b7663c21d3f9beae3f354fefdab20f9cf7ee9dcd3`。16槽GPU结果记录的是HDR修复前源身份，核心shader未改变；新HDR正式SMT由Root继续实测。

`validated-evidence-16.json`将16槽真GPU源身份与HDR修复后的冻结清单逐项比较：除具体HDR allocation修复，其他记录的生产输入均匹配；lab源在GPU结果中有独立SHA，未纳入src清单。Root正式SMT已成功接管，后续无逐帧诊断的采样144FPS/P957.1ms/GPU2.3ms；整场视觉仍有后置合成条纹，Root已用同帧opaque HDR与present色截图隔离，继续由对应owner修复。此阶段不是最终发布准入。

Native/WASM共享七槽/320B和stock屏幕透射已接通，并完成真实GPU与正式WASM构建，见 [Native/WASM材质证据](studio-native-wasm-material-parity-20261007.md)。
