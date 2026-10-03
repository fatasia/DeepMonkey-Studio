# C8 / J3-D 完整链收口核查

日期：2026-10-01。原 Three r185 的材质、曝光与 ACES 对照不变。GPU 由 root 串行执行；本线先补 CPU 证据合同，未关闭 C8 或 J3-D。

## 现状核查

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源与未跟踪文件 | 已查 packages/apps/src、lab、scripts 和 git status；C8 S2–S9 runner、J3-D 八层目录、GPU 实渲收据均存在；其余并行线改动保留 | 聚合只读 scope 和 passed，可接受缺 normals 的法线收据；空场景格仍 passed |
| 契约 | contracts/scene.ts 的 SceneMaterialState 已含 PBR、normal/base/emissive/MR 纹理与 UV；ThreeProjectionHooks、RenderView、J3DFullLayer 已存在 | fresh 聚合未强制生产源身份；currentRun 是执行标记，不能证明当前源匹配 |
| 依赖 | Three 0.185.1、esbuild 0.28.1、Vitest、Node crypto/fs、Native wgpu 30.0.1 已在用 | 无依赖缺口 |
| 消费方 | aggregateLayerMatrix 被 j3-d-full-layer-matrix.mjs 消费；各层复用正式 GPU runner 和 CPU 参考；C8 正式共享根 runner 消费 compareLocalDirect | 法线/阴影层未给 fixtureFile，expandSceneCells 实际 0 格；native-only Fog 错写为 web-only |
| 测试与证据 | 8 个聚合 Node 合同测；09:00–09:04 八层 receipt 均 passed；12:24 texture7/7 通过；S9 passed=true / qualityCertified=false；S5 只有 passed=false diagnostic | 聚合缺正常附件/空格/生产源漂移负例；display 未记录 currentRun；geometry/HDR 仅包身份，无生产文件摘要 |
| 规格 | 已读 remaining、恢复台账、GLM handoff、C8 主规格/S5/S9、J3-D CPU prep | 8 层聚合明确排除 smooth-cube HDR、完整场景质量、帧时，且未纳入纹理 7 场景，不能自动外推整项完成 |

## 最小 GPU 队列

仓根运行：`node scripts/c8-direct-material-chain-parity.mjs`，重测 S5 近/远、raw/shared-half、front/oblique。旧证据在 DFG 同源修复之前，必须重新实测。

随后：`node scripts/c8-local-direct-parity.mjs`，重测 S9 点/聚/额外方向灯、主光零、补能消融。旧 point/spot oblique 最大 HDR 差 .01171875，qualityCertified=false；不能放宽 .002 门。

Native primary 新 oracle 已由 root 运行通过；hemisphere/local oracle 归另一专线，不重复。原 Three 纹理和扩展 lobe 对照、完整场景/性能仍缺独立实测，不用 Web/Native 纹理7/7 替代。

## 本次合同修复

root 释放既有 J3-D 聚合器、runner、catalog/test 锁。本线直接加固既有模块，不增加第二套 runner。法线层必须带通过的 normals 子收据；任意层格网不可空、不可重复；native-only Fog 按实际宿主登记。当前源逐文件 SHA-256 与 recorded sourceIdentity 比较，生产源变化必须拒绝，不能靠 fixtureHash 或 currentRun 绕过；没有生产源摘要的层不能认证 fresh。历史比较继续 currentRun=false。

## 视觉范围

已加载 design-taste-digitaltwin；对标原 Three r185 / Unity 材质响应，既有测试页沿用 base.css，深色1920×1080。CPU 合同没有新增视觉输出，十维视觉评分未做；两轮实际截图与严格 HDR 门由 root 的上述 GPU runner 复测，不据历史截图宣称本次视觉认证。

## 实测复核与下一诊断叶

root 已两 fresh 重跑 S5，仍 exit1：shared-half near front .00390625 / oblique .0078125、far front .00146484375 / oblique .00244140625；严格 emissive 全零、display 最大1。独立 CPU 推导保存于 c8-direct-material-chain/strict-residual-analysis.json 和 roughness-sensitivity-analysis.json。

远斜视 (198,64) 为 roughness .9 / metalness1，当前 half 差10 ulp，18个稳定邻点11正/0负/7零，不符合 LD-15 高光峰豁免。复用历史 S6 实际 roughness .98046875/.98828125 和当前 r185 LUT，在原fixture raycast位置独立计算预测 single 差 .002573325，历史实际 single 差 .002563477，当前 raw 总差 .002643436。两 roughness 均位于 LUT 最末 clamp列，multiple逐值相同 .019275102；导数粗糙度差足以解释主要残差。历史几何读数不冒充当前 fresh 证据；不放宽门，不改 Three。

S8 observer 后继六步：已查 lab/S6–S8 源及未跟踪文件；沿既有 FragmentObservable/Derivative/GPU注入合同；Three/esbuild/Vitest已在用；c8-fragment-observables、c8-derivative-vectors、c8-derivative-ablation 三现成 runner 消费同叶；现有12个shader/恢复合同测与旧GPU证据存在；已读 S5/S8规格。已有平台不重建，真实缺口仅 DFG切换导致观察器 `shade` 冻结摘要过期（接缝本身仍唯一）。更新为当前实际 shade SHA `fb5cbe84366f73b5e57f0f76232d1b1e3b8b927b40a996e32eb36c5be3ad7e2e`，保留整函数hash与单接缝守卫；只改诊断叶及合同，不改生产。

root 的 S9 两 fresh 新收据实读：passed=true、stable=true、qualityCertified=false；point/spot front .001953125、oblique .01171875；secondary-directional front .00146484375、oblique .00244140625；display 全部最大1。正式消费/消融通过，严格完整 HDR 仍失败。

## 验收与冻结

| 检查 | 结果 |
|---|---|
| J3-D Node 合同 | 11/11，新增空格/重复格、无 normals、缺生产SHA、源变化/缺失、路径越界等负例 |
| J3-D lab 合同 | 8/8，每层冻结 fixture 展开非空，nativeOnly 宿主纠正 |
| 三套观察 shader/恢复 Vitest | 13/13，所有六模式保留当前 direct DFG / IBL 分离，原Three恢复守卫保持 |
| 三套观察 Node 比较器 + J3-D | 44/44，无 fresh GPU 冒充、坏附件/矩阵/source拒绝 |
| lab tsc / runner语法 / diff-check | 全通过 |
| 实际 J3-D `--compare` | 正确拒绝过期 normal 的生产源：SceneEnvironmentPanel.tsx 已变化；原 GPU 收据保持，旧聚合成功 evidence已失效 |

冻结源码七项：`scripts/lib/j3DFullLayerMatrix.{mjs,test.mjs}`、`scripts/j3-d-full-layer-matrix.mjs`、`packages/deep-engine/lab/j3DFullLayerMatrix.{ts,test.ts}`、`packages/deep-engine/lab/c8FragmentObservablesShader.{ts,test.ts}`。后继 GPU 命令交 root：`node scripts/c8-fragment-observables.mjs`（32帧对/64实际帧，两 fresh）；`node scripts/c8-derivative-vectors.mjs`（24帧对/48实际帧，两 fresh）。旧 Fine/Coarse 消融已排除，仅重验当前几何输入与实际默认dx/dy。

生产导数尚无已验证修复，不做猜测改动。缺完整产品/纹理/扩展lobe Three对照与严格HDR通过记录，C8和J3-D均不关闭；全局台账由 root 维护。未 commit / push。

## 当前 S8 与显式采样候选核查

root 新 S8 两 fresh 已完成，default observer 源保持冻结。远斜视 (198,64) 的原网格三角形为172；CPU在该三角形平面外推 quad 四角而非跨三角形读取邻像素，得到上行 dx [.051314832,.020873875,.088776851]、下行 dx [.054789074,.021392055,.081008635]、左列 dy [.000393141,.074201435,.066056974]。当前 Deep dx [.051177979,.020797729,.088562012] 对应上行，Three dx [.054656982,.021316528,.080810547] 对应下行，双方 dy [.000380516,.07409668,.065917969] 对应左列；各分量预测误差<.00022。证据：c8-derivative-vectors/helper-lane-analysis.json。此结论仅针对当前设备、后端、源和 quad，不泛化到其他 GPU。

显式诊断叶六步核查：全仓无 quadBroadcast/Swap 或屏幕仿射法线分子重建能力；Vertex/DirectDisplayVertex 已有未归一化插值 normal 与 fragment position.w，无新合同字段；不添依赖；全部11个 PBR fragment入口可在分支前取样；现有S6–S8观察器与实测附件复用；规格已记录当前不足。已有观察平台不重建，新增独立叶仅检验显式下行/左列是否解释残差，生产与当前 S6 observer 不动。

[WGSL §17.6](https://www.w3.org/TR/WGSL/#derivative-builtin-functions) 允许默认导数选择 Fine/Coarse，未规定粗导数固定行；非一致控制流产生不定结果。[GLSL ES3.00 §8.9（PDF页110）](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf#page=111) 允许方法随窗口坐标变化，二阶和混合导数为 undefined。WGSL未找到同样的二阶禁令，但也未保证嵌套Fine导数返回所需的另一行差值，不能据“可编译”推导portable等式。[WGSL §15.6](https://www.w3.org/TR/WGSL/#collective-operations) 的 quad通信仅由 active invocations参与，helper参与存在设备差异。因此不采用嵌套导数或 quad交换作为生产补偿。

候选只对未扰动几何法线：透视插值 normal 乘 position.w 得屏幕仿射分子；一次 x/y Fine 导数建立同一三角形平面，按像素奇偶显式求 quad下行/左列两端并归一化。[position.w定义](https://www.w3.org/TR/WGSL/#position-builtin-value) 支持该分子重建。其零绑定、零纹理、零新增varying；仍两次一阶导数，另增3次 safeNormalize（共享左下端点）、1次view矩阵变换、分子/平面加乘和像素奇偶计算，真实耗时未测。该算法固定的采样行只是当前原Three行为的诊断假设，不能宣称所有设备原Three一致；MSAA、非零/分数viewport、退化法线、切边与Web/Native/RT/分层全族尚须实测。任何生产接入须在所有fragment入口前置计算，再保留core/包装绑定隔离；不得在材质分支内取导数或只补一条路径。

新增独立四个lab源：c8ExplicitDerivativeShader.{ts,test.ts} / c8ExplicitDerivativeProbe.{ts,test.ts}。CPU 7/7、lab tsc、runner语法通过；变体合同覆盖3个相机/FOV和mesh位移/旋转/非均匀缩放，以同primitive ray-plane barycentric法线为独立oracle，包含helper外推。正式 vertex 已对模型矩阵转换后的法线 normalize；候选必须取 fragment 的原始插值v.normal，不能取 orientedNormal 后单位向量。11入口全部守卫，normalmap仅扰动光照法线不改变该几何输入；变形/skin/分层生成源仍须通过原full-source guard，本叶当前只允许canonical sceneShader，未宣称这些额外族已实测。

root GPU入口：`node test-output/c8-explicit-derivative-diagnostic.mjs`（本地ignored orchestration）；4模式far front/oblique、2stage、2fresh，共32帧对/64实际帧。复用正式fixture/observer安装、实际GL编译和GPU模块hash守卫；记录candidate标签与实际替换计数，始终qualityCertified=false；只写c8-explicit-derivative附件，不覆盖旧S6/S8/S5证据。候选shader/probe/runner已冻结；root13:11实跑exit0，两fresh附件/收据逐值相同，stable=true。

12:55新S6两fresh已实读，CPU重新索引后 far斜(198,64) 当前roughness仍为 .98046875/.98828125，nv/nl同值，single差 .0025634765625；上述 .0025733249055 独立预测现已由当前测量支持，历史输入不确定性解除。当前 near front(62,40) geometry与single两个half观察均相同，而完整final red差 .00390625；故导数候选即使通过远端也不能自动关闭近端总HDR门。CPU解释仍不能替代f32中间观察或生产全链实测。

## 候选 GPU 诊断结果（已验证，不进入生产）

当前RTX/后端的 far斜(198,64) Three与候选Deep逐值相同：dx [.054656982421875,.0213165283203125,.080810546875]，dy [.00038051605224609375,.0740966796875,.06591796875]，rough-single [.98046875,.146728515625,.12396240234375]。来源：c8-explicit-derivative/rounds.json与analysis.json；沿当前S8同一3×3共同覆盖内部mask比较，未调整阈值或筛点。

| 当前far视角 | 观测 | 正式default最大差 | 显式候选最大差 |
|---|---|---:|---:|
| front，5027内部像素 | dx | .0093994140625 | .000030517578125 |
| front | roughness | .00732421875 | .0001220703125 |
| front | single R/G | .00146484375 | .000244140625 |
| oblique，4328内部像素 | dx | .013763427734375 | .000152587890625 |
| oblique | roughness | .01220703125 | .00048828125 |
| oblique | single R/G | .0025634765625 | .0009765625 |

两轮截图已读取，场景/材质观察一致；第二轮页面文字未被截图合成，不能据该页给产品视觉评分。数值附件与GPU/GL收据完整且逐值稳定。该结果确认当前设备的采样行是远端主要残差来源；不是完整C8 strict HDR、近端、其他适配器、Native/RT/分层/变形或性能验收。root明确保留生产冻结，本叶维持qualityCertified=false。

后继必须独立覆盖near两视角、完整raw/shared-half S5总色、多设备采样行变化、MSAA/viewport和退化法线尺度、skin/deform/normalmap/layered/Native/RT族，并测新增3次归一化的帧时成本。若进入生产，优先将公式放无绑定core，再由各fragment包装在分支前seed；不能把RTX下行约定写为跨设备规则，不能只靠现有far fixture决定长期材质语义。

最终冻结：原七项合同/观察叶保持；新增c8ExplicitDerivativeShader.{ts,test.ts}、c8ExplicitDerivativeProbe.{ts,test.ts}与本地ignored runner冻结。CPU7/7、lab tsc/语法/diff检查通过；本线未改生产、原Three、容差或全局进度，未commit/push。

## S5 raw 实际附件精度后继核查

2026-10-01近front单ULP任务六步：①全仓src/lab/scripts含未跟踪文件检索raw/reference32/rgba32float，已有C8 raw标签与独立显示F32 probe；②contracts/scene与RenderView无需新字段，PbrFrameReadbackSnapshot已有GPUTextureFormat/bytesPerRow/bytes合同；③既有Three/WebGPU/esbuild足够；④runSharedSceneProbe→PbrRenderer→readSharedDeepFrame为真实消费链，S6–S9复用同叶；⑤已有frameCapture/readback/renderTargets合同测及当前S5/S6/S8两fresh附件；⑥已读S5/S6规格、本核查与恢复台账。已有平台不重建，真实缺口是Deep raw的实际格式披露和实际前量化F32观察，不是缺少Float32Array容器。

定位：raw选项只令Three使用FloatType WebGLRenderTarget与Float32Array读回；shared-rgba16f只将Three改为HalfFloatType与Uint16Array。Deep创建选项和渲染目标完全不随此标签变化，RenderTargets的opaque-hdr固定PBR_HDR_FORMAT="rgba16float"，当前fixture的零值authorColorEffects.colorGrading对象使directDisplay禁用，writeGeometryBuffers=false，走Deep HDR opaque color单色附件。后处理全禁用且无透明，present-color映射同一opaque-hdr。readSharedDeepFrame显式强制snapshot.format==rgba16float，再decodeFurnaceColor将binary16转换为Float32Array数字；转换不会恢复已丢失精度。

所以当前raw真实对照为Three RGBA32F versus Deep RGBA16F→CPU Float32Array，不是双方BRDF F32前量化输出。raw帧还未写hdrFormat字段；表面raw/profile标签不应当作precision合同。shared-half是真实双方RGBA16F。当前近front single/rough half相等仅说明落在同一half台阶，不能证明其f32值相等，也不能将final一个ULP直接归因multiple或合理量化下限。现有S5门不调整；后继F32只作诊断旁证。

CPU实读attachment-format-audit.json：near/front、near/oblique、far/front、far/oblique四组Deep raw/half全部184320分量逐值相同并精确落在binary16格；Three raw的binary16格分量分别132127、138421、166836、169090（含背景0）。因果由源码明确的附件路径确定，格网统计作独立佐证。

最小接线建议：复用既有C8 shader全源/单接缝守卫，在独立诊断GPU包装中仅为canonical plain/depth/ccw、fragmentMainColor、sampleCount1、单色opaque pass增加一个location1 RGBA32F witness；原location0 RGBA16F总色与下游显示链保留。single在正式首次color计算后保存局部值，multi保存正式multiscattering乘光色/强度/visibility的表达式结果，full保存正式shade返回值；禁止从两个累计总色相减估算multi。三种模式顺序跑，不同时添加三个F32附件。

该pass实际24 bytes/sample（原16F8+32F16），低于[WebGPU默认32上限与格式表](https://raw.githubusercontent.com/gpuweb/gpuweb/main/spec/index.bs)。F32仅RENDER_ATTACHMENT/COPY_SRC、无采样、无blend，不需要float32-filterable或float32-blendable。复用encodeFrameCaptureTextureReadback旁路票据而非扩大PBR白名单；须在同encoder的pass结束后、finish前编码copy，并在该commandBuffer实际submit后readAfterSubmit。记录实际GPUTexture.format、bytesPerRow、module/pipeline/pass/count/hash、相机/packet/root、前后RGBA16F/显示一致与资源销毁；任何descriptor偏离明确拒绝。不得把后处理F16纹理复制到F32冒充前量化见证，或只改createTexture而让正式filtering布局消费RGBA32F。

Three侧沿现有观察平台仅增加F32诊断目标和single/multi/full观察输出，原RE计算/材质/曝光/默认导数保持；full已有S5 RGBA32F消费链可复用。新增观察的full应与原raw Three附件同源实测比对，Deep witness的full应与同pass16F按真实附件舍入关系对应。最小首跑仅near/front原fixture三模式两fresh，保留全部帧和(62,40)single/multi/full F32样本；随后再按缺口扩大视角，不据该点关闭完整画质或性能。以上为只读方案，未接线、未新增GPU比较门、未改旧runner。

另有既存09/30 22:59的probe-gi-actual/storage-conversion/evidence.json：同RTX已执行同no-arithmetic f32片元输出到RGBA32F witness/16F附件；32F逐值保真，sampleCount1/4的8个16F值均allRTZ=true、allRTNE=false。该历史独立观测不能替代当前BRDF量化见证，但足以提示不可将nearest-half默认成唯一实际store规则。当前新C8 F32旁证必须重新记录局部真实32F→16F结果，并保留设备/后端身份。

## 同 pass F32 见证实施：现状核查

root已授权独立lab包装。六步复核：①src/apps与未跟踪叶已有C8 shader/probe，但无同pass BRDF F32见证；②复用FrameCaptureTextureSnapshot与票据合同，contracts无需扩展；③现有Three/WebGPU/esbuild/playwright依赖足够；④沿runSharedSceneProbe与实际plain/depth/ccw管线消费，旧S5–S8不改；⑤复用readback测试与当前两fresh附件，新增精确shader/descriptor/票据时序合同；⑥本规格的精度审计、原交接与恢复台账保持权威。已有场景、读回和源码守卫不重建；真实缺口仅为正式shade实际值写入同pass RGBA32F。

实施限定：原location0与原Three full32均保留，单个location1分single/multi/full模式；仅canonical vertexMain/fragmentMainColor、plain/depth/ccw、single-sample、无blend单色HDR pass。Three single/multi F32尚不在首轮范围。旧fixture固定两视角两stage，首轮保留全帧，优先分析near/front(62,40)；3模式两fresh共24帧对。诊断qualityCertified=false，root负责GPU队列。

已接线并冻结：lab/c8F32MrtShader.ts、c8F32MrtDevice.ts、c8F32MrtProbe.ts及两份CPU合同；独立入口`node scripts/c8-f32-mrt-witness.mjs`。原fragmentMainColor保持完整，另加同body双输出入口，仅精确canonical pipeline切入该入口。single保存首次color计算；multi将原完整表达式赋局部值再用同值累计；full保存原返回表达式，均为同次shade执行。无新绑定/纹理采样/生产接口，新增32F附件只RENDER_ATTACHMENT|COPY_SRC，原16F附件对象与描述保留。

包装维持实际device/queue/encoder/pass对象身份；精确格式/extent/单采样/深度/颜色管线守卫拒绝变体。pass结束后、同encoder.finish前复用正式encodeFrameCaptureTextureReadback，实际queue.submit后启动map，格式/stride/长度逐项验证，CPU按IEEE F32原字节读取，票据与纹理有销毁路径。actual module/pipeline/pass/indexed-draw/submit与原Three编译收据均记录；原Three只调用既有chunk守卫，RE/output不注入。运行将记录与当前S5 near raw基线的root/packet/profile一致、总色/显示数值差，三模式原输出及两fresh结果必须逐值一致；未先行宣称新增见证是GPU编译位中性。

CPU15/15（新8+旧observer7）、lab tsc、runner语法、diff检查通过。全仓source-size仍报既有19个>800行文件，本线新叶均远小于800行。未改生产/src或WASM/正式source快照。输出目录test-output/interrupted-0930/c8-f32-mrt-witness，包含完整rounds和模式样本/实际format/源码hash收据；日志建议test-output/jc-i-20261001-c8-f32-mrt.log。Three single/multi F32与性能、跨设备、变体覆盖仍未测，不关闭C8。

root首跑发现snapshots5/runFrames4/compileHashes12，passCount5/drawCount10/submitted5；初版把实际验证帧同四个对拍帧一一对应，故在收据检查停下。补详细计数后确认prepareScene→runtime.validateFrame→render会执行独立初始化帧。修复保留全部五个同pass32F附件：第一个明确validation，后续由既有observeThreePrograms回调在backend.render前显式arm下一opaque pass；该scope按stage/camera/exposure严格四次命名，再逐项核对run.frames的实际名称，不按末尾数组截断或丢验证帧。票据frameId来自各encoder局部pass，独立validationWitness完整写入rounds；额外六个验证帧计入实际工作量。三模式两fresh共24个对拍帧对、六个Deep独立验证帧，54次实际渲染。

修复后CPU16/16（新9+旧7）、lab tsc、runner语法、独立browser esbuild(write:false)通过，重新冻结入口。root待复跑；实际GPU附件能读回不等于近frontF32归因或画质门已完成。

## 同 pass F32 真机结果与 CPU 归因

root最终GPU日志jc-i-20261001-c8-f32-mrt-final.log exit0；两fresh稳定，qualityCertified=false。三模式原输出逐值同；对当前S5基线12组preservation的Deep16总色、Deep显示、Three原full32最大差全部0。每模式实际1module/1canonical pipeline、5pass/10indexed draws/5submitted，初始validation完整留存，4个显式命名帧按票据frameId准确对应。

CPU analysis.mjs/json实读115MB rounds附件，复用原S5阈值.004与3×3双端共同覆盖mask，仅去画布边界/覆盖轮廓，不排三角形接缝、不筛掉高误差点。以下只记录诊断值，原strict .002门不变。

| near视角 | 稳定像素 | full32最大差 / p99 | Deep32→16最大store差 | shared16最大差 | F32超过.002 / half超过.002 |
|---|---:|---:|---:|---:|---:|
| front | 15987 | .001613616943 / .000098049641 | .003636837006 | .00390625 | 0 / 1 |
| oblique | 13981 | .005125999451 / .000128865242 | .003472328186 | .0078125 | 6 / 6 |

front(62,40)真实Deep single32R=6.067386627197266，multi32R=1.1078631345640133e-9，full32R=6.097386837005615，原Three full32R=6.099000453948975。两真实F32差.001613616943359375；Deep位于half边界6.09765625下方，actual16向零存为6.09375，而Three shared16为6.09765625。该点真实存储放大使shared16超门，不能由single/geometry half相等推出BRDF F32相等；也不能凭该front点宣布所有残差均为存储下限。

oblique(76,46)Deep single32R=6.595989227294922，multi32R=1.3522818420597105e-9，full32R=6.6259894371032715，Three full32R=6.620863437652588，真实F32差.005125999450683594；shared16两端6.625/6.6171875。稳定域超F32门的6个lane来自(76,45)/(76,46)三个RGB分量，前量化已有差异。两点multi极小，不能解释其single量级残差；Three single/multi32仍未直接测量，继续保留这个证据缺口。

Deep当前RTX实际store：front47961/47961、oblique41943/41943稳定lane均等于真实F32的binary16正值向零下邻，RTNE相符lane仅21375/20335，其余不符；不是默认nearest舍入。仅限当前正radiance、sample1、当前设备/后端。所有稳定lane的Math.fround(Math.fround(actualSingle32+actualMulti32)+float32(originalEmission))与actualFull32逐值同，最大差0，未发现隐藏后处理/额外直射项。该CPU恒等检查只覆盖当前fixture功能集。

全场multi不为零：front/oblique max=.0202466305/.0202809069，最大full占比7.2646%/7.3094%，主要粗糙金属material2；低roughness material0在最坏点为10^-9量级，但全material0最大仍约3.0e-6。此证据限定为最坏近端点不是multi主因，不能泛化取消或宣称全场multi无意义。

后继最小F32原语入口（只读方案，源保持冻结）：复用当前单个32F同pass附件、旧完整loc0、精确arm/readback与hash守卫，顺序模式输出实际未编码n/view/rough/dx/dy；不再复用RGBA16F旧观察结果当F32原语。n与view取shade现有safeNormalize的实际局部值；geometry-view normal取deepGeometryRoughness实际normal参数（正式view变换后的值）；rough取正式shade实际rough。可将rough放n或view的第四分量，减少模式数；另以brdfWithDielectricF0现有nv/nl/nh/vh四个实际局部变量记录dot-inputs，禁止用其后重算值冒充原计算。dx/dy则在现有默认abs(dpdx(normal))/abs(dpdy(normal))处保存各实际一阶向量，并用同值构造原max，不改为Fine/Coarse/候选、不引入嵌套导数。新增mode都须保持12组原输出保留检查，否则先解释编译变化。

Three侧可在独立后继观察器复用原观察接缝守卫并使用既有FloatType目标，采样正式geometryNormal/geometryViewDir/实际material.roughness和默认dFdx/dFdy；只改变诊断输出，不改原RE算式/曝光/材质。world n/view与Three view-space数据必须按原矩阵转换到同坐标后比较，既有half `view-normal`的0.5编码不得被直接解读为原F32normal。先near/front与oblique全稳定域，特别(62,40)/(76,45)/(76,46)，用真实rough与BRDF dot输入区分导数采样、法线插值/归一化、视线插值/归一化和GGX高光放大；在这些原语前量化观测完成前不实施生产补偿，不修改Three或门阈值。

near oblique六个超.002 lane的具体依据（primitive-analysis.mjs/json）：原fixture低roughness dielectric球material0，authored rough=.15、metal=0。CPU按原24×16球索引三角形、near oblique相机与pixel-center ray计算；该CPU face ID为几何定位，尚无实际GPU primitive-id附件。

| 像素 | 实际Deep32−Three32 RGB | 当前S6 Three/Deep rough16 | CPU本像素face | quad内CPU face |
|---|---|---|---:|---|
| (76,45) | +.003993511200 / +.003793716431 / +.003593444824 | .190185546875 / .1900634765625 | 276 | 上行229/229，下行276/276 |
| (76,46) | +.005125999451 / +.004868984222 / +.004612445831 | .1904296875 / .1903076171875 | 276 | 上行276/276，下行277/276 |

两quad跨三角形而3×3仍位于同球覆盖内部；对本face276作同primitive-plane外推，(76,45)上行bary第三分量负，(76,46)左下bary第一分量负，明确存在helper外推。按原插值法线归一化与view矩阵，CPU上行/下行max(abs(dx),abs(dy))加.15分别为.190124257352/.190294841920与.190406307095/.190457161136，均落在对应Deep/Three当前half台阶区间。它支持此前RTX上行/下行采样差的后继方向，但不能替代GPU F32rough/dx/dy或宣称跨设备默认导数固定行。现有half nv/nl同值也仍不代表其实际F32相等。

本线最终冻结：c8F32MrtShader/Device/Probe及test、scripts/c8-f32-mrt-witness.mjs保持最后GPU通过的sourceIdentity；新增的analysis/primitive-analysis仅CPU ignored附件。本次完成真实格式/数值定位与后继原语方案，C8仍开放，未继续新lab/GPU/生产改动。

## Exact F32 inputs：现状核查与可执行观察器

六步现状核查先写于ignored scratch AUDIT.md，root解除最终J5冻结后批准提升：①全仓src/apps/lab/scripts和未跟踪叶已有同pass single/multi/full，无exact inputs模式；②FrameCaptureTextureSnapshot/同encoder票据已含format/stride/bytes，contracts无需扩展；③现有Three/WebGPU/esbuild/TypeScript/Vitest足够；④runSharedSceneProbe正式PbrRenderer与已验证MRT是实际消费链；⑤复用CPU16/16和两freshMRT附件及原输出0差证据；⑥读取本规格/当前近端primitive分析及交接恢复链。已有device/pipeline/pass/arm/readback平台不重建，真实缺口仅为实际n/view/rough/default dx/dy/BRDF dot局部变量32F。

先在test-output/c8-f32-inputs-20261001隔离实现，CPU8/8、独立tsc与browser esbuild通过；root批准后只提升lab/c8F32InputsShader.ts、c8F32InputsProbe.ts、c8F32Inputs.test.ts与scripts/c8-f32-inputs.mjs。既有MRT包装、旧观察器、正式WGSL、原Three、旧门不改。提升后CPU8/8、lab tsc、runner syntax、browser bundle再通过；九项旧source/test SHA-256前后相同。

六模式实际数据：normal=[shade真实n,rough]、view=[shade真实view,rough]（二者world空间），geometry-normal=[deepGeometryRoughness真实normal参数,rough]（view空间），dx/dy=[实际默认abs(dpdx(normal))/abs(dpdy(normal)),rough]，brdf-dots=[正式BRDF局部nv,nl,nh,vh]。默认一阶x/y各执行一次，原derivative max直接复用同值；不改Fine/Coarse，不引入嵌套导数。第四分量是原始rough或vh，覆盖范围只依赖原color附件，禁止当alpha/primitive-id。capture点保存既有计算局部值，禁止另算替代值。

既有MRT device返回native对象，外层只对其已守卫full观察模块做精确hash替换；receipt分开原生产hash、旧full instrumentedHash和最后实际输入模块hash，替换计数须等于实际moduleCount。完整保留validation与四个同scope显式命名帧。原Three原full32/显示不注入，runner对S5原root/packet/profile和四项完整像素输出逐值守卫：Deep16总色、Deep显示、Three full32、Three显示全部最大差0；六模式原输出与两fresh附件/收据逐值同。失败证据按时间戳追加并保留，qualityCertified=false。

root GPU入口：`node scripts/c8-f32-inputs.mjs > test-output/jc-i-20261001-c8-f32-inputs.log 2>&1`。6模式两fresh，每run四Three/五Deep，共108次实际渲染；输出test-output/c8-f32-inputs-20261001/gpu-output/{rounds,evidence,failure-<time>}.json，重点(62,40)/(76,45)/(76,46)，全帧保留。GPU待root执行，原Three exact F32 inputs尚缺，不能将旧Three half观察当精确F32或将CPU primitive ID冒充GPU观察。生产/画质/性能未关闭，源重新冻结。

## Deep exact F32 inputs：实测与 CPU 复算

root实跑正式入口exit0；两fresh stable=true、qualityCertified=false。实读gpu-output/evidence.json与264.7MB rounds，15项正式源SHA当前全部匹配；24组原输出保留的Deep16、Deep显示、原Three full32、Three显示四指标全零。六模式五种rough第四分量逐值同；默认abs dx/dy的max加float32(.15)经逐步F32恰等于实际rough，没有观察模式带来的rough漂移。

| 近端像素 | actual rough32 | default主导导数 | 现有MRT full32−原Three full32 R | 非融合逐步F32 single复算与实际single最大误差 |
|---|---:|---|---:|---:|
| front(62,40) | .18505500257015228 | abs dy.y=.035054996609687805 | −.001613616943359375 | 0 |
| oblique(76,45) | .19011113047599792 | abs dx.x=.04011112451553345 | +.003993511199951172 | 2.384185791015625e-7（G一个ULP） |
| oblique(76,46) | .1903931349515915 | abs dx.x=.040393128991127014 | +.005125999450683594 | 9.5367431640625e-7（R两个ULP） |

actual n/view/geometry-normal的单位长度误差均小于1e-7。将实际rough及正式BRDF dot locals传入既有dfg185DirectAt/directMultiscatteringEnergy生产CPU参考，三点实际multi32最大差不超过9.36e-14；将同组实际dot和rough传入独立非融合逐步F32主GGX闭式，single复算分别0/1/2ULP。该验证把残差定位到实际direct single输入/高光计算链；非融合CPU不是GPU算术oracle，FMA/exp2舍入仍可能不同。当前仍缺原Three真实F32 inputs，不能据CPU或旧half数据指定最终根因。

CPU helper-plane下行rough单变量反事实固定实际Deep dots，预测oblique两点fullR−Three约−.000825165/−.000148718；只说明导数候选有足够敏感度，不是已实测Threerough或生产数值补偿。front实际主导dy，单改dx行不会解释该点；其真实F32与实际16F store放大继续分别记录。CPU primitive face ID仍只是几何定位，不冒充GPU primitive-id。完整ignored只读报告：test-output/c8-f32-inputs-20261001/input-analysis.{mjs,json}。

## 原 Three exact F32 inputs：独立草稿现状核查

按root后继指令仅在test-output/c8-three-f32-inputs-20261001实施；AUDIT.md记录六步全仓、契约、依赖、消费者、CPU/GPU证据与规格核查。已有原Three FloatType目标/原生读回不重建；真实缺口是共享probe只保留RGB，故无法从第四分量直接取rough/vh。新独立wrapper截获renderer构造器的instance读回方法赋值，以原this/函数/目标/Float32Array调用读回，并保留完整RGBA第四分量；原方法完成后查询当前真实HDR framebuffer RGBA componentBits，四项必须32。Float32容器不独立证明纹理精度，真实16bit附件必须拒绝。

草稿六模式在生产installer后requestAdapter接缝注入原Three诊断chunks，复用既有原RE/opaque/default-derivative守卫并增加common/pars/physical/opaque完整chunk SHA；抓取原view-space n/view/nonPerturbedNormal、默认abs dFdx/dFdy、actual material.roughness与BRDF_GGX nv/nl/nh/vh。dx/dy各执行一次，原max复用同值，不引入候选采样行或新BRDF表达式。实际GL编译收据要求原RE/BRDF全函数、capture、opaque与default max均存在。Deep只复用冻结full MRT，原16F/显示/full32不改。

原Three诊断输出标为inputs32，不命名full颜色；每fresh先独立page跑未插桩full基线，记录原真实RGBA32全色及编译收据，再六模式各独立page。两fresh全部逐值一致；4baseline四项原输出0差、24diagnostic帧Deep16/显示0差、Deepfull32跨模式0差。原Three完整full基线来自另一pass，不能声称诊断pass同时保留full颜色或GPU编译调度完全位中性。当前正式15源SHA核对全部相同；草稿CPU9/9、独立tsc、browser bundle、runner syntax通过，GPU尚未执行。

待root最小提升两lab模块、CPU叶与独立runner（PROMOTION.md）；当前ignored入口node test-output/c8-three-f32-inputs-20261001/runner.mjs，两fresh×(一个原基线+六模式)×9实际渲染=126帧。GPU由root串行，原Three材质/曝光/相机/数学基准、生产WGSL和旧门不改；无GPU primitive-id、性能或画质认证。

## 两端 actual F32 输入归因与近端候选实测

root运行ignored Three入口126实际帧exit0，两fresh stable=true、qualityCertified=false；实际32-bit framebuffer component守卫通过，24诊断组Deep原16F/显示0差、4独立原full基线四项0差、Deep full32跨模式0差。Three inputs诊断与原full来自独立pass，编译器调度可能不同，不能声称输入插桩保留同pass原full。全部消费源SHA当前匹配，原Three材质/曝光/BRDF不改。

cross-analysis.{mjs,json}用两端actual rough/dot输入及独立逐步F32闭式，分开输入差、算式图差与未解释GPU余量。数字为R lane带符号贡献；两种顺序平均分解rough/dots以保持总差守恒，不把非融合CPU当GPU oracle。

| 焦点 | Deep−Three actual rough32 | measured full32差 | 输入模型差 | rough贡献 / dots贡献 | 算式图贡献 / 未解释余量 |
|---|---:|---:|---:|---:|---:|
| front(62,40) | −4.470348358e−8 | −.001613616943 | −.001748561859 | −.000006198883 / −.001742362976 | −.000000476837 / +.000135421753 |
| oblique(76,45) | −.000170543790 | +.003993511200 | +.003898620606 | +.004375219345 / −.000476598740 | −.000000476837 / +.000095367432 |
| oblique(76,46) | −.000050827861 | +.005125999451 | +.004899978638 | +.003974914551 / +.000925064087 | 0 / +.000226020813 |

近斜视两点rough差恰等于默认abs dx.x差；近前视主导dy.y，两端rough仅3 F32 ULP，dotNH差2 ULP被GGX高光放大，不能由改dx行解释。Three single/multi未直接读回，当前按原full减CPU项只属于推断。多次normalize/插值/编译链仍需独立定位，不能用fragment换坐标基底宣称已同输入。

whole-input-audit对原3×3双覆盖>.004稳定域全部6材质进行actual输入核查：front15987/oblique13981像素，双方actual rough恰等于 min(1, float32(authored rough+max(actual default abs dx,dy)))，全域0不符。default dx最大差 .008731365204/.010658204556，dy两视角最大差2.980232239e−7，geometry-normal最大差2.384185791e−7；全域rough最大差 .007296204567/.008335232735。覆盖内部三角形接缝保持入门，CPU face ID不充当GPU primitive-id。当前RTX观测可解释跨宿主默认导数行不同，不推广为所有设备的固定行规则。

候选现状核查六步在ignored AUDIT.md追加：已有MRT/源守卫/12个canonical片元入口/原Three基线不重建；生产合同、依赖无扩展。ordinary实例实际经renderPacketBatches::packTransform→instanceTransform：world matrix先F32，再CPUdouble逆转置，法线列再F32；Three以原double modelView逆转置后上传。front球/相机线性基底identity，故不能以矩阵组合顺序解释该点。真实缺口为全域采样候选验证与actual shared-half参考。

root执行near-candidate-raw 72实际帧，两fresh稳定。B仅将safeNormalize安全输入换builtin normalize，actual full32/stored16全帧逐值与baseline相同；AB与A全帧相同，B/AB停止扩展。A复用先前affine helper-plane显式bottom dx/left dy：3次额外normalize、无新绑定/采样/varying，只当前canonical实验，Native/变体/性能未验收。

| A near域 | F32最大差 baseline→A | F32超.002 lane | Deep16−原Three32最大差 baseline→A | stored超.002 lane |
|---|---:|---:|---:|---:|
| front | .001613616943→.001610755920 | 0→0 | .005250453949→.005250453949 | 4→4 |
| oblique | .005125999451→.001155376434 | 6→0 | .004136562347→.002689838409 | 8→2 |

F32 p99降至front .000002920628 / oblique .000002875924。全稳定域front 10196 lane改善/2104恶化/35661相同，oblique8896/1922/31125；最大F32误差恶化分别5.245208740e−6与1.803040504e−6，无新增F32超门点。存储却有两个新增raw坏点，保留而不删：oblique(76,45)B actualFull32=4.514066219330、Deep16=4.51171875、原Three32=4.514408588409，F32差.000342369079而stored差.002689838409；(76,46)G actualFull32=6.230169773102、Deep16=6.2265625、原Three32=6.229072093964，F32差.001097679138而stored差.002509593964。这两点需要actual Three16F参考；CPU nearest只可解释store，不能替代实读参考。

候选整幅输出变化也记录：A direct front改变961 HDR/81 display/13086 full32 lane，最大改变量.0185546875/5/.018504440784；oblique963/86/11447，.009033203125/2/.009081542492。包含覆盖边界，不能将这些数同稳定域byte门混用。strict-emissive两camera整幅HDR/display/full32改变数和最大差全0。A实际正radiance store稳定lane front47961/oblique41943全部为binary16下邻，nearest相符仅21371/20349；外部格式转换端点不符0，max store差.003639698029/.003607273102。归因限定当前设备/正值/sample1。

## 完整 C8 门与精度政策复核

六步沿现有生产/Native/apps/scripts/lab、合同、依赖、消费方、GPU/CPU附件、S5/S9/本规格核查并写ignored AUDIT。全仓没有 pack2x16float/unpack2x16float/quantizeToF16 生产策略，不新建或假称已有共享舍入政策。已有CPU half工具与GPU storage-conversion证据不等于生产采用。当前[WGSL浮点准确度](https://www.w3.org/TR/WGSL/#floating-point-accuracy)将correctly rounded定义为可选上下邻，[转换规则](https://www.w3.org/TR/WGSL/#floating-point-conversion)也不指定方向；pack/quantize builtin不保证nearest-even，subnormal也有flush许可。不能仅靠builtin名称推断实际附件RN。

现有生产hdrEnvironmentUpload.ts的私有CPU createHalfConverter只打包HDR环境纹理输入；mantissa最低保留位用于向上舍入，ties不是even，不是片元HDR输出合同。保留该输入能力，不将其存在误写为已有共同shade/store精度策略。

CPU near-candidate-analysis复用原compareSharedScene和compareDirectMaterialChain，未改门/原Three。A原raw strict执行仍失败：front HDR .005250453949、oblique .002689838409；两个视角稳定域display byteMax均1、maskMismatch0、稳定像素数与原门相同。strict-emissive cross-host raw最大差.000292956829、byteMax0，两端直射贡献覆盖分别16242/13795，满足原最低1000。runner passed/stable仅证明诊断及fresh稳定，不是画质通过。

S5真实最终pass由原Three-r185、near/far、实际shared-rgba16f所有格的strict quality决定；raw FP32控制独立保留，actual Three HalfFloatType/Uint16读回不能用CPU量化替代。LD-15在j3DFullLayerMatrix中为status=diagnostic，只随聚合legalDifferenceMatrix返回，没有C8 HDR阈值豁免；其规则还要求已同数值路径、half台阶与邻域混合符号，当前不能凭front单点推广整个域。near候选尚缺far矩阵/S9/local完整灯族/Native/变体/性能，C8仍开放。正式源/旧门/原Three/已运行候选源保持冻结，本线只更新CPU附件与规格。

## A actual shared-half 最终审核

root独立72实际帧exit0，passed/stable=true、qualityCertified=false。24项消费源SHA全部核对；raw与shared每策略四帧的Deep full32/原16F/显示逐值同（16组控制最大差0）。原Three16F为实际HalfFloatType附件，不用CPUnearest。B与baseline、AB与A在这批actual full32/stored16仍全array相同。

直接执行未改compareSharedScene和compareDirectMaterialChain：A near front/oblique最大HDR差均.00390625，门失败；display稳定域byteMax均1、maskMismatch0，strict-emissive全部stable lane跨端差0。front坏lane1→1、oblique6→2；无新增actual shared16坏lane。先前raw两个新增混合精度坏点(76,45)B/(76,46)G在实际shared16差均0，不能以raw混精度统计代替门。

| A 剩余 actual shared16 坏点 | Deep full32 / actual16 | 原Three独立32 / actual16 | 前存储signed差 | 最终16F signed差 |
|---|---|---|---:|---:|
| front(62,40) R | 6.097389698029 / 6.09375 | 6.099000453949 / 6.09765625 | −.001610755920 | −.00390625 |
| oblique(76,46) R | 6.622018814087 / 6.62109375 | 6.620863437653 / 6.6171875 | +.001155376434 | +.00390625 |
| oblique(76,46) B | 6.504910469055 / 6.50390625 | 6.503871440887 / 6.5 | +.001039028168 | +.00390625 |

store signed分解分别为Deep−F32 / Three16−独立Three32：front −.003639698029 / −.001344203949；oblique R −.000925064087 / −.003675937653；B −.001004219055 / −.003871440887。两端实际附件都出现向零store，不能据前量化差小于.002宣称已相等；Three独立32是另一pass，分解保留此边界。

A剩余oblique R/B的3×3实际16F残差仅中心+.00390625，8邻为0；front邻域中心−.00390625、右上−.00048828125，其余0。最坏局部没有混合符号，不满足LD-15所写邻域条件。全域front正63/负29/零47869，oblique正47/负32/零41864；全场混合符号不替代最坏点的局部证据。完整逐值坏点/邻域/原门结果保留near-candidate-shared-half-analysis.json。

## front normal / dot 后继 CPU 核验

root继续锁观察器，后继草稿独立位于test-output/c8-front-normal-20261001，AUDIT.md完成六步；不改实际GPU消费源。actual front n长度Deep .9999999112614174、Three1.0000000340565978；单位方向最大差5.74646e−9。使用actual n/view、同author light与CPU推断h，单位角度NH两端 .9998044570695462/.9998044565924066，均舍入到F32 .9998044371604919；实际消费NH却 .9998043775558472/.9998044967651367。说明近front现象与长度/half-vector/dot舍入相容，而不是已证明表面几何方向物理错误；actual h与raw varying尚未读回，不能指定最终产生ULP的阶段。

复用真实cameraMath/packTransform进行CPU顶点链核验：front焦点三角形的两端clip x/y/w模型逐值同，省略硬件raster subpixel时CPU法线共同偏约2.9e−5。预登记4/8/12-bit screen snap模型后，8-bit模型在三焦点最大实际法线误差≤5.96046e−8（front x绝对误差2.9e−8、相对其小值是数十ULP），4/12-bit明显不符；只支持当前硬件的8-bit采样解释，不是GPU primitive-id或插值oracle。CPU face274/276仍是射线几何定位；两次fragment normalize的CPU模型front恰无变化，不能以省略一次normalize宣称已修。

独立Lagrange cross GGX分母候选用norm-product归一化cross长度，保留原distribution下限、rough/visibility/Fresnel；无相机/点位/材质分支。[Filament官方说明](https://github.com/google/filament/blob/main/docs/Filament.md.html)采用cross处理1−NH²在高光区的消去。本草稿5项CPU测试通过，包括连续方向/非单位缩放/半球clamp与原下限；CPU全域delta-D模型front最大差 .001613616943→.001213467488，但(61,41)R恶化 .000375358054；原rough oblique最大差 .005125999451→.005920274096，原6坏lane未解。不能只报front改善，更不能以该单策略反例否定A已修rough后的组合；A+cross需actual h32与真实全域输出验证。仅拆开原1−NH²算式的模型反而front max变为.001912310562，未推荐。

候选h/light与非融合CPU运算仍是推断，delta-D加入实际Deep原full32只是敏感度模型，非GPU候选颜色。下一最小观测复用32F同pass槽，按actual raw interpolated normal→oriented/shade-input normal→BRDF actual h分别采样，Three保持独立原full基线；完整原输出守卫仍必需。生产/阈值保持冻结，C8仍开放。

## A+cross 与 actual h/raw 可执行草稿冻结

root批准继续独立ignored候选后，仅在c8-front-normal-20261001实施frontCandidate.ts、runner.mjs。已有A和baseline由冻结buildNearCandidate复用；A+cross只替换唯一GGX denominator，保留原alpha/a2/distribution下限以及Fresnel/visibility/rough。CPU反向替换后整个shader与A逐值同，原normal/math/exposure无调整。新增一cross、三dot、norm-product除法与clamp/select；无新绑定/纹理/varying。成本尚无GPU性能收据，不声明生产性能达标。

原语模式沿同一location1 32F槽：interpolated-normal保存实际orientedNormal输入，oriented-normal保存实际传入shade的normalInput，half-vector保存原BRDF局部h；第四分量是实际rough。原location0完整HDR/显示保留。Three复用旧完整chunk哈希守卫并新增normal_fragment_begin完整SHA；raw在normalize(vNormal)前保存actual vNormal、oriented在原RE取geometryNormal、half-vector取原BRDF实际halfDir。只改变独立诊断输出，原BRDF/材质/默认导数保留。Three原full来自独立未插桩pass，不命名诊断输入为full颜色。

复用原MRT设备/精确canonical描述/24B附件/encoder票据与RGBA32F原生读回，不新增渲染或比较框架。实际五pass/五submit/四显式命名帧与validation全部留存；实际GL编译须包含对应原RE/BRDF与capture，raw目标四个componentBits32由旧截读器验证。失配报告实际hooks/pass/snapshot/module/replacement/compile/raw收据，失败JSON带时间戳保留。所有生产与旧观察器零修改。

CPU shader/Three源守卫5/5、独立数学5/5、tsc、runner syntax、browser esbuild通过。旧24消费源SHA全部匹配，新27源frozen-source-identity.json；browser bundle 4,061,116B SHA fe0e949b13b73bc04b7a7337c790343643d03cd315e5744a13491c60b95ae9b5。新叶SHA：frontCandidate.ts=3afe9acdb08861a2608b8afcb95dd735ce1f00d26841b2a8b005830f83c6a699；front-normal-math.mjs=9938eb3cad924ffdcd5125f8bb07db02ba42e4ed5987a12cd14ae420e8bf4a4f；runner.mjs=f0f5be65b037bae15c337a909fd52962f23c15aa6b2929cf152ae41ae00d1c39。

root串行入口均node test-output/c8-front-normal-20261001/runner.mjs：默认baseline/A/A+cross raw，各两fresh54实际帧；加--shared-half是独立actual16参考54帧，直接调用原S5门，不通过时仍完整记录；加--inputs为baseline/A+cross各三种原语两fresh108实际帧，要求默认raw已passed/stable且同27源，逐帧Deep原16F/显示必须相对对应policy未插桩full为0差。完整原Threefull控制保留为另一pass数据，不据CPU量化生成参考。三入口共216实际渲染，GPU尚待root；qualityCertified=false，far/S9/Native/变体/性能缺口保持。

## A+cross actual raw54 / shared54 与软件 RN 反例

root实际raw54和shared54均passed/stable=true、qualityCertified=false。CPU独立审阅全部27消费源SHA、两fresh整数组相等；Deep每policy四帧的full32/原16F/display跨raw与shared逐值0差。原compareSharedScene/compareDirectMaterialChain原样调用，保留全部稳定域，不排除三角形边界。

| A+cross actual near | Deep32−原Three独立32 max / p99 | Deep16−实际Three16 max | actual shared坏lane A→A+cross |
|---|---:|---:|---:|
| front | .000908851624 / .000002920628 | .0009765625 | 1→0 |
| oblique | .001687049866 / .000002875924 | .00390625 | 2→3 |

front(62,40)R的Deep actual32=6.098091602325、Deep16=6.09765625，与实际原Three16=6.09765625相等。该点G actualDeep16/Three16均5.7265625；原Three32=5.730155467987，CPU nearest得到5.73046875不是真实附件，不登记为新坏点。front仍有2个小于原门的回归lane，最大.0009765625。oblique新增坏点是(76,46)G，原A差0、A+cross差+.00390625；该点RGB全部为+.00390625，3×3 R/B仅中心非零，G邻右−.001953125，完整邻域保留candidate-shared-half-analysis.json。whole stable共3个超.002 lane，原门仍失败。

oblique(76,46)A+cross前存储signed R/G/B差为+.001687049866/+.001602172852/+.001517295837；Deep store差−.001456737518/−.000205516815/−.001482486725，原Three实际16−独立32差−.003675937653/−.002509593964/−.003871440887。front消去更稳定并不意味着全场half相等；斜视真实F32误差相对A反而增加。A+cross actual shared相对A oblique4个lane恶化、最大.00390625。strict-emissive整幅full32/16/display相对原baseline全0差，显示stable byteMax仍1、maskMismatch0。

软件nearest/ties-even草稿独立于27冻结源，现状核查见half-policy-audit.md。bit算法返回精确binary16可表示的F32，不调用WGSL builtin推定RN；所有finite half、全部相邻half midpoint及F32左右邻值正负、NaN/±Inf/overflow、20万随机F32对独立half距离oracle，4项CPU测试通过。GPU/Native/全变体/性能未验证。

只将Deep actualfull32软件RN再存、保留实际原Three16的全稳定域CPU反例：A+cross front原0坏→3坏、oblique原3坏→4坏，最大仍.00390625；A前1→2、斜2→4。RN还改变strict-emissive front19264/oblique17419 lane，最大.00048828125。该单端RN策略不能修当前原门，不建议仅为重复反例运行GPU；若后继考虑全管线精度政策，需明确原基准约束和独立性能/边界证据，不能改变原Three作为本次C8修复。CPU完整坏点与变化记录half-policy-analysis.json，软件WGSL仅ignored候选未接生产。

## actual normal chain108 与单次 shade 候选

root实际inputs108 passed/stable，27 SHA匹配、两fresh整数组同、24原16F/显示preservation最大差全0。真实Three raw/oriented/h由独立诊断帧读取；Three原full仍是另一未插桩pass。front(62,40)raw normal Deep/Three为[-.008847278543,.218029424548,.972661912441]/[-.008847272955,.218029424548,.972661912441]；oriented即shade入参为[-.008875341155,.218721002340,.975747108459]/[-.008875335567,.218721002340,.975747108459]。y/z在raw与一次归一化时均同；旧actual BRDF normal却是[-.008875340223,.218720972538,.975746989250]，y/z各低1ULP。真实h两端[-.027715176344,.212785720825,.976705729961]/[-.027715194970,.212785720825,.976705729961]，仍只有x微差。观察证明额外shade safeNormalize产生前视长度改变；尚未证明删它能令所有GPU算术与最终half相等。

全原稳定域的actual oriented与旧consumed normal变化front1734/15987、oblique1574/13981 pixels，最大1.788139343e−7。known-camera CPU旋转后的raw单位方向差max1.440056034e−7/1.584566410e−7，oriented max1.530871806e−7/1.614824037e−7。actual h单位方向差max1.225822701e−7/7.981474078e−6，后者全域最大值不等于热点因果；两斜视焦点的old consumed normal与oriented逐值同，不能以去掉额外normalize承诺消除斜视坏点。

actual-normal-chain-analysis使用真实h，CPU两种normal在同一F32 dot/分布图上做D-only差，保持nv/nl/visibility/Fresnel固定；full颜色为敏感度预测，非GPU候选输出。baseline front最大预测差.001213502701、oblique仍.005125999451，A+cross front .000909422739、oblique仍.001687049866；全域无新增>.002 F32点，但保留normalization敏感度恶化front/oblique baseline1711/1553 lanes、cross1340/1084 lanes。CPU dot与GPU dot实际有调度差：front旧actual NH=.999804377556，CPU actualn/h dot=.999804317951、一次n/h=.999804437160，因此不将CPU精确调度当GPU实现。

root授权的最小ignored候选完成六步single-normal-audit.md，复用旧runner和29源哈希守卫。仅在构包时对frontCandidate模块安装guarded source-transform，shade函数唯一`safeNormalize(normalInput,...)`换成normalInput，baseline保留原样；A与A+cross分别观测单次shade。保留orientedNormal/mappedNormal的输入安全归一化与BRDF h归一化，无灯强、材质、camera、pixel分支。现有shade所有调用来自oriented或mapped；DirectDisplay特化及Native仍需后续完整合同与性能验收。减少一次normalize的理论成本，不声明实测性能提升。

source-transform CPU合同3/3、生成的真实转换TS的tsc、runner syntax、browser esbuild通过。29源中原27逐值同；新增single-normal-transform.mjs SHA894a81f5af6e3825b0300915733c9928d19d9787ed89aebdd1bc23ed1aada45c，single-normal-runner.mjs SHAa1e04b51f6cec870591b5bc72e9c2040c11694fcc7eaf93cea6334f6cf9cdc20。完整single-normal-freeze.json，bundle4,062,700B SHAbd7b9f855c051d208d3f19ef7210919828f40629c662a5444920baa66bce30ed。root串行命令`node test-output/c8-front-normal-20261001/single-normal-runner.mjs`以及其后`--shared-half`，各54实际帧、两fresh、baseline/A+single/A+cross+single；原Threefull守卫和strict-emissive全输出0差守卫保持。GPU尚待root，C8开放。

## single-normal actual raw54 / shared54 最终审核

root两段实际均exit0、passed/stable=true、qualityCertified=false。两个独立CPU叶验证29 SHA、两fresh全数组同、raw/shared Deep full32/原16F/display逐值同。相对旧27每policy的原Threefull/display整幅0差，baseline四帧Deep32/16/display0差，strict-emissive所有policy两camera整幅Deep32/16/display0差。

| actual A+single near | F32跨端最大差 | actualshared16最大差 | shared超.002 lane |
|---|---:|---:|---:|
| front | .000964641571 | .00048828125 | 0 |
| oblique | .001155376434 | .00390625 | 2 |

front(62,40)R actualfull32=6.099133968353，原Three32=6.099000453949，差+.000133514404；旧A差−.001610755920。实际Deep16/Three16 RGB均为[6.09765625,5.7265625,6.02734375]，额外归一化候选真实消除前视坏点，全域无新增>.002点。A+single整幅front改6 HDR/2237 F32 lane、显示0改；oblique改1 HDR/1873 F32 lane、显示0改。唯一新增小回归(70,62)B：oldDeep32=.862304627895、newDeep32=.8623046875、oldDeep16/Three16=.86181640625、newDeep16=.8623046875，signed+.00048828125，保留不排除。

斜视(76,46)R/B actualfull32/16与旧A逐值同，signedshared各+.00390625，仍为原2坏通道；3×3邻域仅中心非零。A+cross+single斜视R/G/B仍3坏通道，frontmax.0009765625，较A+single无收益，停止cross扩展。原compareDirectMaterialChain两候选仍失败；稳定域显示byteMax1、maskMismatch0、15987/13981像素、贡献覆盖16242/13795满足其余原门。当前不提升正式shade/导数策略，far/S9/Native/变体/性能未覆盖。

### 后继两模式原标量诊断

两个fragment换view-basis CPU敏感度反例已记录view-basis-audit/analysis：raw-world varying旋转view再normalize模型将斜视(76,46)R差.001155376434推到.002080062835，新增F32坏点；已oriented world normal旋转view再normalize未改热点，并有13490斜视lane模型恶化。二者均未复现Three vertex normalMatrix→归一化→插值→fragment归一化的实际rounding，不以换basis本身作为修复。

root批准仅2个原语模式，现状核查见brdf-primitive-audit.md。复用原loc1四F32与原生Three32F：distribution导出实际NH/alpha²/denom/D，geometry导出实际NV/NL/VH/V；Deep从唯一brdfWithDielectricF0的原声明后读取，不能匹配extended中同式的另一visibility。Three在原D_GGX保留返回表达式并绑定局部导出实际return值，或在原BRDF_GGX声明V后读取。只独立诊断帧改变输出；原Threefull控制另pass，两者不能命名samepassfull。

原29源逐值不动，仅新transform/runner两消费叶形成31 SHA冻结。原full控制重新实际读取，并须相对旧A+single Deep32/16/display和原Three32/display全部0差；两primitive frame须Deep原16/display0差，所有source/compile/原生对象/映射/5pass/4帧/validation守卫继续有效。source-transform4/4、真实安装Three/PBR工厂3/3、转换后tsc、runner syntax/browser构包通过；CPU工厂曾发现全模块visibility同式重复，已收窄至唯一primary BRDF scope，最终全绿。

新增brdf-primitive-transform.mjs SHA6a174c8955e407d454142d875330dd44932365c7f3c54f9d15ca263e152f1e2a，brdf-primitive-runner.mjs SHAbadc564f9ae2e0ba28eb5995e07c559998323e1439bc2035e4866b7a80106f89。bundle4,065,474B SHA8dbd68f6386e87017190fe5c0ba6538efdb02f44dc4a3383591cf0ba43bb443d，完整brdf-primitive-freeze.json。root唯一入口`node test-output/c8-front-normal-20261001/brdf-primitive-runner.mjs`，两fresh×独立full控制+2primitive×9=54实际render。GPU尚待root；后继CPU仅比较实际同NH/alpha²却不同denom、同denom/alpha²却不同D，并分别保留numeric FMA假设与完整颜色未解释残差，不据近似模型或half等值直接关闭C8。

2026-09-21官方[WGSL重关联与融合规则](https://www.w3.org/TR/WGSL/#reassociation-and-fusion)允许重关联与符合准确度规则的融合；[fma builtin](https://www.w3.org/TR/WGSL/#fma-builtin)的准确度合同仍允许普通乘再加，不保证IEEE单轮fused结果。后继即便当前设备实值匹配CPU outer-FMA，也不能把显式fma或数值模型命中当跨设备固定舍入政策；需真实候选、Native与变体收据。

## actual GGX 两原语54帧归因与分母-only反例

root实际primitive54帧exit0、passed/stable=true、qualityCertified=false。CPU重验31源SHA、两fresh整数组相等与12条preservation：原full控制Deep32/16/display和原Three32/display逐值0；两diagnostic原Deep16/display逐值0。evidence SHAe134aabd516dc2af92523bea5d45f0de3b38769a1927b14efd262435e7be1ce6。实际诊断标量出自原消费局部；原Threefull是独立未插桩pass。

| 焦点 | Deep / Three actual NH | Deep / Three actual denom | Deep / Three actual D |
|---|---|---|---|
| front62,40 | .999804496765 / .999804496765 | .001563191414 / .001563209808 | 152.766937256 / 152.763397217 |
| oblique76,45 | .999645292759 / .999645352364 | .002019286156 / .002019190928 | 102.339271545 / 102.348922729 |
| oblique76,46 | .999852478504 / .999852418900 | .001610040665 / .001610188861 | 161.527206421 / 161.497329712 |

76,46实际alpha²=Deep .001315434579737 / Three .001315433415584。实际V为.385575115681/.385575234890，NL=.803578495979/.803578376770，VH两端.805198192596相同。用真实D/V/NL/VH做独立double单次radiance，24种置换Shapley的D贡献RGB为+.001155415471/+.001097644684/+.001039873897；V贡献−.000001931132/−.000001834575/−.000001738019，NL贡献+.000000977827/+.000000901900/+.000000846235。实际full差+.001155376434/+.001097679138/+.001039028168，模型未解释full residual为+.000000914268/+.000000967130/+.000000046055，保留multi与GPU算术调度未解释量，不把标量模型当actual single输出。

全部15987/13981稳定像素的同NH+alpha²集合为3621/2066，其中1062/543实际denom不同；同denom+alpha²的3721/2823格中1836/1333实际D不同。输入相同仍不同的实测否定“全由normal误差引起”。Deep denom非融合F32 CPU模型逐值命中全部15987/13981；Three outer-fused模型命中15570/13498，而非融合只命中11009/9926。数值模型命中是当前设备观测，不能推定实际ISA或跨设备固定fma合同。全域标量full模型未解释残差max为.000007361181/.000008499956。

独立denom-candidate-analysis保留每个stable pixel、当前actualfull32、原实际Three32/16。RTX原32→16的RTZ CPU模型在全部89904颜色lane上0差后才预测候选存储。baseline D表达式CPU与GPU还存在3941/3874格不同，候选使用D模型差相对actual颜色的敏感度，明确取消baseline模型残差，不能冒充真实候选。

outer-fused分母模型使76,46 predictedR/B=6.621792793274/6.504706859589，actualstore模型仍6.62109375/6.50390625，旧两坏lane不消失。exact-denom和separated等价式也不消除两lane，且新增76,45R：predictedF32=4.414047718048/4.414020538330，stored4.41015625，原实际Three16=4.4140625，差−.00390625。分母-only三路线均不推荐GPU或生产推广；不因F32最大误差缩小就通过half原门。

## 独立 VS view varying 最小因果候选

### 现状核查

六步细目复用并补齐view-vertex-audit.md：源码/未跟踪检索已覆盖world/view normal与VS/fragment消费；已读contracts/scene、scene/types、pbrRendererTypes，已有normalMatrix/normalMatrixStatus/RenderView不重建；已读package/Cargo，复用Three/esbuild/tsc/Playwright，无新依赖；已查packTransform/cameraMath/PBR/Three原normal vertex与原Sharedfixture/probe消费；旧29/31实际raw/shared/primitive与F32MRT测试收据复用；规格/handoff与原审计链保持。真实缺口是原world VS normalize→插值→world fragment normalize与Three view-model normalMatrix→VS normalize→view插值→fragment normalize的实际精度链，不能以fragment rotate原normal替代。

CPU完整vertex→假定8bit software raster→fragment保留front15987/oblique13981稳定像素，覆盖缺失0；worldraw对actual的p99均2.384185791e−7。oblique有9格模型gap>1e−6、max .000114738941，未排除；原Three canonical CPU模型76,46 NH也比actual高1ULP，因此CPU不承诺候选实测必绿。GPU F32 view3×packedworldnormal与Three CPUdouble view-model逆转置再F32分别建模；box原normalMatrix分量存在约1ULP构造差，不冒充完全同源数值。5组far/负scale/非均匀scale/剪切double协变合同误差<1e−12，但尚无实际GPU变体收据。

root授权的ignored候选只新增两消费叶。保留原packed world normal、out.normal、authorShadow、normal-mapped与shadow source；plain vertexMain增加location13 viewNormal和location14 viewPosition共6标量varying。VS先GPU构成viewNormalMatrix再归一化，随后perspective插值；独立MRT片元一次orientedNormal(viewNormal)与normalize(-viewPosition)，只primary GGX消费view n/v/l。原A rough、world shadow、DFG/multi不动。MRT以外fragment/全部变形/local/Native不属于该候选准入范围；正式推广需完整家族与性能验证。无camera、pixel、材质或灯非零特判。

绑定/instance/frame布局不变；interstage诊断ABI明确增加两个vec3。VS新增normalMatrix构成/normal变换及normalize、viewPosition矩阵乘；fragment新增viewN/viewV/viewLight计算，性能待测。当前仅因果诊断，不提升production。

seam CPU3/3、真实PBR源工厂2/2、转换tsc、runner语法/browser构包全绿。33 SHA中原31逐值同，view-vertex-transform.mjs SHA2450b547a5c69f5f979bb1384d1017d952950e834c0d35d74f93e81560f5d0b1；view-vertex-runner.mjs SHA347060ecc949c1d27588ed0a4df6326b19f9f6d45ad475ee19b2e7f5fba41cd9；bundle4,065,309B SHA89eb5603c660f77777d27dfeaf9ea5230585cfeb066f77833307e6a624c8f59f。完整view-vertex-freeze.json。root入口node --max-old-space-size=4096 test-output/c8-front-normal-20261001/view-vertex-runner.mjs，raw后加--shared-half，各18实际帧/两fresh，共36。原Threefull全域0、strict-emissive Deep32/16/display0强断言，direct保留候选全部变化与原strict门。GPU尚待root；qualityCertified=false，C8开放。

### view varying actual36帧：停止该variant

root实际raw/shared各18帧均exit0、passed/stable，qualityCertified=false；CPU再核全部33 SHA、两fresh整数组、原ThreeHDR/display相对A+single0、strict-emissive Deep32/16/display0、raw/shared Deep全输出0。原15987/13981稳定像素全保留，mask变化0。front原HDR与显示0变化，F32变2111lane/max.000311851501；oblique HDR变2lane/max.000244140625、F32变13674lane/max.000476360321，显示0变化。

actualshared仍front0坏/max.00048828125、oblique2坏/max.00390625；无新增超.002。76,46 R/B candidateF32=6.622020244598/6.504911899567，与原Three32差+.001156806946/+.001040458679，比A+single略恶化；actual16仍6.62109375/6.50390625，原Three16仍6.6171875/6.5。3×3仅中心R/B非零；LD15仍不适用。新增小回归157,126 G差+.000244140625，另一个小lane改善，均完整保留。原strict仍失败，不继续view variant或提升生产。raw/shared evidence SHA分别ef4747eaee5b0737d86d4a98cf5d79f1f249131c26d68cddae5f5fdc001f20fd/635ebda8b02265558b8b2b5148acfbf7c3946d5ba0d47edab935e2ef5284032a。

## F64 unit-angle 与原顶点/光源独立真值

unit-angle-analysis以真实GPU oriented n与actual h做两条独立F64合同：cos²=dot²/(|n|²|h|²)，sin²=|cross|²/(|n|²|h|²)。全域恒等误差≤6.175615574e−16，两个D oracle最大差≤1.665512173e−11；不是旧F32 cross近似。actual-a²、rough⁴ exact-double以及原authoredlight double+actualview重算完整single均保留原actualfull32、多散射未解释残差和实际Three16，89904lane原RTZ模型0差后才预测store。

前述四策略均front0坏、max.0009765625；oblique均从2坏→3坏，76,46新增G，F32 max前三者.001684188843、完整single .001687526703。76,46 cosDeep=.9998525261800046、cosThree=.9998525255519481；精确角D≈161.540884853，比实际Deep161.527206421更高，predicted16为[6.62109375,6.23046875,6.50390625]，实际原Three16=[6.6171875,6.2265625,6.5]。精确单位角并不能修原half门，停止把cross的F32误差当其失败根因。

source-double-angle-truth直接import原author fixture，F64 view-model逆转置→VS unit→独立ray/triangle重心→fragment unit→原directionalLight/view/h，29968稳定像素ray覆盖无缺失。原fixture SHA25dae49690c2f6ba1c3429fcbf280b79b5f32e961877d92687fa82868f361d90，Three材质/曝光/geometry不改。76,46 sourceDouble NH=.9998525410391803，actualDeep/Three unit cosine近同且均低约1.5e−8；actual consumedNH却分别.9998524785041809/.9998524188995361。CPUray与硬件subpixel/raster不同，全域source angle gap p99两端约9e−5，原face仍只是CPU geometry bookkeeping，不能据它替代实际GPU输入或拟合颜色。

### 后继最小 consumed n/h + 同局部 NH

六步核查见consumed-nh-audit.md，复用旧31 primitive与33 source收据；真实缺口是旧oriented normal在RE/shade入口的捕获并非NH声明同消费局部，不能把旧n/h与另一个编译诊断NH强当无调度差的一帧。新增两个模式在原Deep BRDF nh/vh声明后导出vec4(n,nh)/vec4(h,nh)；原Three BRDF_GGX导出真正normal/halfDir参数与同局部dotNH。仍loc1四F32，不增varying/绑定/instance/frame ABI；原world/view候选停用、不导入。原Threefull另fresh独立控制，诊断输出不是full颜色。

两个新NH的.w必须在两端全部四帧/每个pixel与原31 distribution.NH的.x逐值0；失配记录actual max/count后失败，不以16F相等掩盖捕获调度变化。随后以这对真实n/h做F64长度/exact-dot、六种非融合与FMA调度模型，将normalization输入差与dot数值残差分开，CPU模型仍不代表GPU ISA。

原33源保持，新transform/runner形成35 SHA frozen。seam2/2、真实factory2/2、转换tsc、runner syntax/browser build全绿。consumed-nh-transform.mjs SHAf93d1a27bc7d8a47934ba5ec047a31f2fb0d1a962a2bb53d64ddfd3df2d5dced；consumed-nh-runner.mjs SHA59ee1a53870480d0615a48299dcf754e519c27a8763aca7d7d80251d18a2237f；bundle4,064,983B SHAf42767e3d778ce36c85d1194295575e72f8a45add008ebd4214f72fedd57c245。root命令node --max-old-space-size=4096 test-output/c8-front-normal-20261001/consumed-nh-runner.mjs，两actual-vector模式+独立原full控制×2fresh×9=54实际帧。GPU尚待root；只诊断，C8开放。

## consumed n/h actual54：长度与算术拆分

旧首跑 emissive 失败保留在 consumed-nh-failed-20261001-alpha-sentinel：Three 未执行 BRDF 的 clear alpha=1 被误当 NH.w，而旧 distribution.NH.x 的默认值为0；front44040/background、oblique46138/background 均来自真实 clear，不能跳过整帧守卫。修正后明确以 rgba(0,0,0,1) 表示 unset，必须独立证明 RGB=0、灯数0、捕获数0，并以逻辑 NH=0 与旧分布槽比对。实际 strict-emissive 两camera各61440 unset/0capture，direct实际17400/15302capture、原compiled directional count1。

root 修正后54 registered帧/两fresh exit0，35源SHA及两fresh整数组相等；8条同局部 NH 对旧distribution逐值0差、12条原输出preservation逐值0。evidence SHA99e3da2db5c1272b841ccb46d514b178df3d78c0ff2584e7dcbcfaa99c593b2f。当前transform SHA80a8fe95732f987ab6db7e14fc25e94e821a8828d958a4369153ef5a246de9b6，runner SHAf30b5a0775d9a44800dfc8cb1a23e8e2fcb326a958350b0617b4c9b5710e30ab，bundle4,066,019B SHA09159016e1a92a814c49ac568e0e73fa547e42503f261697ada0558fe498fb86；替代上一段未执行的首稿状态，旧失败哈希保留。

独立 consumed-nh-analysis 将实际 NH 差严格拆为单位方向差、输入长度贡献、实际 dot 算术残差；front15987/oblique13981稳定域重构误差全0。76,46 的实际 NH 差+5.960464477539063e-8，其中单位方向+6.280564956995249e-10、长度+7.298025461732749e-8、dot残差−1.4003666337636389e-8。76,45 三项为−9.4496122e-10、−2.2218384466e-8、−3.6441299089e-8；front62,40实际 NH 相同。两端实际 NH 全部29968点都数值命中同一F32 fma-chain-210模型；此为当前设备数值证据，不推定ISA或跨设备策略。

normalize-consumption-analysis 再核旧 raw/oriented 与当前 consumed n 全数组相同后，比较40个独立 normalize 数值模型，没有模型全域命中，Three76,46全部失败。由三个 raw/actual n 分量反推的共同F32缩放在全部29968点、两端均唯一；对FMA210 raw-length平方数值模型，每端相同输入没有缩放碰撞，跨端共有3900个输入的实际缩放全部相同。当前证据支持相同近似缩放路径接受不同F32 raw输入，不支持引入后端专用1ULP偏置。该缩放是独立CPU反推，不是GPU scalar实测。

原Three是WebGL2，应按 [GLSL ES3.00 §4.7.1](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)审查：inverseSqrt允许2ULP、除法2.5ULP、几何函数继承原语误差，乘加允许单轮或分步，rounding mode未固定。当前 [WGSL浮点准确度](https://www.w3.org/TR/WGSL/#floating-point-accuracy) 的inverseSqrt同为2ULP，normalize继承x/length；dpdx/dpdy准确度为Infinite ULP。实际单位长度相差约1e-7，不直接构成材质物理bug或规范违规；完整normalize→NH→D→F32→实际16F误差可能跨half边界，原strict .002仍有效。默认导数无有限跨设备保证，只有固定实际输入时可给条件误差区间，不能据当前RTX观测提出可移植定向补值。

## 四 consumer 单次归一化五族候选

### 现状核查

六步详见 test-output/c8-single-normal-families-20261001/AUDIT.md。全仓消费核查覆盖pbrShader、directDisplay原WGSL/生成模块、pipelines、packetDraw、pbrPipelineSet、pbrRenderer与Native mesh；复用contracts scene/types与RenderView，不增公共ABI；复用原Three/esbuild/tsc/Playwright和既有Naga executable，无依赖/Cargo构建；所有shade输入均为orientedNormal/mappedNormal，Native已经一次；复用原实际raw/shared/consumed诊断与测试；规格/handoff/账本保持C8开放。

已有（不重建）：正式renderer、原root/构包、原Three HDR/display、实际surface读回、生命周期、sourceguard。真实缺口：四内部consumer的统一“输入已单位化并fallback”合同及每个真实pipeline独立fresh对照。候选只删除shade/shadeDirectNoEffects内部safeNormalize，以及oneCascade/directional包在orientedNormal外的第二次safeNormalize。generic safeNormalize、normalMatrix、mapped/oriented、BRDF halfDir、shadow、所有默认导数逐字保持。显式导数A为另一profile，不混入本候选。

独立ignored候选五族为shade-hdr、shade-display、no-effects、one-cascade、directional。基于原正式factory，诊断profile显式省去Deep neutral authorColorEffects以准入fast；oneCascade仅在虚拟factory构包中禁止directional optimized map，shade-display使用无物理fog的feature选择普通shade入口；这些选择不是正式dispatch变更。每个实际shaderModule/setPipeline/indexed draw都要求登记entry、原vertex和pass签名。原Three所有参数、编译BRDF源和完整HDR/display必须跨每族/policy逐值相同。

CPU7/7、tsc、runner语法、Naga plain/deformation/array/layered baseline/candidate 8/8通过。冻结540实际non-vendor消费源+5vendor；完整freeze.json；bundle3,715,227B SHA592526eb67187630ea4086eaa1a582cd1149ba173adf112604f04b4232bf75ff。root唯一入口为 node --max-old-space-size=4096 test-output/c8-single-normal-families-20261001/runner.mjs。两fresh×baseline/candidate×五族×原near两camera/emissive/direct为180 registered帧：100 Deep opaque+80Three HDR，原Three额外80surface，所以总260实际render operations。far未纳首批，不把180标签当实际总操作数。

原shade-hdr严格HDR.002和surface2门逐字执行并保留所有baseline/candidate失败；fast真实没有HDR，不借其它pass补HDR，也不宣称通过HDR门。所有全稳定域bad/newbad坐标保留，strict-emissive原Deep输出全域0差为硬守卫；neutral profile对原HDR-display的真实surface变化独立记录，不以identity名义假设量化路径相同。qualityCertified=false。Native/变体/活动层/normalmap/local/透明/负scale/far/性能尚需实际收据；候选未提升生产。

### 五族 actual180 / 实际260操作最终审核

root矩阵exit0、passed/stable=true、qualityCertified=false。独立whole-field-analysis复核540 non-vendor/5vendor源SHA、冻结bundle、两fresh完整20capture数组相同；每族每policy实际5opaque pass/10indexed draw，前1validation与4原stage/camera映射明确。实际entry分别fragmentMainColor、fragmentMainDisplay、fragmentMainDisplayNoEffects、fragmentMainDisplayNoEffectsOneCascade、fragmentMainDisplayDirectional；baseline module SHA5d6f86227d2c1e01d5902626dc105c32a0909c57fa1b258f2e9a111072f27a9c、candidate86ff61bc9ee9e95a54512322443399432aa470483d0c54206ed086e4b222ede8。evidence SHAc9b01420f3d96d283e0cd72f1024182ace2097ace36c021770e9b02baa369df5。

40个family/policy原Three完整HDR与surface相对同轮原reference全域0；所有strict-emissive candidate相对各族baseline Deep真实HDR（仅shade-hdr）与surface全域0。shade-hdr front15987稳定像素：HDR5lane改善、0恶化、0小回归，原62,40R从6.09375到6.09765625，与实际Three16相同，bad1→0、max .00390625→.001953125。oblique13981稳定像素的Deep HDR整数组0变化，仍76,45 RGB各+.00390625、76,46 RGB差[+.0078125,+.00390625,+.0078125]共6坏通道；无新增超门。原baseline斜视max原本也是.0078125，旧门仅先因front .00390625退出；不得把候选先报斜视.0078125当作新增最大误差回归。

五族stable surface max均1，无bad/newbad；shade-hdr surface0变化，四fast前视各1lane由原误差1改善为0、斜视整域0变化。fast仍没有DeepHDR，不给其补HDR质量标签。显式neutral fast profile与原shade-hdr baseline实际前/斜surface max1、变化666/749lane，strict-emissive两camera全0：这是原HDR中间存储与直接surface的路径差，不能仅凭参数identity称所有输出逐值相同。完整坏点/回归/身份对照见whole-field-analysis.json。

### 最小正式提升候选（尚未提升）

root审阅后批准准备四consumer正式补丁。六叶review树与manifest在ignored promotion/；正式源未由本子线修改。两shade consumer附上游已单位化/fallback短注，oneCascade/directional只移除外层重复normalize；WGSL真源通过仓内原syncSharedWgsl.mjs在isolated树执行--source=directDisplay.wgsl生成mirror与sha，生成物不手写。第五叶仅改outputFamilyWgslChecksum的direct composition SHA，第六叶新增pbrUnitNormalContract测试。

现状另发现原direct composition pin为3c420c52...、当前baseline真实hash为35f72f9e431dfc15bd8defdf3667a238045abc05f01f8793df45fa011226d4dc，候选前已滞后；manifest保留二者并更新唯一direct pin至6add7fd14ea4a86b3ceedd2cdf01649b5194718384c51b5bcc7dcba9968b2289，原outputShader pin不动。候选带注释scene SHAde9839bf970c274934b6a168d823b02d1267b210c51f6e100e6c3cc1f35c5e44；仅去两条新注释逐字恢复实跑GPU86ff61...。正式注释仍改变source身份，提升后必须新sourceguard/fresh实际复核。

六个真实factory模块plain/deformation/array/deformationArray/layered/deformationLayered baseline/candidate共12个Naga通过；按正式factory的array优先、layered另分支，不构造未在用的双重组合。虚拟正式source加载的新contract测试实际7/7，检查所有plain/material/transparent上游oriented/mapped兜底、四consumer一次使用、generic/halfVec/default导数保持。正式focused测试、类型、构建及fresh矩阵由root统一提升后执行。C8原strict斜视仍红，far/local/active-layer/normalmap/Native/perf需继续补证，不能关闭C8。

### root 正式提升及 actual production acceptance

root 按六叶base/candidate SHA核验并提升，receipt为test-output/jc-i-20261001-c8-unit-normal-promotion.json。子线只构包ignored正式验收：candidate直接提交正式sceneShader原字节SHAde9839...，historical control只去两条新注释并恢复四处旧consumer，精确恢复原5d6f8622...。新freeze-production.json绑定544实际non-vendor输入+5vendor、bundle3,715,395B SHAdd90c2020fcd1fc5f2911795cb676a4100c356be73a4e4bac5f89e1b428847b5；独立gpu-production-output，旧矩阵证据未覆盖。

root 正式acceptance再跑180 registered/实际260操作、两fresh exit0。独立production-whole-field-analysis重验全部源/包/正式模块/old baseline identity、两fresh全数组、五实际entry/draw/pass/name映射，全部通过。evidence SHA594a250d73e6097866460b81b86e939c1f963d86faf4e565a1213d7ee098f271。production-versus-candidate-preservation逐root/packet/profile身份并对提升前candidate与本次formal两轮全部320组HDR/display数组逐值0；其中fast DeepHDR明确为空，不将其算成HDR数值证据。前视5改善/0恶化与唯一坏通道消除、斜视6坏保持、所有surface无超门/新增点的结果完全复现。质量认证仍false，C8仍开放。

### 诊断同族 source pin 迁移

正式6叶focused生产测试已由root跑37pass+3skip；旧三诊断testfiles17fail完整日志jc-i-20261001-c8-normal-formal-cpu.log保留。全仓核查找到observer shade body固定pin及旧stale mutation needle，迁移两leaf虚拟CPU后observer/MRT全过，但F32Inputs另有whole-production硬pin，形成实际7fail/13pass，复现日志observer-migration-before-whole-pin.log保留。

ignored observer-migration/manifest.json目前三leaf草稿：shade pin从fb5cbe...变为实读完整body SHA63ef065440d491265e5cb964b6d991cae65ee0a84e9d1bb0251a699764563335；负控将真实 `let n = normalInput;` 改回旧safeNormalize，先断言替换确实发生，再要求source drift拒绝；F32Inputs whole pin固定到正式de9839...。完整source equality/body SHA/唯一接缝/marker/unknown/双instrument/原Three/原生device-module守卫全部保持。只将F32错误文案改为pinned production baseline，新正式MRT/F32input真实preservation还未跑，不称passed MRT。

三leaf均不在544 acceptance消费清单，不影响刚完成actual验收。虚拟source的原三diagnostic testfiles已实际20/20 CPU通过，待root按manifest统一提升和正式focused复核；子线未改这些正式lab叶。旧失败收据不删除。

root 已按observer-migration三叶manifest提升，receipt jc-i-20261001-c8-observer-migration-promotion.json，scope明确新MRT GPU preservation pending；旧failed/root CPU日志保持。正式focused最终结果以jc-i-20261001-c8-normal-formal-cpu-migrated-final.log为准。现有c8-f32-inputs runner仍绑定旧S5近/raw Deep16零差基线，新正式normal修复已改变5lane，原样运行会正确拒绝；后继先刷新当前canonical S5 raw全矩阵或新增独立current Three32/Deep原full control，不能删preservation或拿shared Three16冒充原Three32。旧输出目录继续保留。

正式focused最终7 testfiles结果为54pass、3skip（57项），包括四生产合同/校验文件与三诊断文件；当前Naga独立12/12已实际执行，未把Vitest环境条件skip算Naga通过。此前35源数学归因、540源候选矩阵均为明确历史收据，不能以其旧SHA直接认证当前正式源；当前544 source acceptance已独立跑并保存。

### 当前输入链与执行语义后继

增量六步核查和CPU脚本在 `test-output/c8-input-chain-20261001/`；复用既有合同、消费者、实际receipt，不增加GPU/Cargo或正式源变更。原当前canonical shared门仍红：near前视 .001953125通过，near斜视76,45 RGB各+.00390625、76,46 RGB差[+.0078125,+.00390625,+.0078125]；far前视 .00146484375通过，far斜视198,64 RG各−.00244140625。全部实际surface max1。`conclusion.json`保存这8通道原值及near真实pre-store F32；far Deep pre-store尚未测，raw入口的Deep值仍是已存16F。

CPUdouble modelView normalMatrix与旧GPU F32组合在焦点9项逐字相同；VP单次发布在near没有变化，far仅depth变化。补全modelView→projection clip操作序的软件oracle保留29968稳定点，三焦点raw/N/H/NH仍逐值相同。该软件模型不能证明GPU实际插值相同，但没有给出可推进候选的收益依据。原真实world/shadow输入、原Three、材质与曝光都保留。

实际同消费者NH两端29968点均数值命中FMA-chain210，3900个跨端相同raw长度平方输入的归一缩放全同。旧receipt没有driver ISA或translated shader，因此不能宣称已确认编译指令。当前 [WGSL 15.7.5](https://www.w3.org/TR/WGSL/#floating-point-reassociation-and-fusion)允许重结合/融合，[fma定义](https://www.w3.org/TR/WGSL/#fma-builtin)也不保证IEEE单轮融合；拆let或函数不是可移植舍入屏障。

真正源表达式差为Three D的 `RECIPROCAL_PI*a2/(denom*denom)` 与Deep `a2/max(PI*denom*denom,1e-6)`、specular的 `F*(V*D)` 与 `(F*V)*D`。新条件CPU oracle只测试D原表达式，不重复已否决13dot/denom扫描：29968点Deep分母floor0次触发；A+single实际profile剩余76,46 R/B的预测F32和stored16逐值不变，0resolved/0newbad，仍+.00390625。不能将该源差当作闭门修复，也不能把条件CPU预测称为实际GPU新输出。

四处consumer冗余归一已正式消除；VS等长化、插值后fragment归一、V+L后halfDir归一仍必要。没有新可合法删除的normal契约冗余。C8保持开放，原 .002 门不变；本批不安排无收益依据的GPU候选。
