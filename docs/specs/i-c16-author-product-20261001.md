# I-C16 作者离线 HDR 出图草稿

复用作者导出菜单、正式 SceneSnapshot 编译与 CPU 路径会话，让当前静态合法材质场景能累积、取消、失效并导出线性 HDR。

## 现状核查

1. 全仓 packages/apps 源与 git untracked 核查 PathTrace、SceneExport、ImageExport、lighting、HDR。已有 CPU kernel/render/session、离线 CLI 和 scene compiler；Apps 没有 PT 消费入口。smooth/frame 已由根路提升 11 文件，本片不改正式源。
2. 契约已存在 RuntimeAuthoredLighting、RuntimeSceneCamera/coordinateFrame、RenderPacket、SceneSnapshot、RadianceHdrImage、PathTraceSceneIdentity/Config。不新增场景或图像 wire 协议。
3. package.json 已有 deep-engine、contracts、React/Vite、图像 decoder、studio WASM normalize；不新增运行库或积分器。
4. SceneExportMenu→SceneWorkspaceMoreMenu→AppWorkspaceTopbar 有真实消费；scenePersistence.makeSnapshot 可读取当前作者场景。compileSceneRenderPacket/compileSceneCamera/localizeSceneCoordinates 和 probeGridBakeRunner.buildSceneModelLoader 已在运行包/烘焙消费中。PathTraceCpuRender 消费真实参考核，advanceAsync/AbortSignal、逐像素噪声门、exportHdr 已实现。
5. 既有 CPU PBR 正式 62 测和 CLI 6 测；smooth 草稿 98 测（正式提升范围 88 测），实际 Apps sphere 编译/coordinateFrame/HDR/取消及真实纹理拒绝已有独立证据。当前环境 shader 有 studio 与 equirectangular incident radiance 公式；HDR decoder 已有。textures 包仅准备上传数组/采样器，没有 CPU 任意方向 radiance 采样。现 PT 只有 environment callback，未消费编译方向光，方向 delta 不能由连续 BSDF 采样命中。
6. 权威 remaining 20260930 的 I-C16 行要求累积/材质变更失效/取消/导出和收敛对照。T10 全包另含硬件 RT/refit/纹理/降噪，本片不混关。复用已有 reference-integrator、packet-adapter、dielectric 和 smooth 规格；没有同名作者出图产品。

已有（不重建）：TLAS/preparedBLAS/BRDF+C8/RNG/RR、session/统计/HDR、正式作者 packet/camera 编译和导出 UI。真实缺口：编译光照消费、作者产品状态/材质快照失效/出口及视觉验收。texture、single-sided、alpha、扩展/层材质与 section 仍在既有支持域外，保持实际拒绝。

## 最小交付与设计读

I-C16 作者静帧行与 T10 全包分开核验，实施范围以产品行完整要求为准。使用既有 SceneExportMenu 增加“离线 HDR 出图”，独立薄 dialog 复用基准令牌。设计参照 Unity 静帧渲染设置的输出优先、Siemens 克制状态信息；单个线性 HDR 预览为视觉主体，分辨率/样本/光照选择为次级。设计令牌来自 apps/web/src/styles/base.css；关闭/Escape 取消并归还焦点。视觉需根路完成两轮真实浏览器截图及 10 维评分后再报完成。

第一片补编译方向光 delta NEE 与同一 traceSurface 真实 shadow-query，方向为 surface-to-light，不取反。NEE 复用现有标准 PBR evaluator；无 MIS 是方向 delta 与连续 BSDF 不重叠的数学结论。光照有未消费 localLights/lightProfiles 时明确拒绝，不丢灯。exposure 为输出显示参数，HDR 保持线性 radiance，不乘显示曝光。environment 固定参考光只有用户明确选择时才覆盖场景照明；backgroundColor 不当 incident light。

作者宿主复用 makeSnapshot→localize→compile packet/camera；live semantic identity 使用既有 sceneCompilationSource + runtimeContentSha256，忽略保存时间，材质/场景/相机改变即取消旧 generation 并清空积累。正式导出必须通过既有逐像素噪声门，preview 单独命名/标记。CPU 累积由现有异步会话承担，若大帧阻塞 UI 采用薄 dedicated worker 消费相同内核，避免另写积分逻辑。

独占 ignored test-output/i-c16-author-product-20261001/；初始锁为 SDK transport 及新 directional-light 叶/测试，作者 delivery 协调叶、薄 dialog/菜单接线草稿。正式源不修改；根路审查后统一提升/build/视觉。

## 验证入口

方向光解析 Lambert rho/PI*cosine、实际 packet 最近命中/遮挡/阴影关闭、几何背半球零、现 PBR evaluator/source oracle、零灯恒等 seed；compiled author light 真实消费。产品链实际 SceneSnapshot compiler→PT session→HDR decode，取消/材质变更/过期 generation 不导出，噪声门失败仅 preview，分批一致与收敛误差下降。所有新叶 ≤300 行，不跑 GPU/Cargo。

## 可提升交付与证据

已冻结19个可提升文件：SDK类型/transport/kernel/index与两个灯光环境叶、方向光测试；Apps作者preparation/session/worker/protocol/preview/dialog/CSS、两个合同测试与现有菜单/Topbar三处接线。new leaf最大131行；既有Topbar319行不因本片新增通用框架。三个source-oracle/产物writer测试留ignored，正式测试不引用ignored路径。

草稿CPU10文件80/80：75个可提升回归与5个scratch-only case。SDK972 roots（6草稿source）、Apps2179 roots（10草稿source）typecheck零错。castShadow与receiveShadow=false在当前surface-query未消费：方向阴影启用时明确准入拒绝，两类均覆盖shadows=false合法反例；实际packet强倾normal/light落几何背面128次严格零。原maxBounces终端规则、无灯seed/RR和PBR支持域保持。

实际公开finaldist的before样本忽略directional lighting返回[0,0,0]；after真实BVH Lambert得到[.25464790894703254,.1909859317102744,.7639437268410978]，不是carrier/packing证明。独立保留stock+C8 source对照54域、162通道，最大3.1919e-16<2e-12；实际rustc直连既有Native ibl/sampling.rs（无Cargo/GPU），六cube面6144方向最大f32→f64误差1.37969e-5<事先3e-5门。

实际默认作者方向光+studio，经正式sphere/coordinateFrame编译、真实async会话首次在30901spp通过原2%逐像素门，noise=.01999945560197321。实际2×2 HDR位于ignored author-physical.hdr，SHA `2f17b1d739c7ed0db1468b0c493496c0306610b96027d55a79d07bdc337e2ef4`；raw HDR/RGBE roundtrip和session lease归零验证已过。GI增强=.32→9输出逐值恒等，UI选择物理模式时说明实时GI增强不参与出图，receipt显式记录不适用项。显式参考模式不冒替场景照明；HDR/局部光/IES保持准确拒绝。

四个UI合同CPU测试执行真实compiler/session，仅替换React状态调度与Worker边界：取消真实lease归零、late generation不发布、材质hash失配拒出口、noise失败导出的真实HDR只用preview名称与receipt。实际浏览器worker、makeSnapshot菜单消费、编辑即时失效、下载与两轮视觉仍待根路集成后验收，I-C16产品行尚未关闭。T10硬件RT/refit/纹理/降噪全包另计。

## 正式提升与产品验收准备

根路已逐项核对 before/after SHA 并提升19项，3个source oracle/证据writer留ignored。正式SDK与Fog/Bloom回归122/122、Apps两文件9/9、完整engine typecheck/build和Web tsc通过；Web正式bundle首屏301.4 KiB。实际浏览器脚本已在ignored browser-gate.mjs准备并通过Node语法检查，覆盖两次独立深色1920、1280/480响应、实际菜单/Worker/取消/材质编辑、noise-failing preview与明确物理发光面2%最终HDR。浏览器运行等待根路GPU队列，视觉评分尚待实际截图。

### sourceKey effect现状核查

1. 全仓dialog/author-session调用核查延用本规格入口；正式唯一dialog sourceKey effect把所有变化统一stop(idle)，无重复产品可修。
2. Props.sourceKey、prepared与Worker/Progress合同已存在；无需新状态协议。
3. Apps已有React19.2.8/Vitest4.1.10，无DOM测试环境或react-test-renderer；ignored独立安装匹配版本renderer19.2.8，不改任何运行依赖或包清单。
4. Topbar已有实际scene revision sourceKey消费；real semantic hash仍在消息/导出边界验证。
5. 原4个UI合同mock掉effect，未覆盖真实mount/update；新ignored真实React renderer测试完整执行effect，真实compiler/session/64spp emissive HDR。原正式源4/5、新草稿5/5，唯一原失败为真实sourceKey更新后的invalidated文案；两份日志保留。
6. 按I-C16累积/取消/编辑失效产品行补缺，T10范围不变。最小清单位于ignored i-c16-author-product-effect-20261001/promotion-manifest.json。

已有（不重建）：generation清理、真实session disposal、hash guard、取消与导出。真实缺口：场景变化清空后显示准备开始，未说明失效原因。修复独立sourceKey effect仅在值改变且存在live Worker+prepared时invalidated；设置变化idle，初挂载/同key不失效，cancel/final-export后无live Worker保持idle。可提升只有dialog一项；真实effect测试和匹配renderer留ignored支持证据。

根路已按微片SHA提升dialog单源，Web tsc通过并重建bundle。真实effect CPU再次5/5，recheck-vitest.log保留。浏览器守卫先约束34个最新提升条目（后继覆盖先前同路径SHA），再捕获3085个Web/SDK/合同生产源及实际Web js/css/html/wasm构建文件；运行完所有SHA必须不变。HTTP实际UI与dedicated worker资源逐个与当前dist字节比SHA，消费记录随report保存。browser-gate/source-guard两脚本已冻结并语法检查；视觉10维模板留ignored，评分只在根路实际截图审完后填写。

实际验收前置失败均保留：6iouoI/qOvgKz使用历史tree选择器，而当前默认消费为AppStudioShellView→FlatSceneObjectList→ScenePrimitiveRow（asset-row/scene-object-row与button.asset-main）；已按当前源修正。boKJht暴露HTTP response事件延迟读body遇导航失效，已替换context.route→fetch→body比SHA→fulfill，所有异步立即catch，错误使guard拒。guard隔离CPU3/3验证真实dist字节比较顺序、body错误捕获、错误字节拒绝与pending等待；它仅验证守卫，不计浏览器产品证明。用户后继明确只用深色1920，视觉按此约束验收；token同族静态检查无新增hardcode色或裸z-index，focus/disabled沿既有base/button样式。

### 实际作者恢复变换核查

1. 全仓authorModelTransforms/primitiveState/applyModelState搜索，当前唯一store在ViewerEngineCore；registerObject、setModelTransform与根对象图投影写store，applyModelState只写Three。
2. 已有ModelTransform、PrimitiveState、SceneModelState与getModelTransform合同；不建新权威模型。store初始化/删除现有Core/Loading负责，缺少对象时既有return保持。
3. 已有Three/Vitest/ViewerEngine.prototype CPU惯例，无需新库或运行依赖。
4. makeSceneSnapshot→primitiveState/getModelTransform和captureSceneModelState消费author store；恢复入口scenePersistenceController/applySceneViewerSnapshot均调用applyModelState。故物理出图与保存一并读到错误旧缓存。
5. 实际3qmg9O显示Three椭球正确，保存snapshot却position.y=1/rot=0/scale=1；原夹具y=0/.2,.3,.4/1.3,.8,1。PT HDR红区域y=0..31，与错误地抬高的源geometry一致。新增实际ViewerEngine.proto恢复→primitiveState/makeSceneSnapshot回归，独立覆盖输入/返回/快照/Three投影修改隔离及普通model/repeat/missing-id；无GPU或renderer构造。
6. 按I-C16实际作者出图source缺陷补最小一行store同步，不改packet/camera数学或测试fixture掩盖。独占ignored i-c16-author-transform-sync-20261001/，root核SHA提升。

已有（不重建）：author transform store、getModelTransform读权威、防Three临时projection污染、clone隔离、生命周期删除。真实缺口：恢复入口未登记已恢复的权威transform。applyModelState同步structuredClone(state.transform)到既有store，保留Three真实投影、后续恢复与dispose语义。根路已SHA提升该一行与实际ViewerEngine/primitive snapshot测试，正式7/7、Web tsc/build通过；窄屏footer CSS也已提升。旧失败与根因证据保留。

## 两fresh实际产品验收

根路actual browser `jwDRdw`已两轮通过：每轮4个真实Worker全部关闭，283个实际HTTP UI/Worker body哈希与dist相同，无pageerror/assetGuardError。36个最新提升项及3085个正式源/构建文件在前后守卫SHA一致，`8a8c20acfc63a6aa642f93649de1dff8b695d21c1433d70b262f39072c00f1f1`。原始report位于`test-output/runs/2026-09-05/i16-author-physical-jwDRdw/report.json`。

真实菜单→makeSnapshot→compiler→dedicated Worker→CPU多跳→HDR下载已消费；默认studio椭球完整入镜，真实取消清空/释放、材质roughness=.7修改令旧积累失效且canvas清空。两轮snapshot精确保留position[0,0,0]、rotation[.2,.3,.4]、scale[1.3,.8,1]。256spp studio160×90的55.88%噪声仍严格只能保存preview，final不可用；未把此画面当已收敛最终作品。独立合法非空作者发光box在相同physical模式64spp达到noise=2.9989271991673465e-6<原2%门，真实final HDR两轮SHA一致`4e1c75828e9c6e421a4e7bcfd4693a4c7beaec37bb2f1b42268a37f4e050c842`，独立RGBE量化oracle误差.0020335002336651087过门。

实际深色1920两轮及1280/480辅助响应截图已人工查看；footer关键动作完整横排、椭球无旧错误抬高裁切、取消/失效/导出状态明确。十维产品切片评分各9.0–9.2、同族检查和范围说明位于`test-output/i-c16-author-product-20261001/visual-review-20261001.md`。3D评分只评价本片支持域/作者变换/物理响应/输出正确性，不称256spp噪声预览具有完整最终照片画质；完整160×90默认studio收敛未在浏览器耗时跑完，2×2正式CPU30901spp对照已有。

据锁定remaining的“I-C16 / T10 离线路径追踪出图产品模式：累积/材质变更失效/取消/导出及收敛对照，复用MC/RT参考”行，本片产品入口与既有真实MC/RT证据已经齐备，可供根路审核关闭该静帧产品行。T10硬件RT/refit/纹理/降噪全包保持后继，支持域外纹理/单面/alpha/扩展层/HDR环境/局部IES继续实际拒绝。
