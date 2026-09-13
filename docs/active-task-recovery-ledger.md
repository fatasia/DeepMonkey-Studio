2026-09-13 21:20 Codex 根目录专项整理（未提交、未 push）：核对外层备份仓各目录用途与主工程引用；删除空的根级 `test-output/`、未被当前 pnpm 使用的旧 `.pnpm-store/`（当前实际 store 为 `D:\.pnpm-store\v11`，删除前确认其中 junction 仅指向并未删除 `bim-studio/`）以及 `bim-studio-docs/.chrome-capture/` 的 819 个 Chrome 用户目录/缓存文件，合计约 114.5 MiB，并新增外层 `.gitignore` 防止三类产物回流。保留主工程 `bim-studio/`、MinIO 二进制与权威数据、Oracle Instant Client、安装包及宣介最终成品；未删除任何可能被运行时使用的目录。

2026-09-13 21:15 Codex 文档与过程证据整理（未提交、未 push）：按用户“可能在用的保留、过程文件/文档可清理”补充执行。删除 9 月 10 日前且无在途修改的旧 verification/handoff/checkpoint/review/report、14 批旧素材目检 JSON、已被现行 Deep Engine/平台计划替代的旧路线研究，以及对应 9 月 9 日及更早截图、诊断脚本和日志；`docs` 顶层由 138 文件收敛至 37 文件，新增 `docs/README.md` 作为权威计划、当前验收、稳定参考的统一索引。修复删除后 7 个历史 Markdown 引用，递归文档链接检查为 0 断链，仓库治理门禁继续通过。保留当前 9/12–9/13 规格/报告/视觉证据、`AGENTS.md` 指定三份权威计划、稳定产品/部署文档、运行数据、外部素材、真实模型和活跃任务新生成的约 0.96 GiB 构建产物；最终核验时内层工作区约 11.62 GiB，较初始 32.41 GiB 减少约 20.79 GiB，连同外层 Git 压缩净释放约 24.7 GiB。

2026-09-13 21:05 Codex 全仓清理（未提交、未 push）：在外层/内层双仓结构和大量并行未提交改动下，仅删除可证明可再生内容；清理 Rust/Tauri/Cargo target（含漏网的 `target-native-packet-cache`）、各 workspace dist、浏览器/Unity/.NET/Revit 缓存、运行日志、复制型 WASM/Draco/Basis 产物及已删除 Node-RED 工作区残留包，并对外层 Git 执行 `git gc --prune=now`。内层目录核验由 32.41 GiB 降至 12.55 GiB，外层 `.git` 由约 4.66 GiB 降至 0.71 GiB，净释放约 23.8 GiB；保留 8.17 GiB 权威运行数据、2.37 GiB 文档引用测试证据、338.8 MiB 真实测试模型、环境/证书、外部素材和全部未提交源码。新增默认只预览、显式 `--apply` 的 `scripts/clean-generated.mjs` 与 pnpm 入口，补忽略规则；修复治理门禁读取 Git 索引中已删除 package manifest 的缺陷，回归 4/4 且 `pnpm gate:repository` 通过。依赖审计：22 个 workspace 锁文件离线冻结校验一致，运行依赖未发现零引用项，17 个内部包均有入站引用；不基于静态猜测删除声明依赖。全量类型检查被并行 Deep Engine 在途代码 4 个既有错误阻断（`competitiveBenchmarkRunner.test.ts` 缺 `setGpuInstrumentation`，`threeWebGpuBenchmarkBackend.ts` 后端断言不兼容），与清理改动无关。

2026-09-13 07:00 GLM 收口完成（未提交、未 push）：CC0 缺口模型下载交付——20 个 CC-BY-4.0 真实设备模型入库（相机 4/传感器 6/车辆 5/人员 5,全部 author/originUrl/attribution 完整署名,拒绝 15 个超限候选）,匹配表 53→73,预制体缩略图渲染器修 2 处 SkinnedMesh bounds 失真,prefabs 36/36 测试,20/20 特写目检过。剩余 ~43 种类无达标 CC0 如实申报继续程序化兜底。全仓终验收口：apps/web tsc 0 错误、web 套件 483 文件 481 过（2 失败=并行 deep-engine lab 3 探针+parametric workbench 裸 HTTP,均为他会在途文件已记录移交）;根目录 scripts/lib+tools node:test 12 文件单独跑全过（unity-package-archive 1 失败为 Git Bash tar 盘符路径解析的环境问题,与本轮改动无关）;api plantLiteStudy 3 失败属并行会话 plantLite 在途改动。素材终态：2D 预设 520/看板模板 317（32 域）/预制体 120（73 真模型+47 程序化兜底）/风格库 18 套/真实图表类型 4 新增/示例数据 32 域行业节律。待用户复核：终版对照板（apps/web/test-output/visual-compare/final-state/ + cover-quality/final/ + prefab-real-models/compare-thingjs.png）。未 commit、未 push、admin/.env 未动。

2026-09-13 00:30 GLM 数量波次 B/C 交付 + 全仓终验（未提交、未 push）：波次 B 看板模板 277→317（32 域=32×10−3，3 个为质量裁删不回退；4 新域电力交易/化工安全/冷链物流/会展活动各 10 真实指标；9 大类归并与 18 套套件同步；40/40 目检通过 0 删除；components 1193/1193）。波次 C 预制体 98→120（感知+6/视觉+4/车辆+5/仓储+4/移动+3；4 轮目检修 8 处几何构图问题，22/22 通过 0 删除；相机 7 型拆独立文件）。全仓终验：pnpm -r typecheck 通过；全量 Web 483 文件仅 2 失败=并行会话在途文件架构违规（deep-engine/lab 3 探针 + parametric/ParametricModelWorkbench 裸 HTTP），非本轮产物已记录移交。终态实机：资源页概览统计二维 420/模板 317/预制体 120 上墙，氛围背景/头部/分类 chips 终态可见（apps/web/test-output/visual-compare/final-state/）。剩余待办：真实渲染封面全量性能取证、echarts-wordcloud bundle 预算生产构建验证、S3 余 109 处 z-index 全局审计、波次 B/C 报告第 15/16 节已写入 docs/delivery-report-2026-09-12.md。

2026-09-12 23:25 GLM 第三波交付（未提交、未 push）：素材数量波次 A 完成——2D 预设 250→420+（7 族：行业 KPI 60/仪表阈值 16/区域地图 16/报表形态 14/控件 12/装饰造型 24/分析增强 28），170 个新预设逐卡双主题特写 340 张+30 张 contact-sheet 已产出，根会话抽检 5/30 覆盖 7 族五项全过；聚合断言 ≥420+聚类门禁（同形簇=0）+components 全量 1153/1153 通过。视觉风格库 7→18 套（28 域恰一覆盖，283 测试）。素材中心分类体系（2D 七大类/模板 9 大类+行业包标准分层/预制体 14 类 chips）+页面级审美升级（页面头部/概览统计/全页氛围背景命名空间隔离零泄漏量化证据/216px 栅格/空态设计；用户授权全页背景与排版可改，唯一标准不突兀）交付。真实渲染封面+示例数据管线接线验证成功：模板库 SVG 先行→真渲染截帧渐进替换（实机 6 卡）；模板插入即带示例数据实证（生产运行监控·示例 10 组件数据在线）。真实图表类型交付（词云 echarts-wordcloud@2.1 兼容 ECharts6 像素级验证/箱线/瀑布/极坐标，1149+248 测试，拖入画布 0 错误）。剩余待办：波次 B 模板 277→320（4 新域）与波次 C 预制体 98→120——规格在 docs/asset-quantity-wave-spec-2026-09-12.md，启动时写入逐个目检硬门槛（每预设双主题特写五项全过，数量让位质量）；两代理因 quota/captcha 中断（封面管线代码已接线完成仅剩验证取证；波次 A 已由根会话接续完成）。真实渲染封面全量性能取证与 check-bundle-budget 生产构建验证待做。诚实边界：词云/箱线/瀑布/极坐标已真实化，封面数字为确定性装饰，KPI 装饰数字绑定真实数据集后替换；S3 余 109 处 z-index 待审计。

2026-09-12 13:00 GLM 第二波交付（未提交、未 push）：用户指定八项 bug 全部实施并验证——S1 标签底板（真因=画布固定 640×160，D2a 修复+354 测试）、S1-A OutlinePass 幽灵板（postProcessingRuntime 包装 OutlinePass.render 内部隐藏 Sprite，首版误伤主通道被截图抓到已纠正，终态远景/近景标签正常零幽灵板）、S2 tabular-nums（8 文件 35 选择器）、S3 z-index（新增 --layer-canvas-* 3 令牌收敛病理值，109 处低风险记录）、S5 断连横幅（src/appStatus/ 监控+Banner，api.ts 在线出口接线，6/6 单测+Playwright 503 拦截实测）、S6 409 指引（应用保存链路复用 workspaceSaveFailureGuidance，实测 toast 可见）、S7 标尺（实渲染 12px+隔刻度）、S8 编辑场景记忆落点（src/studio/lastWorkspacePreference.ts，实测三维记忆直达）。素材扩量对标帆软/山海鲸/ThingJS：2D 预设 157→250（+93，332 测试，442 截图 5 轮闭环）、看板模板 120→300（30 行业域×10 指标，300 个 FVS 式封面 dashboardTemplateCoverArt.tsx，9 大类分组+类型筛选+推荐最新双分区+7 套主题套件鎏金/绛霄/翠涛/青冥/沧澜/紫电/霞光，1160 测试，4 轮闭环）、预制体 78→98（C1-C8 造型细节全实施，26/26 测试）。全部原创零竞品素材/名称。集成复验：全仓 pnpm -r typecheck 通过、全量 Web 2223/2225 通过 0 失败（上轮 deep-engine 架构失败已被并行会话修复）。诚实边界：词云/箱线/瀑布/极坐标为最接近类型诚实命名（真实新类型需 contracts+渲染器施工，词云需 echarts-wordcloud 新依赖待用户批准）；封面数字为装饰；推荐排序不造假热度；S3 余 109 处待全局审计；后端 502 属服务端。详情 docs/delivery-report-2026-09-12.md §8。

# Deep Monkey Studio 当前任务恢复总账

2026-09-12 22:42 Deep Engine 优先批次续跑（未提交、未 push）：修正 Browser Standard PBR 反射 LOD 从固定 7 为按实际 cubemap mip 数动态取值，并把原生 IBL 完整接入 Renderer 的 group0/binding3–6；RTX 4060 Laptop/Vulkan `--smoke-ibl` 实际 present，IBL on/off HDR readback 为 915 个变化像素、亮度 255.374535 > 184.904717。DeepSL 无纹理/非双面 Standard 固定子集已由 adapter 进入同一 v2 forward/shadow package，Browser/NVIDIA 与 Native/Vulkan 均执行。新增可复用 WebGPU GPU culling：输入独立 bounds + 144B Deep instance 行，六平面 sphere test、atomic compaction、受 capacity 限制的 `drawIndexedIndirect`，输出声明 VERTEX；Lab 同设备真实读回 4→2 可见实例、`indexCount=3`，Naga 验证通过，并已接入 PbrRenderer 的不透明与阴影批次，透明批次继续排序直绘。最新 Browser Lab 构建 `1efdfffd589d28df3c3507dbe1ce5de99701fc843601a2ec644a74ea6f1b3b51`，记录 `webgpu-1789226557820.json`，Deep Vitest 55 文件/627 项、Node 26、runtime purity 131 Browser/60 Native/194 resolved packages 通过；Native Rust 91/91、fmt、clippy 与 IBL smoke 通过，release EXE 7,895,552 B，SHA-256 `0D69FF58746DCC7066099D65E49AA3F8A7A17977729C6FCB31BBA1E0A94D94A3`。当前仍诚实保留：空间索引/HiZ/LOD/纹理压缩流式、级联阴影、Graph UI、持久化 CAS/热重载、完整材质与原生 Studio/设置切换都未完成；正式 apps/Three 默认路径未接线，不能据此宣称完整引擎、竞品领先或 Unity 90%。

2026-09-12 Deep Engine 优先批次（未提交、未 push）：用户明确“优先引擎”。Browser 主线完成 Standard Surface 的真实 GGX/Smith/Schlick、方向光、PCF shadow、diffuse/specular IBL、AO、emission、alpha 与线性 HDR lowering；DeepSL 编辑器在语法→typed IR→WGSL→当前 GPU 驱动全链路通过，失败候选保留 last-known-good。`deep-shader-package` 升级到 v2 / `webgpu-wgsl-pipeline-2`，冻结 ABI、entry、bind/vertex/attachment/depth/blend/raster/MSAA/resolve 与完整 cache key；TypeScript/Rust 共用 golden，Browser executor 已在真实 NVIDIA WebGPU 创建 4× forward 和 depth32float shadow pipeline。最终 Lab 构建 `7c185061…`，243,655 B/gzip 74,002 B，记录 `webgpu-1789219066453.json`，控制台 0 error/warn。Native ABI-1/2/3 已对齐 40B geometry、16B tangent、144B instance、160B material、208B Frame、rgba16float/4×MSAA/ACES 和 group0 b0..2；RTX 4060/Vulkan 真实 2048² shadow+3×3 PCF 读回 118 像素变化，亮度 1079.459051 < all-lit 1123.242496。根复验：Deep Vitest 50 文件/588 项、Node 26 项、11 个 ESM 入口、type/build/isolation core/runtime purity 通过；Native Rust 79/79、fmt、clippy、textured/alpha/textured+Deep2D/shadow 四项 release smoke 通过，EXE 7,227,392 B，SHA-256 `edc4a4d…`。正式 apps 没有被本批接线；全 `lab:isolation` 的 Deep 自身违规已修清，只剩并行正式工作树既有 `apps/web/src/parametric/ParametricModelWorkbench.tsx` raw fetch 架构失败，本批未越权修改。当前诚实缺口：DeepSL 通用材质 layout/entry adapter、Native package GPU executor、IBL bindings3..6、clustered lights/级联阴影、Graph UI、CAS/热重载、compute/高级材质；不能据此宣称完整引擎、竞品领先或 Unity 90%。

2026-09-12 Deep Shader 目标提升（未提交、未 push）：用户明确 Shader 必须达到 Unity 能力，同时保持类似 Three 的简单轻量，并成为编辑器一等创作能力。路线固定为“Unity 级生产模型 + 渐进式创作体验 + 自研 typed Shader Graph/DSL + WGSL 唯一运行目标”：普通作者用 Standard/Unlit 模板与 Inspector，高级作者再展开 Graph、DeepSL、Technique/Pass/变体和生成 WGSL；发布只携带实际使用的 Pass/变体/WGSL。`SHADER-00` 首批已落地版本化 Shader→Technique→Pass、typed graph、四组绑定、render state、确定性 WGSL/source map/cache key 与受预算变体；另完成低样板 `shader-presets`、带 revision/undo/LKG/stale 门禁的 `shader-authoring`、Browser/Native 共用 `deep-shader-package` v1，以及覆盖 12 类 Unity/Three 输入、9 个能力面、6 种显式策略的迁移合同。根审查补修无 attribute WGSL、Picking 错用材质色、注释伪入口和验证快照变异边界。全包 44 文件/552 Vitest、26 Node 策略及 Naga/TypeScript/build/8 ESM/runtime purity 通过；Standard 当前只保留 metallic/roughness authoring 并明确提示 PBR lighting 尚未接入，原生编辑器 UI、DeepSL parser、现有 PBR 共用包、热重载/CAS、compute/高级材质仍待后续。静态 Shader 语料为 2,239 文件、38 条证据、0 静态解析/动态 import 未决，语料 hash `c9825233…`，JSON 可重现 hash `a08e4ac1…`；缺失持久化脚本、运行时生成和 Unity 资产仍明确保留。正式 apps、默认 Three 和项目数据不变。规格与清单见 `docs/specs/deep-engine-shader-system-2026-09-12.md`、`docs/specs/deep-engine-shader-source-inventory-2026-09-12.md`。

2026-09-12 Deep Engine Unity/多格式兼容补充（未提交、未 push）：用户提醒现有编辑器可导入 Unity 包与大量模型格式，并询问 Unity 导出的 WebGL/WebGPU。核验后纠正：当前产品的 Unity“导入”是托管 Unity Web Build ZIP，以 iframe + Unity JS/WASM Player 执行，已实测版本为 2022.3/6000.0 WebGL；它不是 `.unitypackage`、UPM 或 AssetBundle 到本产品场景的转换。Unity 6.6 已正式支持 WebGPU Web backend，但本仓尚无 6.6 WebGPU 真构建，manifest 也未记录实际 graphics API，因此当前只能标为架构可兼容、待实测。旧 Studio 保留 WebGL，并可在独立门禁后托管 WebGPU；最终零 WebView Deep Native 不执行这两类网页包。新路线冻结现有 25 个模型扩展名及真实 direct/converter/provider/subset 证据，Unity project/`.unitypackage`/UPM/Scene/Prefab/AssetBundle/Addressables 经隔离 Unity Editor exporter 输出内容寻址 Deep Asset Package；每种格式按几何、层级、材质、纹理、动画、蒙皮、morph、元数据、PMI、行为等逐项验收，扩展名存在不等于 native-ready。已新增机器可判定的 `assetCompatibility` 合同与失败关闭测试，并在 Deep 交付清单加入 ASSET-00..07；正式 apps 未修改。

2026-09-12 Deep Engine 零旧包袱决策（未提交、未 push）：第一原则设为“以最终目标和可验证事实纠正局部方案”，发现用户设想、旧计划或当前实现存在目标互斥、性能包袱、兼容风险或更优路线时直接指出并修改权威方案，不机械照做。用户最新明确 Deep 路径完全放弃 WebGL，最终客户端完全放弃 WebView/Chromium/Tauri 前端，GUI、文字、图表、HUD、节点画布和 3D 全部经同一原生 `wgpu` device/surface 执行并保持跨平台；Three/Babylon/React/ECharts 只允许存在于旧正式环境、Browser Lab 或隔离迁移工具，不进入 native runtime。该决策覆盖此前“WebView Studio + native Viewer + 混合 Studio”的迁移路线。正式旧项目仍冻结保护；迁移期旧 Studio 的 Three/Deep 一键切换继续用于兼容验证，最终 Deep Native 客户端只含 Deep。已重写 `deep-engine-native-gui-migration-2026-09-12.md` 并同步执行计划/交付清单；运行时纯净门禁、Rust Deep2D 合同、全 wgpu 2D/GUI/图表和 3D 材质主线并行推进。源码迁移盘点已覆盖 1,724 文件，React 549、DOM/browser 470、ECharts 15、Monaco 6、Worker 14、direct network 9、Three/raw graphics 152；计数用于冻结语料，不直接换算工时。

2026-09-12 Deep Engine 并行加速批次（未提交、未 push）：四天仍是 9 月 16 日集中检查点，不缩减 Unity/UE5/Godot 90%、Three 插件兼容与正式项目保护分母。已完成通用 RenderPacket 与联合 GPU 事务，嵌入 PNG/JPEG、UV0、baseColor/MR、sampler、KHR_texture_transform 已进入自有 WGSL；Khronos BoxTextured 在真实 WebGPU 显示，错误回滚和 device loss 后重建通过，记录 `test-output/deep-engine/webgpu-1789204519285.json`，构建 `f9abd32f…`。Three 0.185.1 DataTexture、UV0、baseColor 和 metalness(B)/roughness(G) 合并桥通过真实依赖测试，不修改作者对象。normal map/TBN 已完成源码与 360 Vitest + 5 AST，待根最终浏览器复验。独立无 WebView 的 Rust `winit 0.30.13 + wgpu 30.0.1` Viewer 已绘制完整静态 packet：2 几何/2 材质/4 实例稳定合批、镜像绕序、非均匀缩放法线和空场景在 RTX 4060 Laptop/Vulkan 实际 present；Rust 11/11、fmt/clippy/依赖门禁通过，debug 15,461,888 bytes、SHA-256 `f1857483…`。本条记录中的旧 WebView/混合迁移判断已被上方“零旧包袱决策”覆盖；`HostCapabilities`、单一 `SessionAuthority`、`OverlayCommand`、`ChartSpec` 与 headless `Deep2dDisplayList` 仍是有效协议。开源复核纳入 React Native Windows/Fabric、@wuba/react-native-echarts、ChartGPU 和 Lumen Charts，只作为带门禁的参考，不写入正式依赖。当前并行完成运行时纯净门禁、Rust Deep2D、AO/双面材质、normal map 真机和全包复验，随后推进全 wgpu GUI/图表、透明/灯光/动画/大场景及原生打包。正式 apps、默认 Three、作者数据/脚本、账号与存储未修改；未把后台节流 RAF、固定样本或 present smoke 当 FPS/竞品/像素画质结论。计划与证据：`deep-engine-execution-plan-2026-09-12.md`、`deep-engine-native-gui-migration-2026-09-12.md`、`deep-engine-render-packet-verification-2026-09-12.md`、`deep-engine-delivery-backlog-2026-09-12.md`。

2026-09-12 WebGPU 独立管线增量（未提交、未 push）：用户后续明确“开源项目仅参考吸取精髓，自主开发核心，不影响现有项目正式环境”，覆盖此前必须整体基于 Orillusion 的实施建议；新增默认视觉/性能原生对照 Unity、UE5。已完成独立 `packages/deep-engine/src/webgpu` 固定材质夹具：设备/取消/迟到释放、真实首帧与丢失重建、实例化球体、GGX PBR、GPU 生成摄影棚 IBL/预过滤/DFG、静态阴影缓存、HDR/MSAA/输出、可选异步 GPU 时间戳；实验页 127.0.0.1:5291，无产品 API/存储调用。72 测试、类型/构建/隔离门禁通过；全仓源文件门禁 2470 通过。浏览器记录和两轮以上截图见 `docs/specs/deep-engine-webgpu-verification-2026-09-12.md`，最新构建 hash 9f343a7a；设备丢失停止、旧受管资源归零、重建首帧已验，不能当驱动显存零泄漏证明。正式 apps 无引用，未改默认引擎/设置/脚本/项目。本轮待办：通用 RenderPacket/模型/纹理/完整画质、项目兼容、真实一键切换；3D 自评 8，未宣称视觉最终达标或领先竞品。项目级后验收：Unity/UE5/Godot 90%、完整原生/GUI；明确排除：8 小时 soak 仍按用户取消执行。

2026-09-12 01:35 GLM 性能线验收完成（未提交、未 push）：用户三项任务之"性能项证据补充"已闭环。①OffscreenCanvas 此前为空开关（worker 模块存在但引擎未接线），本轮真实接线：协议扩展（ready/位图回传）、worker `transferToImageBitmap` 回传、新控制器 `viewerOffscreenController.ts`（体检→快照→worker→覆盖画布；漂移防抖重检 800ms；重启预算 2 次/20s；材质按需采样 version+90 帧兜底）、引擎 Core/Runtime/Lifecycle 集成、绑定改必选、设置页真实状态显示；真实修复两个崩溃：快照"先 await 后序列化"竞态（改为先同步序列化）与 ObjectLoader 纹理缺图像 `undefined.data`（解析前合同校验）；标注/告警 Sprite 属易变叠加层，不进快照与签名，主线程投影补绘。②遮挡剔除/大对象树虚拟化补齐浏览器实测证据，门禁 `apps/web/scripts/gate-performance-evidence.mjs`（已注册 `gate:performance-evidence`）全绿：虚拟化 10000 行→19 行挂载、DOM 降 99.8%、末行 reveal 可达；遮挡剔除 511/601 网格、免绘 62.1 万三角形、draw calls 降 84%（合批关闭口径；合批时收益体现在 avoidedTriangles）、开关切换画面 SSIM 0.9981；Offscreen 激活后主线程 drawCalls=0（worker 240 draws）、cpuFrameWorkMs 473→55ms、结构漂移静默重启 restarts≥1、关闭恢复主线程、WebGPU 如实回退（原因可读）、主/worker 画面 SSIM 0.9591（差异=OffscreenCanvas MSAA 不可用与网格 mipmap 路径，diff 图目检无几何错位）。单元 9/9，viewer+visualQa 350 用例无回归。证据：`docs/performance-verification-2026-09-12.md`、`test-output/perf-evidence-2026-09-12/run-nBoEz0/`。诚实边界：SSIM 0.959 为实现级 AA/mipmap 差异，未声明逐像素等价；CPU Tracing 主线程任务对比仅记录未断言；门禁为 headless Chrome 合成夹具口径。

2026-09-12 GLM 并行批次四线全部交付（未提交）：D 全量测试线完成——u120-ui-sweep.mjs 49 步三遍全过（1440/1280/980），唯一实锤缺陷 P1（环境面板关闭钮被视图立方体遮挡）已修（scene-workspace.css z-index 2→20）并实测验证+同族排查；待核实大问题 S1-S8 写入 docs/ui-sweep-major-issues-2026-09-12.md；控制台最终轮仅预期内 401。A 线二维资源（5 文件+三轮 34 图+待核实 6 条）、B 线模板中心（5 文件+130/130+三轮 24 图+封面重绘/结构改造回退待核实 B0-B2）、C 线预制体缩略图（78 个 14 类全真实 3D 小样+渲染器+9 用例+2024 回归+4 轮闭环+浅色主题未测如实申报 C1-C8）全部交付。集成复验：全仓 tsc 0 错误、全量 Web 2023/2026（唯一失败=并行 deep-engine 会话的 packages/deep-engine/lab 未跟踪文件违反架构边界，非本轮产物未越权修复）、性能门禁合并后全源码重跑全绿（数字保持）。总交付报告 docs/delivery-report-2026-09-12.md（含 10 维打分、诚实条款 6 条、待核实清单指引）。竞品参照 docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md + test-output/competitor-ref/。待用户：核实两份待办文档后决策是否实施封面重绘/结构改造/其余大问题。

2026-09-12 GLM 并行批次四线全部交付(本条为过程留档)（未提交）：用户任务之二"全量 UI 测试"（最高优先级）与任务之三"二维资源/看板模板/预制体缩略图商用化"（较低优先级）由四个并行代理执行，文件所有权互斥：A=二维资源库（DashboardComponentPreview/PresetFactory/相关 css）、B=模板中心（DashboardTemplatePreview/DomainPacks/ReadableChartOptions/Typography）、C=预制体缩略图（新建 src/prefabs/thumbnail/ + IndustrialPrefabThumbnail + BuiltInAssetBrowser prefab 段）、D=全量测试遍历（u120-ui-sweep）。用户纪律：只直修小问题（影响小/把握高/局部可验证），大问题一律写 `docs/ui-sweep-major-issues-2026-09-12.md` 等用户核实；A/B/C 同样遵守（大改/没把握方案写 `docs/ui-major-issues-2026-09-12.md`）。竞品参照（用户要求 1:1 复刻结构与风格，禁止复制素材/名称/Logo）：帆软 FVD（七维筛选/纯净封面卡片/素材详情标签体系）、app.fanruan.com/templates（9 大行业类/类型筛选/左列表右预览）、FVS 官方视觉规范（深色基底/行业色调映射/图表净化清单）、山海鲸市场（深色分类树+计数/金色分层角标/横向分区行）、ThingJS 资源中心（3 列真实 3D 封面+计数缩写）、Hightopo（极简网格），全部入库 `docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md` + `test-output/competitor-ref/`（u121 脚本无头抓取）。待四代理交付后：跨区同族排查、全仓 typecheck/测试合并重跑、双主题两轮视觉闭环、10 维打分、交付报告。注意：并行代理在改 B/C 文件时 tsc 曾出现 DashboardTemplatePreview/prefabThumbnailKit 错误，最终合并后必须全仓重验。

2026-09-12 WebGPU 自研引擎接续（未提交、未 push）：已读取“规划自研 WebGPU 引擎方案”任务，承接用户“分析调整并执行、正式完成前保护现有项目”的授权。新增最终目标为设置一键无感切换自研引擎/Three.js，性能与能力超过 Three/Babylon，向 Unity/UE5/Godot 各自 90% 推进；这属于长期目标，不是本次完成声明。现行实施依据 `docs/specs/deep-engine-execution-plan-2026-09-12.md`，旧路线第 5–15 节执行建议由它覆盖。采用 Orillusion 固定 commit 审计后接管绘制、初期保留 Three 作者对象与数学/动画语义、同一脚本宿主、按真实收益逐步缩减兼容依赖；原生先 Viewer 后 GUI/编辑器。已完成基础批次：修复 deep-engine 接手时 TS 失败和场景树缺陷，补失败原子性/dirty/调度传递失败/渲染图资源校验与缓存；新增独立后端切换协调器及取消、超时、迟到清理、帧边界合同；AST 清单 2157 文件、165 个模块/符号、2266 静态引用、409 未解析证据项，全部兼容状态 unverified，原始 JSON 在同目录。本轮待办：真实 GPU/PBR 与 Orillusion adapter、运行时语料、完整项目平替、真实设置切换及性能/画质门禁。项目级后验收：原生与完整能力矩阵、三大引擎 90%；明确排除继续包含用户取消的 8 小时 soak。生产 apps、默认引擎、账号/存储/数据未改；不把 headless/mock 验证当 GPU、无黑帧或性能领先证据。最终检查结果见该执行方案 §8。

2026-09-09 用户最新增量：明确要求此前尚未做的1普通拾取BVH、2大对象树按需渲染、3优化器连续图层缓存，加遮挡剔除与OffscreenCanvas同时实施；能可选开启尽量可选降低风险。此条覆盖先前对遮挡/Offscreen“暂不优先”的候选判断，但不授权以空开关或纹理编码代替实际能力。三代理当前cloud做BVH、AI先修共享缓存/合批critical再做大树、resources做连续图层缓存，根负责遮挡/Offscreen与旧UI收尾。旧模型替换/工程资产/KTX2已专项验收并从交接条目删除，证据 `model-engineering-verification-2026-09-09.md`；原全量全菜单及部分AI/交付/连贯UI尚待收尾。最新新增复核缺陷：共享DataTexture/压缩mipmap的raw写前深拷贝、非均匀父缩放造成剪切/自定义shadow回调合批回退、gltf成功但metadata失败时clone lease释放，AI代理负责修。用户问旧任务是否全部收尾，已明确答复未全部：功能主体已落地，剩页面/性能/窗口与最后全量验收，不把新任务混入旧完成数。

2026-09-09 22:33 Codex 持续验收（未提交未 push）：新增五项和性能 A–F 全部保持本轮范围。根已接入跨实例 glTF 共享加载/几何/纹理、独立材质、引用释放与可信 raw 接口写前分离，以及兼容静态网格绘制实例化（保持作者对象身份，按空间分组，不兼容材质/动画仍普通绘制）；33 项相关回归通过，Web22:27类型通过，静态QA22:33重新构建。按需渲染浏览器已观察1000对象静止 renderedFrames 固定5、skipped 持续增长，拖动恢复绘制，真实CPU/双后端/效果及资源长期回落仍在验；微基准不当作整机帧率。KTX2已本地编码UASTC/ETC1S，资源代理实际WebGPU载入通过，替换/撤销/保存继续。工业AI8files36、交付恢复11files52、云输入Worker6files21专项通过，不能代替最终页面验收。项目包API导入再导出已验证完整场景/2D/脚本/模型/模拟数据；根实际3D未保存脚本刷新后恢复成功，新应用恢复弹窗尚待验。最新真实BUG：新场景首次保存未激活（AI代理修）、替换后资源/实例ID冲突（资源代理已修等待静态验）；HMR旧engine导致QA空保存暴露保存就绪保护不足，正在同族排查。云代理继续现有诊断的分阶段加载计时与接收端RTC导出。交接清单仅删除已验收项；最终全菜单/全栈/双主题及宽度验收尚未完成，不继承旧全量结果。

2026-09-09 22:07 Codex 续跑（未提交未 push）：用户最新要求新增五项与旧问题同步，并已明确将性能方案高收益及按需渲染、重复资产实例化、KTX2 全部纳入；先前仅方案/候选的排除已被这条明确授权覆盖，最终全菜单全量验收仍最后做，5–8小时旧整轮估计失效。资源外链/优化器/参数化/拓扑旧项已验并从交接清单删，报告 `resources-optimizer-final-verification-2026-09-09.md`。真实源码调试已获用户专项授权运行既有 `gate-author-script-debug.mjs`，4/4，`test-output/codex-2026-09-05/author-script-debug-hEWRnl/report.json`，不是帧步进替代；根生产build21:47绿但后续改动仍需重验。根修旧场景脚本入口、项目导航会话恢复、菜单层叠、独立窗口返回分屏（真实12行QA脚本保留）；桌面显式非置顶/系统装饰/最小最大/任务栏，Rust5通过，CUA不能操作系统标题栏，不能宣称实际最小最大已验。根新增密集标签空间网格，首版1080负收益后改128个已显示标签才启用；7组交替采样显示4K10000标签CPU布局中位数8.67→4.14ms，输出集合一致，限定Node微基准而非FPS；21项focused过。新增五项：AI共享处置草稿/证据/保存撤销与数据查询本地真聚合已实现，待根UI，报告 `industrial-ai-usability-verification-2026-09-09.md`；cloud负责整项目包/2D脚本恢复（2恢复BUG21测试已过）；resources负责替换预检/工程配方版本预算。随后性能并行分工：根重复资产实例化与标签布局、AI代理deviceSignal缓存及按需渲染、resources KTX2、cloud云输入队列。子代理CUA browsers=[]，根browser1/tab3可用，根须代验。全量/最终UI未完成，不继承历史绿灯。

2026-09-09 21:35 Codex 持续并行（未提交未 push）：用户强调编辑器及全系统连续操作，新增“极致性能与交互优化方案”并明确不能停止原任务。云渲染旧任务已验收并从交接清单删除：实际1440P 57FPS、2160P 3840×2160 1425帧/12.55MB NVIDIA HEVC约36FPS，停止activeSessions=0，一键全服务正常；详见 `cloud-render-final-verification-2026-09-09.md`，不把4K描述为60FPS。钻取已新开真实场景确认保存恢复、预览成功，双主题两轮及防重复/撤销完成，已从清单删除；报告 `scene-drill-guide-verification-2026-09-09.md`。根修停用钻取事件状态不一致、更多菜单层叠/浅色文字；新发现AI页面刷新回首项目，已统一项目路由上下文和按账号session恢复，路由等4文件18测试过，浏览器复验待做。资源代理修资源→优化器StrictMode卡加载与资源外链，正在真实验收；AI代理修检查点磁盘失败污染和SIM尾端29/30截断，正在完成UI。云代理并行只读性能方案，不重复已有Worker/LOD/调度器。5174静态QA已21:29重建；5173源码HMR可导致测试中断，最终须冻结构建统一门禁。旧任务仍剩资源/脚本/AI-SIM联动；新增五项和全菜单全量未完成，不继承旧全量通过数字。

2026-09-09 16:34 Codex 续跑（未提交未 push）：用户新增 AI 全模块自包含审计（明确允许模型 API，禁止其它项目/外置业务服务必需依赖）；云画质分辨率；优化器图层改名/删除/隐藏与所有已支持格式入口（不体现暂不支持格式）；最终覆盖所有菜单/二级页/属性/子 Tab 的 UI、交互、功能、文字、排版，小问题直接修。三并行在用户中断后已恢复：ai_samples 正在电池真实三 ONNX 项目内置推理/移除默认8030，30测试已过；aigc_modeling 已将视觉样例改真实 YOLOX-Nano 本地识别，4API+5Web通过，继续钻取/AI/菜单清单；hightopo_topology 告警实现与28focused过，正在优化器真实编辑/撤销/导出及格式筛选。当前只有根浏览器可用，子代理浏览器报告 unavailable，由根代验。根云HTML/信令/发布origin与静音自动播放已修；1080P实际WebRTC硬件编码证据 streaming，NVIDIA HEVC、1258帧、6.6MB；720P实际videoWidth1280/videoHeight720已看到，随后源码热重启断流属测试环境，最终需稳定重验。四分辨率策略720/1080/1440/2160P按场景持久，控制面21测试过；设置UI已保存720P，实际帧率合同刚补。资源五文件类型已真实上传浏览；预制体/模板也浏览，模板首帧尺寸与浅色治理面板硬编码已修。16:11合并根typecheck/source2267/Web1834/API613/其余包测试和build全过（首屏317.9KiB），后续新改仍需终验。根为避HMR建立 test-output/review-0909 QA构建，Vite preview5174自定义代理配置运行（终验后停）；正式5173/4100仍运行，未动.env/账号/旧业务数据。剩根完整资源/脚本GLM/云/代验三代理/最终全页面和故障、发布恢复门禁，不能宣称全目标完成。

2026-09-09 16:00 并行推进：AIGC 参数化已走三模板真实几何→GLB保存→资源浏览→刷新→v1恢复，报告 `parametric-aigc-verification-2026-09-09.md`；图朴拓扑统一投影/逆变换、拖动连线及路径聚焦，两轮双主题四尺寸组合，报告 `topology-hightopo-review-2026-09-09.md`；AI 本地样例实跑、Agent检查点关闭重开已独立复核，电池下游8030不可达，报告 `ai-samples-verification-2026-09-09.md`，不能宣称真实电池推理通过。三并行当前继续钻取作者向导、共享告警、SIM 多车运输网络。根资源新增环境/PBR上传入库、所有项目类型和公共模型/环境/材质浏览、内置真实组件/模板/预制体浏览；API资源上传/失败回滚/重启恢复与目录7项通过，浏览器HDR/材质/视频上传成功（QA项目），高DPR画布缺CSS导致裁切已根治并补机器人同族。Web新类型通过，架构/资产网络10项通过；一轮Web全量1825通过但当时架构1失败已修，最终仍需合并重跑。默认studio重启三服务健康已实测；进一步发现Worker发布页同样错误使用APIorigin导致 `/published` 404，16:00已修启动区分Web页面origin与API观看origin，正在第二次重启验证真实WebRTC。根仍须完整资源双主题/失败/发布，GLM独立门禁和统一全栈验收。以上未提交未push，旧用户数据保持。

2026-09-09 Codex 实施中（未提交、全目标未完成）：用户要求推进全部任务，BUG→快修→竞品参考后改进；最新指定参数化建模参考 AIGC（Zoo/Sloyd），2.5D 参考图朴 Hightopo，并要求独立复核 GLM 已修复项。云 viewer HTML/offer/answer 受控代理 13 项通过；启动器默认 Node-RED/MediaMTX/云 Worker、独立日志/身份健康/复用外部实例，默认启动已实测成功，新增启动测试与 CLI 合计 12 项通过。脚本默认模板 ctx.self 导致首行假红已修；2D 分屏 CSS 强制隐藏、3D effect 反复关面板、窄窗固定分屏宽度与零宽网格抽屉均已定位修补，1280/980 浏览器实际点击及截图已做首批。渲染诊断原生独立 dialog、导出文字、浏览工具图标和指定转换器目录移除已修改。Web 一轮全量 432 文件/1815 项通过、API/Web 类型检查首批通过，尚需改动后统一重跑和双主题视觉门禁。IoT-NB 同步路由/客户端/本机目录发现已删除，历史关联模型及传递引用完整归档后退出活动项目（data/operations-legacy-imports-*.archive.json）；迁移幂等/保留独立记录/旧路由404与维护/仿真普通链路 6 项通过。未动 admin/admin、.env、postgres+minio，未 push。资源全类型、AI 样例、AIGC 建模、图朴拓扑、告警语义、钻取、SIM 与 GLM 独立复核仍属本轮待办，不能因本批修复缩围。

2026-09-09 Codex 现状复核：已按本轮人工测试重排 `docs/platform-gap-analysis-2026-09-09.md`。脚本真断点/单步、Agent checkpoint 恢复、SQL 受控写回、Shader 轻量版均有实现与验收依据，从待开发项移除。新增 P0 为云渲染公开地址 404、Node-RED/MediaMTX/云 Worker 默认一键启动、脚本新建工作区回归；P1 为 IoT-NB 项目解耦、全类型资源浏览/上传、AI 一键测试样例、告警语义、参数化零件生成器、拓扑 2.5D 与统一标题栏组合项；钻取向导和 SIM 多 AGV/多域交接列为 P2。暂停纯数量扩张、Monaco 内嵌调试器、完整 CAD/OLP 等低价值范围。本条仅记录复核与计划，没有实施或宣称修复。

2026-09-09 增量轮：差距调研 `docs/platform-gap-analysis-2026-09-09.md`（对标五家，量化缺口：行业包 4/10、模板 120/300+、资产 80/3000+、Shader/SQL/云渲染已补）。素材两轮清理：77 未过审 + 9 品牌/白膜全部删除，**80 项全部 approved 零遗留**（备份 test-output/source-b-prune-backup）。云渲染一键启动 `pnpm studio start web --cloud-worker`（本地 Worker 随栈、令牌进程注入、实测 configured+workerReady/RTX4060 硬编码）。SQL 受控写回确认已完成（真实 PG 测试 18/18，交接文档过时）。水处理运行包（第 4 包）gate 4/4。Shader 轻量版：材质外观"着色器效果"面板（菲涅尔轮廓光，onBeforeCompile 注入 emissive，合同可选字段持久化）。optimizer i18n 补全；frame 外 7 页字号实测 0 违例。全量：typecheck/2206 文件体量/Web 1810/API 599/其余包/u117 巡检全绿。未验证声明：Shader 真实 WebGL 目视待人工。详见 `docs/full-verification-report-2026-09-08.md` §7。

2026-09-08/09 夜间批次（GLM-5.3 定时任务 23:10 起）：用户六项已知问题全部修复并获浏览器证据——顶栏"更多">1500px 裁剪复发（overflow 根治）、分屏拖动 3D 闪烁（渲染前 resize）、云渲染 403 误判+卡片整禁+设置无引导（新增登录可读 `/api/cloud-render/capability`、可见原因行、三步启用引导）、tab 高度被 28px 兜底特异性长期压制（40/32px !important 提级+同族清剿 5 处）、2D 缩略图全同（widget.type 恒 undefined 兜底，改顶层 type+合同收窄）、optimizer 6-9px 字号与流水线语义等一族（12/11px 提级、done/active/skip/pending 三态、拖放、相机保留）；顺手修 vitest 误收集 scripts/*.test.mjs。提交 `eb0cb34`、`2d654e1`、`03f5c27`。素材线十四批视觉审核 **166 项全部审核清零**：批准 7→89（`docs/source-b-visual-review-batch{2..14}-2026-09-0{8,9}.json` 逐项留档），77 项保持待审且每项有明确问题记录（白模族约 20、品牌/商标约 10、集合包约 10、用途不符约 10、不可辨约 8、X4122 驱动警告同族 6——解决路径各异，不能靠重拍或放宽门槛绕过）。行业包 2→3：新增电力能源运行包五页（变电站联动、台账对账单测、`gate-power-grid-pack.mjs` 两轮双主题 4/4）。全量验证：根 typecheck、2199 源文件体量、Web 431 文件/1806 项、API 599 项、其余包全过、生产构建（首屏 314.6 KiB 预算内）、`gate-known-issues-fixes.mjs` 7/7（新写）、优化器工作流 4/4（实测 fontSize 12）、性能基准 4 组（1000 对象双后端 60fps 零错误）、u117 全路由无横向溢出。权威报告 `docs/full-verification-report-2026-09-08.md`（含未验证清单：云渲染真实 GPU Worker 端到端、分屏真实指针拖拽逐帧采证、素材 103 项待审等六项诚实声明）。

2026-09-08 最终收口：用户明确暂停行业包、素材新增/审批与模板数量扩充，本轮完成正式记录表单、REST/PG 写回、实际PDF、环境视口、SIM时间线/Study、AI当前页草案、必要Vapor、旧glTF材质全链路与首帧缩略图。根build/typecheck通过，Web438文件1827项、API132文件597项，2194源文件≤800；正常web全栈健康。权威验收 `docs/final-unified-validation-2026-09-08.md`，交接 `docs/codex-glm53-handoff-2026-09-08.md`。用户已授权最终完成后push `dev-studio`；两份GLM未跟踪草稿不纳入提交。

2026-09-08 r47 增量：根 build/typecheck/test 全通过，Web431文件1784项/API129文件587项，2159源文件≤800。二维填报刷新失败/只读重试/在飞后新读/面板互斥两轮4/4（`dataset-writeback-tBCU4j`），灯光增量与销毁竞态提交 `b3095b2`，无遮挡3D门禁4/4（`light-editing-8pPg9o`）。SQL真PG初版4/4但发现数据中心确认写后旧预览未刷新及浅色表格问题，进入r48；环境980收纳与AI-3当前2D页资产化也在r48实现，尚待统一构建。仿真空间门禁正在排除浮层对截图像素证据的污染。全目标仍待办，行业/素材未提前新增。

2026-09-08 用户最新执行顺序：先 3 填报与导出、4 UI/交互、5 仿真与 AI、6 必要 Vapor 改进；然后 1 行业包/业务页、2 素材审核；最后 7 全局验证与交接。当前并行实现 SQL 写回、填报刷新反馈、仿真空间层及灯光/预热增量修补，均以验证证据回填后认定状态；不提前宣称完成。行业包与素材暂缓新增但不移出本轮范围。

2026-09-08 收口增量：仓储功能提交 `cbc558e`，二维真实填报与写后指标刷新提交 `54eface`；r46 Web build通过，r45根类型/2142文件及Web1767测试通过；r46可读性4/4与实际PDF8/8已复核。当前批次细节和SQL下一实现入口见 `industry-logistics-continuation-2026-09-08.md`；全目标保持待办，不以本批验证缩围。

2026-09-08 当前批次增量：`industry-logistics-continuation-2026-09-08.md`。仓储五页已通过r44两轮4/4，目前两个业务包十页深化，3D匹配及≥10包/≥300页仍待办；素材7批准/159未批准。r44 Web build及426文件1764测试通过；二维填报成功后指标刷新已接线，正式画布表单/SQL不移出本轮。图表与素材卡视觉修补尚待最终统一构建，不宣称全目标完成。

2026-09-08 标题栏复核：`24abd5f` 的靠右修补仍生效；新增 `gate-editor-topbar.mjs`，2D/3D 双主题三宽度两轮 24/24，通过证据 `editor-topbar-FybcbB`。见 `topbar-alignment-verification-2026-09-08.md`。此项仅复核布局，不改变下列整体待办状态。

2026-09-08 最新增量：见 `industry-writeback-continuation-2026-09-08.md` 和接续检查点顶部。r40根构建/测试、r41类型、r42Web构建/1745测试通过；行业包/样本Excel/字号/计算字段各两轮4/4。r39 REST与单车仿真最终通过；r42实际PDF纸边修补两轮双主题8/8。十包/三百业务页、163资产审核、二维/SQL填报等仍待办，不宣称全项目完成。目标与明确排除项不变。

更新时间：2026-09-06（最新恢复状态见 §15.6 与接续检查点）
任务：规划 AI 开发与产品升级
任务 ID：`01a0437f-f06e-7dd1-b9d2-b866c3f76e11`
工作分支：`dev-studio`
功能闭环提交：`946e7a9c9021d211cf53b67552926955d137a797`

## 1. 使用方式

本文件用于在服务中断、任务续跑、上下文压缩或人员交接后恢复真实工作状态。恢复时按以下顺序读取：

1. 本文件：确认冻结范围、完成状态、排除项和当前待办。
2. `AGENTS.md`：确认代码、产品与验证硬门槛。
3. `docs/product-depth-experience-stability-ai-mcp-upgrade-plan-2026-08-27.md`：读取完整产品方案。
4. `docs/release-closure-2026-08-31.md`：读取最终闭环证据与诚实边界。
5. 当前 Git 状态、最新提交和最新门禁产物：以实际状态覆盖文档中的旧数字。

原始会话存档只作为本机追溯源，不进入 Git。它可能包含系统指令、临时测试配置和大量工具输出；直接提交既不可维护，也可能泄露不应公开的信息。本总账保留所有会影响产品范围和交付判断的用户决策。

## 2. 冻结目标

在不扩大范围的前提下，一次性关闭工业数字孪生平台的核心产品闭环：

- 优先完善 2D、3D、脚本编辑器和拓扑编辑器。
- 补齐高价值、轻量的工业场景，不做无意义功能堆砌。
- 补齐多脚本、离线依赖、脚本专用 Git、商业化素材/模板、发布和客户端流程。
- 统一执行功能、UI、交互、性能、稳定性和发布门禁，并自行修复发现的问题。
- 所有源文件不超过 800 行；新增业务文件优先控制在 300 行，复杂页面尽量不超过 400 行。
- 代码必须可读、可维护、命名和结构规范，并在业务约束和非直观边界处添加必要中文注释。
- 页面以“绝对易用、流程清晰、功能强大稳定”为首要目标；工作区优先，低频面板渐进展开。

产品定位不是 BIM 编辑器。BIM/CAD 只作为工程资产语义和格式输入的一部分，主线是 Web 原生工业数字孪生、2D/3D 应用交付、数据接入、仿真验证、虚拟调试与 AI 辅助。

## 3. 不得丢失的产品决策

### 3.1 产品与信息架构

- 2D、3D、脚本、拓扑共享项目与场景上下文，切换后不能丢选择、草稿或返回路径。
- 目录树保持简单；对象、灯光、模型和常用元素同层呈现，批量组织按需展开。
- 开发流程只保留文字入口，默认完全收起，不常驻状态行或进度条。
- 左右面板均可收起，收起后画布必须真实扩展；避免小字、重复标题、信息密度过高和 Demo 式说明卡。
- “浏览”和“预览”是同一个用户动作，统一称为浏览。
- 低频但有价值的能力不删除，放入二级工具、折叠区或插件层；不能与主任务争抢首屏空间。
- 产品源码、界面、安装包和公开资源不得出现竞品名称、标识或仿冒品牌；内部对标研究只保留必要事实引用。

### 3.2 2D、3D、脚本与拓扑

- 2D 组件库必须有商业化缩略图、分类、搜索、空状态、插入反馈和真实可编辑模板。
- 2D 拖拽与缩放要有可感知但不打扰的吸附：覆盖画布中心、参考线、其它元素的边缘与中心，并提供临时对齐线和可关闭的吸附设置。
- 3D 必须提供对象、灯光、相机、材质、标签、动画、测量、剖切、爆炸等高频能力，并可由图形化页面和脚本共同控制。
- 标签支持对象跟随、点击、关闭、碰撞避让、视口边缘处理和保存恢复。
- 动画统一支持自动播放、单次播放和循环播放；人物、车辆、AGV 等支持路线、速度、停靠、朝向、循环或往返。
- 脚本不是一个大文件；项目支持多个独立 JS 模块。
- 脚本允许使用受控原生 JavaScript、React/界面扩展能力和 Three.js 场景能力。
- 项目依赖支持固定版本 npm 包、本地上传 JS 和外部 JS 链接；安装后缓存到项目，离线可运行，并提供依赖、版本、引用和删除保护。
- Git 只管理脚本，不管理整个场景；支持状态、历史、提交、远端、拉取差异确认和非强制推送。
- 拓扑覆盖节点、连线、属性、运行状态、保存、刷新恢复和插入看板，不扩张成复杂独立工程套件。

### 3.3 AI 与高价值工业能力

- AI 模块插件化，通过稳定能力合同接入，不把页面直接绑死到模型供应商。
- AI 入口必须低学习成本：生成、解释、诊断和工业 Agent 统一呈现。
- 普通只读问答直接返回；写入类操作采用草案、差异预览、一次确认、应用、撤销和证据，不建设重型审批中心。
- MCP 建立在稳定领域命令、权限、版本和审计之上；不把全部 REST 接口机械包装成工具。
- 保留设备预测性维护与虚拟调试的高价值核心；不复制原项目的重型运行时。
- Plant Lite 保留离散事件、工位、队列、缓冲、输送、AGV、班次、故障维修、随机实验和置信区间。
- PS Lite 保留工位碰撞、机器人轨迹与关节约束、简单避障、多机器人时序、节拍、信号映射、故障矩阵、回放和证据；不自研完整品牌 OLP。
- PD Lite 只做轻量 PPR/BOP：工序、前置关系、资源、工时、版本、变更影响和方案对比，不新增一级导航。
- 机器人能力轻量化，但机械臂常用轴数、轨迹、工具、碰撞、节拍和负载等高价值配置必须可用。
- 数据源接入要支持采样时间、周期、触发规则、重试、检查点和运行状态；视觉、设备维护、仿真等能力通过接口、数据库、消息流和监控数据落地。
- 通知采用轻量通道模型，覆盖邮件、飞书、企业微信、钉钉和 API/Webhook；群机器人负责群推送，只有平台本身支持的企业应用能力才提供个人/部门定向。

### 3.4 素材、材质与视觉

- 数量是门槛但不是目标；模板和素材必须能进入真实工作流，不做空壳和盲目堆量。
- 2D 与 3D 在统一资源中心治理，但保留清晰类型筛选；用户都可导入自己的资源。
- 预置园区、车间和社区常用资产，包括围栏、人物、车辆、AGV、传送带、门禁、机械臂、电视大屏、货架、传感器和安全设施。
- 机械臂、传送带、人物和 AGV 的高频参数、动作和数据端口必须可配置。
- 环境资源覆盖天空、天气、背景、地面、HDRI、灯光、后处理、冲击波、扫描环、飞升线、飞线、管线流动和电子围栏。
- 材质编辑器使用专业 PBR 工作流，提供预览、纹理、环境和性能反馈。
- 外部来源资产只有在来源、许可、结构、缩略图和质量门禁满足发布要求后才能进入公共包；本地下载数量不能冒充商业质量。
- 性能优化不得让用户感知模型质量下降。自动策略优先调整内部分辨率、阴影更新频率和后处理成本，不改写用户模型几何、材质或纹理。

### 3.5 发布、部署与存储

- 发布提供 WebGL、WebGPU 优先、云渲染和 Windows 只读场景客户端四条路径。
- WebGPU 不可用或初始化失败时自动回退 WebGL。
- 发布时可选择是否显示工具栏；工具栏承载浏览、复位、视图、测量、剖切、爆炸、标签、全屏和截图等浏览能力。
- 完整编辑客户端不填服务 IP 时可进入本地工作台；需要协作和在线发布时填写服务器 Origin。
- 只读场景客户端只浏览指定发布场景，不包含项目管理、编辑、保存、脚本、AI 或数据配置；场景资源随包固化，不完全依赖网络。
- 支持导入/导出项目包，并可把整个场景导出为 GLB。
- 生产环境使用 PostgreSQL 和 MinIO；本地工作台使用 IndexedDB 和本地资源，不依赖 PostgreSQL、MinIO 或 Python。
- 项目全局不使用 Docker；本地开发、客户端联调、服务端与生产部署统一使用跨平台 Node 入口 `pnpm studio`。平台专用脚本只允许作为入口内部适配器，不再作为公开用法。
- 弱网和断网必须可控：有限重试、指数退避、取消清理、离线状态、恢复提示和冲突保护，不静默覆盖。

## 4. 明确排除或后来取消

以下项目不是当前待办，不得在恢复任务后重新加入本轮：

- WebGPU 8 小时长稳测试；保留短时资源、画质、设备丢失和恢复门禁。
- BIM 语义增强；已有能力保持不退化，但不继续扩张。
- JT、X_T/X_B、RVT、OpenUSD 等工业格式的实际转换验收；已有 reader、探测、官方加载器或转换路由保持不退化。
- PINO、PINN、TwinMoE 的生产证据和正式上线。
- 电池模型正式上线。
- 多节点并发和集群调度。
- Docker。
- 50 ms 调度和现场协议 Rust sidecar。
- 干净 Windows 虚拟机安装、升级、卸载生命周期测试。
- Fathom 集成和通用本体平台；只保留简化语义映射与问数能力。
- Babylon 双引擎；继续使用 Three.js，WebGPU 作为重要但可回退的后端。
- UE5 接入；Unity 仍保留为高价值外部资源与运行时桥接。
- 移动端、完整 PLM、完整 OLP、认证级人体工效和厂商控制器矩阵。
- 低价值格式和无法提供可靠证据的格式适配。

## 5. 上一轮全部有效工作流

过去 12 小时主线程本身只有 3 条用户消息和 7 条助手状态消息；主要开发发生在以下 10 个并行工作流中。其最终结果已合入 `946e7a9`，不是仅存在于聊天摘要中。

| 工作流 | 状态 | 关键结果 |
|---|---|---|
| 文档中心与离线依赖 | 已完成 | 15 篇离线指南；三栏搜索/目录/页内导航；npm 固定版本、本地 JS、外链缓存、引用保护和离线状态；聚焦测试 17/17 |
| UI 深度验收 | 已完成 | 修复流程默认态、拓扑画布、3D 侧栏、脚本依赖焦点与字号；四个编辑器面板可收起；在线页面和响应式审计无错误 |
| AI 脚本集成 | 已完成 | 统一生成/解释/诊断/工业 Agent；`studio.ai.invoke`；对象上下文；Worker 能力隔离与降级；相关测试 79 项通过 |
| 脚本 Git 后端 | 已完成 | 只允许脚本清单与脚本文件；状态、历史、提交、远端、拉取、推送；快进和越界保护；测试 6/6 |
| 脚本 Git 前端 | 已完成 | 拉取差异二次确认、失败恢复、草稿阻断、本地降级、焦点和窄屏；聚焦测试 38 项通过 |
| 发布交付审计 | 已完成 | 修复只读场景构建覆盖普通 Web `dist` 的并发缺陷；隔离构建、路径安全、Web/云渲染/客户端测试通过 |
| Windows 安装包 | 已完成 | 重新生成 NSIS、MSI 和桌面主程序；包内资源与元数据验证通过；未做数字签名和已排除的干净虚拟机测试 |
| 文档收口 | 已完成 | 行为脚本、发布、桌面、主计划、最终闭环和发布证据文档更新 |
| 品牌风险修复 | 已完成 | 用户可见品牌统一为 Deep Monkey Studio；强化品牌门禁；重建 Unity 离线包并增加源码一致性门禁 |
| 最终提交审计 | 已完成 | 两次独立审计确认无 P0/P1/P2 阻断、无敏感文件或生成物、所有源文件不超过 800 行，可安全完整提交 |

## 6. 当前功能进度

| 领域 | 状态 | 已交付结果 |
|---|---|---|
| 2D 编辑器 | 已完成本轮 | 页面/组件/图层任务分组、商业化资源面板、超宽画布自动聚焦、可收起面板、数据/参数/联动/下钻和刷新恢复；参考线、画布与其它元素边缘/中心吸附、动态对齐线和 Alt 临时绕过吸附均已验证 |
| 3D 编辑器 | 已完成 | 单层场景对象、上下文检查器、灯光/相机/模型/标签/材质/动画/分析工具、脚本控制和工作区切换 |
| 脚本编辑器 | 已完成 | 多文件、Monaco、原生 JS/Three.js、受控 React 扩展、离线依赖、AI、调试、错误定位、保存恢复、脚本 Git |
| 拓扑编辑器 | 已完成 | 节点、连线、属性、状态、保存恢复、插入看板、响应式与面板收起 |
| AI | 已完成本轮 | 插件式 Provider/能力、AskData、脚本 AI、工业 Agent、确认/撤销/证据和失败降级 |
| 工业闭环 | 已完成本轮 | Plant Lite、PPR/BOP、轻量工位验证、物流方案、设备诊断、虚拟调试、统一 Study 与证据链 |
| 素材与模板 | 已完成本轮 | 156 个 2D 预设、120 个商业模板、78 个 3D 工业预制体、12 套 HDRI、16 套 PBR；外部资产按质量门禁隔离 |
| 数据与运维 | 已完成本轮 | 多类数据源、连接/预览/字段、数据管道、弱网重试、PostgreSQL/MinIO、生产检查、备份与沙箱恢复；Windows/Linux 统一 Node 启停、状态检查与部署入口已闭环 |
| 发布交付 | 已完成本轮 | WebGL、WebGPU 优先回退、云渲染、Windows 只读场景客户端；发布工具栏和离线资源边界 |
| Unity | 已完成本轮 | 版本化 WebGL Bridge、manifest、uGUI/对象/相机/灯光/属性/动作/事件双向控制及离线包一致性 |
| 文档与品牌 | 已完成 | 离线文档中心、开发/部署说明、去竞品品牌门禁、第三方依赖清单 |

## 7. 最终验证证据

功能基线提交 `946e7a9` 包含 720 个文件变更、50,584 行新增和 5,318 行删除。本轮统一入口、2D 吸附与 Deep Monkey Studio 品牌收口后，在最终工作树再次执行等价完整门禁，结果为成功：

- 21 个可检查工作区类型检查通过。
- 1,628 个源文件全部不超过 800 行，无豁免。
- 2,095 项测试全部通过：API 410、Web 1,104，其余根入口、包与桌面端 581。
- 全仓生产构建、API 导入 smoke 和包体预算通过。
- Unity 离线包与源码一致性 3/3 通过。
- 品牌隔离测试和正式产物扫描通过。
- 素材/材质闭环通过：目录治理、导入、3D 应用、保存和刷新恢复。
- 数据中心闭环通过：创建连接、连接测试、数据集预览、管道运行、接口发布和调用。
- 浏览器产品门禁通过：3 个 2D 视口、WebGL 3D 和 WebGPU 验证。
- 在线闭环通过：登录、项目、2D、模型上传、3D 加载、保存、刷新恢复、浏览、发布和公开读取。
- 统一入口真实完成 API 启动、检查、重启和停止；Web 与 Windows 客户端生命周期在同一入口下完成验证。受 Codex 沙箱限制，Windows 进程树关闭需在沙箱外执行，真实系统调用已通过。
- 启动/停止/重启具备跨进程锁、PID 身份与启动时间校验；生产状态识别、自定义端口、Windows Node 绝对路径和 Linux 进程组清理均已补齐。

最新 Windows 产物：

| 产物 | 大小 | SHA-256 | 签名 |
|---|---:|---|---|
| `Deep Monkey Studio_0.1.0_x64-setup.exe` | 16.59 MiB | `12FE389FC4B31D3FE98565BF5289CE47B90B5B4913F64295175E752C4AEEFA5F` | 未签名 |
| `Deep Monkey Studio_0.1.0_x64_zh-CN.msi` | 17.41 MiB | `EAAACA7089533F9FCB6B5DB4E147FE919534EEC36E303C1104D05A9A55F1AAA1` | 未签名 |
| `bim-studio-desktop.exe` | 23.19 MiB | `3EFEC919FB7778AE08AC1478CDBEDB23ACF6DBC969A482DF1802C66A33BB281A` | 未签名 |

浏览器门禁报告位于 `test-output/product-browser/report.json` 和 `test-output/online-flow/report.json`。这些目录由测试生成且不提交 Git。

## 8. 当前待办与诚实边界

### 8.1 本轮待办

2026-09-04 冻结的五项收口任务均已实现并通过门禁：跨平台唯一入口、原生生产部署、2D 商业吸附、完整发布验证、Deep Monkey Studio 品牌与安装包。当前没有遗留的本轮代码待办；提交与远端同步状态必须以 `git status`、`git log` 和 `git rev-list --left-right --count '@{u}...HEAD'` 的实际结果为准，不能只相信本文件。

### 8.2 项目级后验收

以下不是本轮代码缺陷，也不是当前提交阻断：

- 安装包尚未配置 Authenticode 证书，因此 Windows 会显示未签名发布者。
- WebView2 bootstrapper 首次安装可能需要网络。
- 真实客户模型、客户数据、目标 GPU、现场网络和长期运行稳定性需要在具体项目中验收。
- 固定工业夹具和当前机器的性能结果不能扩大为所有客户场景均达到桌面引擎性能。
- 外部缓存中的 1,551 个 GLB 没有全部进入仓库或安装包；只有满足来源与质量门禁的资源才能正式发布。

## 9. 统一启动与部署入口

首次安装依赖后，公开用法只保留 `pnpm studio`：

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start client
pnpm studio start web
pnpm studio start api
pnpm studio stop
pnpm studio restart
pnpm studio status
pnpm studio check
pnpm studio deploy --check
pnpm studio deploy
pnpm studio undeploy
```

`client` 仅支持 Windows；`web`、`api` 和生产部署支持 Windows/Linux。主机、端口、远程 API、存储模式、备份、升级、回滚和排障的从零说明见 `docs/native-deployment.md`。安装后的客户端选择“本地工作台”时，不依赖 PostgreSQL、MinIO、Node.js 或 Python。

## 10. 过去 12 小时对话恢复核验

核验窗口：2026-09-03 20:47 至 2026-09-04 09:15（Asia/Shanghai；覆盖最近 12 小时并保留交接前的连续上下文）。

已从本机主任务存档、提交、工作树和并行工作流结果恢复这一窗口内会影响交付的指令。恢复指的是把可执行决策、代码状态、证据和边界固化到本总账，不是把含系统内容与临时配置的原始日志提交进仓库。

这一窗口内的主要用户任务为：

1. 若平台提供 `gpt-6 astra`，希望切换并使用极高推理深度。当前可用模型列表没有该模型，运行中的任务不能自行热切换；不得虚报已切换。
2. 明确允许将完整提交推送到 `github.com/fatasia/bim-studio` 的 `dev-studio` 分支。
3. 要求恢复全部对话和过去 12 小时工作，提交 Git，并汇报上一轮全部进度与待办。
4. 要求说明项目如何启动和一键脚本如何使用。
5. 启动、关闭、重启必须同时覆盖 Web 与 Windows 客户端，并且不能存在多个让用户选择的入口。
6. 启动器要兼容 Linux 服务器；API 必须能单独启动，并可配置主机、端口和存储依赖。
7. 放弃公开 Windows PowerShell 启动脚本，以跨平台 Node 命令 `pnpm studio` 统一开发和生产操作。
8. 文档必须覆盖从零搭建开发环境、JSON/local 零基础设施模式、PostgreSQL/MinIO 生产模式、Windows 客户端、Linux 部署、升级、回滚、备份和排障。
9. 2D 编辑器补齐接近商业编辑器体验的参考线、其它元素和居中吸附。

同一窗口内的开发活动由第 5 节的 10 个工作流构成；其代码、测试、文档和审计结果全部可以从最终提交、当前文件和门禁报告复核。没有仅存在于口头承诺、却未进入代码或明确边界的本轮任务。

## 11. 下一次恢复检查清单

```powershell
git status --short --branch
git log -2 --oneline
git rev-list --left-right --count '@{u}...HEAD'
pnpm studio status
pnpm studio check
```

若功能代码在当前闭环提交之后发生变化，再按风险执行聚焦测试或 `pnpm verify:release`。只更新文档且 `git diff --check`、链接和范围核验通过时，不重复消耗完整浏览器门禁。

## 12. 2026-09-04 编辑器体验与登录稳定性收口

### 12.1 本轮不可回退的产品要求

- 页面、交互和代码必须按成熟商业平台质量交付，避免低级排版、空白状态、重复入口和无意义操作。
- 面板与页面中的说明性废话默认不常驻；必要帮助通过按钮标题、鼠标悬浮或上下文错误反馈提供。
- 已经反馈过的问题必须从根因修复并加回归验证，后续不得反复返工。
- 图片、视频和组件/页面背景必须支持用户直接上传本地文件。
- 整体主题可配置，并预置深色、浅色两套主题。
- Web 与 Windows 客户端都不能因公共接口 401、网络波动或短暂网关异常错误退出登录；“记住登录”在客户端重启后必须有效。

### 12.2 已完成实现

- 场景卡片收敛为高频操作加更多菜单，修正菜单与导出子菜单排版。
- 2D 工作区默认进入“页面与图层”；页面只在左侧管理，底部重复页面标签已删除；左右面板开关统一为与 3D 一致的画布边缘按钮。
- 2D 顶部工具栏去掉常驻快捷键长文和无效禁用按钮；快捷键集中到问号悬浮层；工具栏不再产生横向滚动条。
- 3D 默认背景、地面网格、坐标轴与灯光层次重新调整为深色工业视觉，避免灰白雾面底板。
- 本地恢复只在草稿与服务器版本存在真实内容差异时提示，忽略仅时间戳变化；恢复弹窗删除英文眉题和三块无意义统计卡，按钮允许紧凑换行。
- 3D 属性检查器与数据绑定重新整理字号、间距和对齐，删除常驻说明段落，将必要解释转为悬浮提示。
- 资源组件按“图表 / 控件 / 媒体 / 3D / 资源”五类组织；删除联动诊断、模板引导和点击说明等常驻提示；组件说明保留在悬浮标题中。
- 媒体分类提供“上传图片 / 上传视频”，选中图片或视频组件后也可直接上传替换；页面背景和组件背景继续共用项目资源上传链路。
- 行业模板库恢复 120 个真实模板，修复网格自动行高度塌陷；卡片固定 286px 高，并精简弹窗标题区。
- 脚本编辑器合并布局入口和次要工具，保留明确的保存按钮与自动保存开关；2D/3D 均调用同一工作区保存逻辑；分屏拖动期间禁用过渡，并由 React 状态承接最终宽度，消除闪屏和回弹。
- 发布浏览工具栏改为底部居中的紧凑横向工具条，更多功能渐进展开，不再形成高大的空白竖栏。
- 品牌设置新增深色/浅色预设，文档根节点统一应用主题，品牌预览同步展示当前主题。
- Web 鉴权改为二次复核：业务请求携带令牌并返回 401 时，不直接清空登录态；只有 `/api/auth/me` 使用同一令牌再次明确返回 401 才退出。无令牌公共请求、网络失败和 5xx 不触发退出；页面启动恢复会话遇到断网或 5xx 时保持凭据并自动重试，不再错误跳回登录页。
- Windows 客户端的“记住登录”由纯内存升级为 Windows DPAPI 当前用户加密存储；启动连接门禁会恢复令牌，退出登录和鉴权失效会同步删除加密文件。

### 12.3 验证证据

- Web 全量测试：313 个测试文件、1,105 项测试全部通过。
- 本轮 UI 聚焦测试：6 个文件、21 项测试通过；服务端 SDK：4 个文件、54 项测试通过；桌面/浏览器鉴权适配：2 个文件、9 项测试通过。
- Web、API、contracts、server-sdk 类型检查通过。
- Windows 桌面 Rust 测试 5/5 通过，其中包含 DPAPI 密文不含明文令牌、可恢复、可清除的验证。
- 源文件质量门禁：1,628 个源文件全部不超过 800 行，无豁免；`git diff --check` 通过。
- 真实浏览器验收：2D 默认“页面与图层”；重复页面栏数量为 0；工具栏 `clientWidth` 与 `scrollWidth` 均为 744，`overflow-x: visible`；无常驻快捷键长文和“联动诊断”。
- 真实浏览器验收：资源五分类均为单行，媒体分类显示两个本地上传入口；行业模板为 120 个真实卡片，首卡尺寸 276×286px，无骨架空白。
- WebGL 真实浏览器验收：1280×720 场景完整渲染 120 个对象，页面无横向溢出，深色地面与弱化网格已生效。

本节是后续继续修改编辑器时的恢复基线；不得重新引入重复页面入口、常驻说明墙、空模板骨架、仅内存的桌面“记住登录”或收到一次业务 401 就清空 Web 登录态的旧逻辑。

Zcode GLM5.3 的完整接手顺序、现有工作树边界、文件索引和验证命令已固化在 `docs/zcode-glm53-handoff-2026-09-04.md`；换模型后应先读该文档，不得从最后提交重新实现本轮改动。

## 13. 2026-09-04 夜间极致优化轮（进行中）

用户 2026-09-04 新目标：**页面、性能、交互体验优化到极致，全面对标 ThingJS/山海鲸/帆软，部分对标 Unity、西门子 PS/PD/Plant**。用户同时明确：任务持续执行不停止；用户消息不改变方向。上一轮冻结范围（第 2-11 节）已全部闭环，本轮是新的体验优化轮，仍受总计划 §28.1 范围冻结约束（只修复、补齐、验证、轻量重构，不新增功能域）。

- 执行方案：`docs/nightly-extreme-optimization-plan-2026-09-04.md`（测试面清单、对标差距→夜间检查映射、阶段 A-E 计划、GLM-5.3-Flash 决策规则与升级路径）。
- 接手基线：`821ca74 fix: polish editors and stabilize sessions`（第 3 节改动已全部提交并推送，工作树干净；交接文档 §6/§7 已同步更新）。白天已在 `821ca74` 复核交接检查全部通过：typecheck、聚焦 UI 测试 30 项、server-sdk 54 项、Rust 测试、1,628 文件行数门禁。
- 夜间执行记录、问题清单与升级清单在执行完成后回填本节；升级清单供 GLM-5.3/GPT-5.6 白天处理（18 个 >500 行组件拆分、浅色主题全量令牌化、hooks 补测试、虚拟化等性能项）。

## 14. 2026-09-04 "全面超越"新开发展轮（已立项）

用户同日决策（原话见 `docs/platform-surpass-development-plan-2026-09-04.md` 第 1 节）：数据语义层与填报/打印、素材与模板深度、ThingJS 式 SDK 生态、Unity 级性能、差异化闭环（Web 原生协作/秒级预览/数据+AI+看板一体/Study 证据链）、AI 升级，七项纳入计划。载体优先级：最高为 2D/3D/脚本编辑器与数据中心，其次为 AI 与西门子 Lite 仿真。

- 执行计划：`docs/platform-surpass-development-plan-2026-09-04.md`（批次 S1-S7、验收标准、依赖排序）。
- 执行模型：白天 GLM-5.3/GPT-5.6 出实现规格（`docs/specs/`），夜间 GLM-5.3-Flash 免费时段照规格实现；规格外问题按夜间方案 §7 三档规则。
- 该轮取代 §28.1"不再新增功能域"约束；§28 排除清单（Docker/Babylon/UE5/移动端/完整 OLP 与 PLM/认证人体工效/厂商控制器矩阵/8 小时 soak 等）继续有效，AGENTS.md 范围段已同步。
- 与第 13 节夜间优化轮并行：优化轮打磨既有体验，本轮新增能力；共用门禁，互不阻塞。
- S1 分解为夜间规格序列：S1-001 语义模型合同/持久化/CRUD（已写规格 `docs/specs/S1-001-semantic-model-contract.md`，基于 2026-09-04 数据域摸底：复用数据产品抽象/公式引擎/MetadataStore 模式/409 引用保护；缺口为语义实体、集中口径、维度层级、参数化与缓存）→ S1-002 模型编辑器 UI → S1-003 2D 按指标/维度绑定 → S1-004 同模型组件自动联动 → S1-005 维度层级钻取 → S1-006 参数级联服务端取数 → S1-007 AskData 语义认知。每完成一个规格回填其 §8 并更新本节。
- 夜间定时任务已更新为双轨：规格实现优先（编号最小待实现规格），余时跑第 13 节优化轮；规格外发现只记录不展开。
- **S1-001 已于 2026-09-04 白天由 GLM-5.3 直接实现并通过门禁**（用户指示"现在就开始做"）：合同 `packages/contracts/src/semantic.ts`、校验/字段解析 `apps/api/src/semanticModelService.ts`、CRUD `apps/api/src/semanticModelRoutes.ts`、持久化沿 ProjectRecord+MetadataStore 模式、数据集/管道删除 409 保护。api 全量 428 项（+18 新增）、contracts 166 项、api/contracts/web typecheck、1,634 文件行数门禁全部通过。规格 §8 已回填。下一个规格：EX-001（2D 画布交互，现状盘点已完成）。
- Git 纪律（2026-09-04 用户指令）：**没有用户明确允许，只允许本地 commit，严禁 push 到远端**。夜间定时任务与白天会话同守此规。
- 2026-09-04 用户追加两项：①"现在就开始做"——S1-001 已当天完成（见上）；②素材/模型/组件补量提质到行业主流、可网上下载——已产出 `docs/asset-sourcing-plan-2026-09-04.md`（数量目标：3D 3000+/HDRI 40+/PBR 60+/2D 组件 300+/模板 300+；许可红线：仅 CC0 与 CC-BY 带署名，禁 NC/SA/EULA/付费抓取；来源：Poly Haven/ambientCG/Quaternius/Kenney/Poly Pizza/Sketchfab-CC0；管线复用既有审计发布门禁，夜间无规格余时跑下载批次）。后续规格：EX-001A（已写，画布选择与操作模型）→ S3-A1 适配器骨架+Poly Haven HDRI → EX-001B/EX-002 按 `docs/editor-interaction-benchmark-2026-09-04.md` 顺序。
- **S3-A1 首轮扩容当天完成**：Poly Haven 精选清单 12→55 HDRI（运营态工厂/机房/仓储/维修/基础设施/夜景/阴天，剔废墟风）+ 16→72 PBR 材质；下载 477 文件 1.55GiB，catalog 127 资产全部 published；Kenney 开放包 14→16（+furniture/space-station，CC0）；审计单测 10/10。**HDRI 与材质数量目标已超额达成**（55/40、72/60）。剩余缺口：3D GLB 3000+（source-b 通道待建）、2D 组件 300+（S3-B 规格待写）、模板 300+（S3-C 规格待写）。
- 规格队列（按编号夜间执行）：EX-001A（画布选择操作）→ EX-001B（批量编辑图层）→ EX-002（字段拖拽绑定+数据面板）→ S1-002（语义模型编辑器）。后续待写：S3-B（2D 组件目录扩容）、S3-C（行业模板扩容）、S3-A4/A5（Poly Pizza/Sketchfab 3D 模型通道）。
- 夜间定时任务已升级为"超越轮"：23:00-09:00 整夜多轮循环（规格实现→聚焦门禁→对标检查矩阵→修复→下一轮），08:30 收尾回归+总账+**本地提交（严禁 push）**。

## 15. 2026-09-04 用户反馈批次一（UF-001，修复中）

用户实测反馈 9 项（原话见 `docs/specs/UF-001-user-feedback-batch-1.md`，含两张截图证据：发布页排版错乱、场景卡片页）：

1. 仿真功能并入 3D 编辑器插件面板 [设→已完成设计：`docs/specs/SIM-001-simulation-in-editor-design.md`，参照西门子 PS 单工作台模型：仿真实体入左侧树（路径/碰撞对/队列/信号映射随场景保存）、上下文检查器、工具坞"仿真与开发"组挂载、时间线统一播放、结果覆盖层、Study 链路不变、/operations 转型为证据工作台；分四期 SIM-1a~1d]
2. 动画时间线帧图标过大 [修]
3. 多页面"更多"点击无效 [查]
4. 模型优化页能力回退，定位=导入/转换/压缩/优化一体，需恢复 [查→恢复]
5. 资源页卡片"导入"按钮无意义应为浏览；2D 资源/工业预制体/模板缩略图不对 [缩略图=修，交互=设→RES-001]
6. （并入 5）
7. 模型优化与资源页逻辑整合 [设→并入 RES-001]
8. 数据中心：运行监控位置不对 [修]；管道/接口两页不完善复杂 [设→并入 EX-007]；高级接入白屏 [查]
9. 3D 编辑器缩小滚动反复跳 [查]；发布页排版完全错误+介绍文字改悬浮 [修]；云渲染一键开启+全局默认 [设→CLOUD-001]；场景卡片缩略图默认截取最后保存画面 [修]；docs 太简单 [设→并入 S3-C]；场景卡"更多"项放回主卡图标展示 [修，覆盖 821ca74 精简决策，以本次反馈为准]

夜间执行顺序：UF-001 [修] 项最优先（U1-2→U1-3→U1-9b→U1-9d→U1-9f→U1-8a→U1-8c→U1-4→U1-9a），[设] 项白天出规格：SIM-001、RES-001（含 U1-5/6/7）、CLOUD-001、EX-007 补充、S3-C 文档线。每个 [修] 项必须根因修复+聚焦测试+浏览器截图，禁止表面修补。

### 15.1 AI 批次立项（2026-09-04 用户指令）

用户指令：AI 模块能力提升与交互流程提升纳入任务；预测维护对标先导智能，其余对标市面主流平台。已产出 `docs/specs/AI-UP-ai-capability-interaction-plan.md`：AI-1 统一 AI 工作台（全站侧边栏/流式+步骤可见/澄清选项/上下文芯片/能力路由/会话）→ AI-2 预测维护对标先导（健康评分/趋势 RUL/维护建议→工单→通知→复检对比闭环/OEE 三率与停机归因，全部带证据指纹入 Study）→ AI-3 看板生成资产化（落盘可迭代）→ AI-4 脚本会话化+3D 场景生成 → AI-5 评测集门禁。能力基线全量保留（不因交互轻量而削减），交互对标 FineChatBI/Copilot 类主流规律。排序：AI-1 规格先出，实现排在 S1-002 之后、AI-2 紧随（用户点名重头）。

### 15.2 UF-001 执行进度

- U1-2 ✅ 时间线关键帧图标 7px+命中区（30005ab）
- U1-9b ✅ 发布弹窗紧凑重排+描述转悬浮（1dd82f6，双主题截图待夜间补）
- U1-9f ✅ 场景卡片恢复复制/重命名/版本历史图标直达（210606c）
- SIM-001 设计定稿（8d875a4，交互=Visual Components 快速通道，能力=全量同级）
- 定时任务已调至每日 21:00 启动、08:30 收尾、严禁 push
- 待夜间：U1-3（更多点击无效）、U1-9a（编辑器缩放滚动跳）、U1-9d（场景缩略图截取）、U1-8a/c（数据中心监控位置/Node-RED 白屏）；**U1-4 已由 Codex 会话完成**（见 15.3/交接文件，勿重做）；待白天规格：RES-001、CLOUD-001、AI-1 规格
- 2026-09-04 晚间整合（Codex 交接入库）：① 交接文件 `docs/codex-glm53-handoff-2026-09-04.md` 纳入夜间必读，SIM-0 完成、下一直接任务 **SIM-1a**（交接 §6：场景域合同+持久化测试→场景树实体→引擎无关覆盖层；仿真瞬态不混入 SceneSnapshot）；② SemaPLC 价值判断已有结论（虚拟调试闭环补强 SIM-1c 与 Study 证据链，未来 PLC validation adapter；MIT 核心含 GPL/LGPL 组件，只借鉴架构不复制二进制）——夜间**不重做**该评估；③ astral-service（RVT→glTF/DWG→DXF 转换器实现，克隆在 `D:\Temp\astral-service-analysis`）分析因日间用量上限中断，转夜间低优先续做：只提炼可借鉴点（转换状态机/属性注入约定/Worker 渲染），不改产品代码；④ 夜间任务允许直接联网下载（素材同步、开源仓库克隆、文档抓取），遵守许可红线。
- 2026-09-04 用户追加：2D/3D/脚本编辑器、素材模板、数据中台的**交互逻辑**不达标，学习 ThingJS/山海鲸/帆软。已产出交互对标研究与采用设计（`docs/editor-interaction-benchmark-2026-09-04.md`，基于三家官方文档抓取：FVS 组件操作/事件-动作模型、FineBI 默认联动/依赖字段/条件语义、山海鲸拖拽槽位绑定/两级数据模型/回收站），拆为 EX-001~EX-007 批次并插队：S1-001 之后先 EX-001/002/003，S1-002/003 按 EX 新交互实现。规格按此顺序由白天模型编写。

### 15.3 用户截图反馈批次二（UI-002，已完成）

- 仿真插件面板改为紧凑的可移动、可缩放工具窗，布局始终约束在 3D 工作区并本地记忆；采用 Siemens Process Simulate“中心视口 + 可重排工具窗”的工作台原则，不照搬其传统 Ribbon 外观。
- 发布弹窗仅常驻 `WebGL / WebGPU / 云渲染`、`高画质 / 极速模式`、`显示 / 隐藏` 三组核心决策；其余兼容性、回退与诊断说明按悬浮显示，“发布不会覆盖草稿”保持单行。
- 场景卡片导出项改为在窄“更多”菜单内展开，修复按钮通用样式覆盖造成的中文竖排和二级浮窗越界。
- 聚焦测试 4/4、Web 全量测试 1,111/1,111、全仓类型检查、1,645 个源文件尺寸门禁、Web 生产构建和真实浏览器视觉检查均通过；完整证据与接手说明见 `docs/codex-glm53-handoff-2026-09-04.md`。

### 15.4 2026-09-05 用户反馈批次三（UF-002，执行中）

已修：顶栏重复面包屑+场景对象间距（24fe51f）；2D 框选恢复=空白拖拽相交命中+Shift/Ctrl 加选+导入面板说明墙删除（3099c02，功能经事件追踪证实 4/4，但 u112b 脚本偶发假阴性待查）。
**待办队列（按序，9 点后继续不停）**：① 2D 编辑器布局回退：页面 tab 放回底部、图层在左侧（用户明确否定 821ca74 的"页面与图层"合并决策，以本次为准）；② <30% 缩放抖动复现与修复；③ 页面与图层支持右键菜单+双击内联重命名（弃弹窗，对标 FVS/Figma）；④ U1-8a 数据中心监控位置；⑤ U1-8c Node-RED 白屏；⑥ SIM-1a（交接 §6）；⑦ EX-001A 剩余（Alt 拖拽复制、右键选层）；⑧ astral-service 分析（克隆在 D:\Temp\astral-service-analysis）。纪律：严禁 push；admin/admin 与存储拓扑禁改；大改先请示；每修必带聚焦测试+浏览器证据+整页目视。

- 素材 3D 通道阻塞：Poly Pizza/Sketchfab API key 需用户本人注册（邮箱验证+条款），已告知用户；用户给 key 后夜间跑批量下载。期间转 Quaternius/Kenney 无 key 直链通道（全部 CC0）：下一批先抓 quaternius.com 工业相关包直链并入 `scripts/sync-open-asset-packs.mjs`。

- 素材 3D 通道就绪（2026-09-05）：用户已提供 Poly Pizza/Sketchfab key，存于 `data/external-assets/source-b/api-keys.env`（gitignored，值不入日志）。实测：Sketchfab API 200 可用（token 认证通过，search+downloadable 可用）；Poly Pizza 本地网络不通（HTTP 000，与 quaternius.com 同为网络层超时，备用）。下一批任务：新建 `scripts/sync-sketchfab-models.mjs`——按行业关键词（pump/valve/conveyor/industrial/warehouse/forklift/AGV/robot 等）search downloadable=true，许可过滤 CC0/CC-BY（BY 记 attribution），经 download 端点取 GLB+缩略图入 source-b，写 catalog 后跑既有审计门禁；每轮限额（如 200 模型/晚）。

- **Sketchfab 通道首批完成（2026-09-05）**：`scripts/sync-sketchfab-models.mjs`（已提交）实测通过——license 字段为 {uid,label}，过滤规则=允许 CC0 与 "CC Attribution"（CC-BY，记 attribution），NC/SA 拒绝；首批 5 轮下载 31 个工业模型（pump/valve/conveyor/electrical/warehouse 等，169MiB，GLB 文件头校验有效，catalog `data/external-assets/source-b/catalog.json` 全部 review-required 待审计）。注意：约 1/6 结果无 .glb（仅 glTF zip）被跳过，后续可加 zip 解包。持续推进方式：每夜无规格余时跑 `node scripts/sync-sketchfab-models.mjs --per-keyword=8 --keywords=<轮换关键词>`（幂等，catalog 去重），旋转关键词直至 3000+。

- U1-8a 排查记录：监控面板 `data-connector-health-panel` 渲染在全部连接卡之后（DataCenter.tsx:395，列表 343）导致选中与监控脱节。修复方向=面板上移至 `data-card-list` 之前；脚本移动未命中标记，下一会话手工编辑完成（约 30 行块整体迁移），随后浏览器截图验证。

- U1-10 补充（<30% 抖动）：画布滚动条常驻 `overflow:scroll`（滚动条明灭根除，实测普通滚轮 0 反转）；Ctrl+滚轮缩放路径的 <30% 专项复现待下一窗口（Playwright wheel 无修饰键参数，需 keyboard.down 组合）。

- 素材进度：Sketchfab 第 5 批 +57（阀门/法兰/风机/电梯机房/托辊等），catalog **138 个模型**（约 1/3 无 .glb 被跳过，后续加 zip 解包可再提升产出）。下载通道稳定，夜间自动轮换关键词。

- **U1-10 <30% 抖动终验通过**：Ctrl+滚轮缩至下限全程 14 秒逐帧采样，scrollLeft 0 次方向反转（单次单调写入 0→30），滚动完全稳定。修复组合=自动 fit 防抖+等值零写入+滚动条常驻。U1-10 整体关闭。

- 素材下载限速判断（2026-09-05）：大批量运行时 Sketchfab 服务端限流/每日下载配额可能触顶（60s 无新增 GLB，脚本含 429 退避会自动等待恢复）。脚本幂等可重入，配额恢复后每次运行自动续传——夜间循环持续补量即可，无需人工干预。当前落地：主库 164 GLB + 三路并行批次产出入库后合并（uid 去重）。stdout 管道缓冲导致后台运行时中间日志不可见属正常，结果以 catalog.json 为准。

- 2026-09-05 用户指令：下载暂停（catalog 164 个保持），集中做剩余 5 项+全量测试。队列：① SIM-1a 场景树仿真域渲染+检查器挂载 ② 覆盖层 ③ U1-8a 双主题截图补档 ④ EX-001A Alt 拖拽复制+右键选层 ⑤ S3-B/S3-C 规格；全量测试=Web 全量+全部路由巡检（u117 脚本已备）。

- EX-001A Alt拖拽复制实现方案（下一窗口照做）：① `pasteCopiedNodes`（controller:217）改为返回新建节点 id 数组；② `DashboardCanvasNode.tsx` 移动手柄（314 行 onPointerDown→onTransformStart(event,"move")）前置判断：event.altKey 时先调 copy+paste（偏移 0），用返回的首个新 id 构造合成 pointer 事件参数继续 onTransformStart；③ 拖动事务与手柄解耦（beginNodeTransform 接受 nodeId 参数而非从 DOM 读），避免粘贴后 React 重渲染打断手势；④ 回归：DashboardWorkspace.test.tsx 加 Alt+拖拽副本断言。已确认 Ctrl+D 复制已存在（508-513），Alt 拖拽是补充交互。

### 15.5 2026-09-05 Codex 接手复核与持续优化

本节覆盖 §15.4 中已经过时的待建描述：GLM 的 `b1b2222` 交接及此前提交为基线，必须先查当前代码，不能重新实现已提交的 Alt 拖拽/右键选层、语义合同或 SIM 场景树。

- 用户更新：Codex 在本任务范围内直接改，不需逐项请示；仅本地提交、严禁 push，admin/admin、PostgreSQL+MinIO 拓扑及原数据不动。用户飞行期间继续执行，并增量复核 GLM 测试输出。
- **已完成**：SIM 仿真实体 controller 直连、快照保存/并发返回合并/导入引用迁移、检查器编辑删除、静态路径与 flowLink 覆盖层及关闭清理。专用 QA 场景保存→刷新恢复已实测；不代表完整 SIM-1a 运行闭环完成。
- **已完成**：2D 页面仅底部、图层左侧；框选使用实际 artboard 坐标；Ctrl+滚轮 passive:false；确定性浏览器门禁四组合通过，10%→11% 60 帧无漂移。
- **已完成**：UI 报告确认项的加载反馈、菜单/AI Esc、搜索上下文、登录 502 指引、窄屏导航、连接名称/监控、局部主题与优化器禁用态、datetime/ANSI 清理；旧发布快照兼容读取与保留、版本错误/重试。未复现与已修项分开记录，未覆盖 GLM 原报告。
- **已完成**：SemaPLC/Astral3D/astral-service 分析与 S3-B/S3-C 规格。Astral Revit 配置处于注释状态，不能宣称已获得可用 RVT 解析器；300+ 数量是待实现目标。
- **本轮待办**：以 `docs/ui-report-recheck-2026-09-05.md` 的 33 项复核表和 `docs/codex-glm53-handoff-2026-09-05.md` §4 为直接队列。优先 Agent 数据集缺失/AI 取消生命周期、四仿真面板深测、SIM 源汇/队列到运行/覆盖层/Study/统一时间线、拓扑交互、素材深度与大文件职责拆分。
- **明确排除**：继承 §28；外部素材下载暂停 164 GLB，不因定时续跑恢复下载；不做工业格式真实转换/Revit/Docker/完整 OLP/认证动力学或 8 小时 WebGPU soak。
- **项目级后验收**：任意客户格式/规模/仿真正确性矩阵及开发完成后的统一全站、性能、稳定性、故障注入与发布回滚。不把固定夹具测试扩成“全面超过行业平台”。
- 验证：2026-09-05 10:47 全仓 typecheck、`pnpm -r test` 通过（Web 320 文件/1127 测试，API 110 文件/434 测试）；源文件 1704 个均 ≤800；10:55 Web 全量再次 1127/1127。新增门禁、最新构建及截图结论继续回填交接 §7。
- 产物：`test-output/codex-2026-09-05/`；权威交接 `docs/codex-glm53-handoff-2026-09-05.md`，分析 `docs/semaplc-astral-value-analysis-2026-09-05.md`。GLM 原报告截至 10:01:16 共 33 条（其中重复与未复现项已标出）。本任务 heartbeat 每 30 分钟检查新增项，飞行检查窗口到 15:00；无新项时继续上述队列。
- 收口增补：四仿真面板 32 组基础布局/折叠检查通过；根启动/CLI 测试 16/16；Web 及依赖生产构建通过，首屏 JS 304.8 KiB / gzip 99.0 KiB，11 chunk。单独 Web 构建的首次缺失导出来自旧 contracts dist，依赖顺序构建后通过；既有外部化/大 chunk 构建提示未抹掉，详见交接 §7。
- **已完成（12:00 接续）**：Agent 服务端项目数据目录发现（P2-11 根因）、上下文有界/隔离与工具描述；普通 AI 的 BIM 准备、SQL 两阶段、流式读取取消及后续草稿保护；服务器响应断开传播到提供方，不再只取消界面。Web 1136/API 448 测试、真实 HTTP 取消与双主题双宽度 AI 浏览器门禁通过；完整记录与真实 504 证据见交接 §8。
- **本轮待办（更新）**：Agent 多候选选择卡片/续答、可重试决策失败的受控恢复、跨项目异步返回；原问题实测已校验查询计划，但后续上游模型 HTTP 504，不能标记在线风险诊断已完成。仿真、拓扑、素材等其余队列不变。
- 增量协作：已读 GLM `0d49388` 素材统计补记，无新增 UI 报告项，不恢复暂停下载。仅本地提交、固定账户/存储/原场景不变。
- 12:04 门禁：Web/API 生产构建通过，首屏 JS 304.8 KiB / gzip 99.0 KiB 未回退；1715 源文件尺寸与 diff 检查通过。旧构建 externalization/大 chunk 提示不因本轮通过而视为已消除。
- **用户最新要求（12:51）**：GLM 全部测试完成，Codex 整体修复并整体重新检查；当前最终报告仍 33 条，继续以逐项复核表区分真缺陷/误报/已修，不重新建设已有修复。
- **已完成（12:55 接续）**：拓扑 P3-2/P3-3：投影边界 fit/中心缩放/空态首节点、手动视角保留、无保存副作用；运行态待数据/未知/离线分离与 unknown 适配修正、局部亮色令牌。四组真实浏览器原项目只读和内存拖拽/撤销/负投影/切文档通过，证据及完整限制见交接 §9。下一任务为报告剩余项和全站整体重测，不是项目已结束。
- **已完成（13:38 接续）**：最终 UI 报告 32/33 条已修或复核，剩 P2-5 生产冷加载。新增四组浏览器门禁覆盖长名称/复制权限拒绝与恢复/真实拓扑预览/主 CTA/健康键盘诊断/真实日志/能耗布局/480 AI 芯片/404 提示。额外修复运营页挂载误同步维护模型、设置和 Study 亮色、运营导航旧预留与 CSV 裁切。首次误同步已如实记录于交接 §10，未声称零维护记录影响；后续门禁主动拦截非预期写请求。
- 本机全服务复核：MediaMTX 已按原配置恢复；Node-RED 锁定依赖缺文件已按官方包 integrity 核验补齐，仍需实际节点/iframe/桥链路验证。没有改 admin/admin、存储拓扑、旧场景或恢复模型下载。13:38 全仓测试/最终构建复跑中；交接 §10 为恢复入口。
- 13:40：全仓测试通过（Web 1148/API 448/contracts 170 等）、最终 Web 生产构建通过，首屏预算不变。Node-RED Started flows 后发现 TDengine finalize 裸 await 语法错误、OPC UA 的 @peculiar/utils 依赖声明缺失；当前优先修正这两个额外真问题，再做 iframe/桥链路与 P2-5，不能只看监听端口。
- **已完成（14:15 接续）**：33 条报告范围全部修复或复核关闭。P2-5 增补预览/发布场景读取进度、错误与重试、零外部模型 ready；生产双主题小场景禁缓存 ready 393–954ms，接口延迟/503/重试与 HTML 先于 JS 的状态均通过。不是大模型/全项目验收，精确条件见交接 §11。
- Node-RED 全服务真实检查已通过四组合：修 TDengine finalize 编译/清理，恢复锁定包缺文件，健康接口走统一鉴权（原 401 被误判 offline），状态/复制失败反馈与主题。未部署流程/触发真实工业数据库。MediaMTX、Web/API/Postgres/MinIO 拓扑未改；尚未声称所有设备消息端到端验证。
- 14:14 全仓测试通过（Web 1155、API 448 等）、Web 构建/类型通过，首屏 304.7 KiB / gzip 98.9 KiB。WebGL 发布免除无用 WebGPU 探测；首次 ANGLE X4122 上游精度警告保留证据，不宣称所有浏览器警告归零。当前主线接续按交接 §4，仿真运行与 Agent 恢复仍为本轮待办。
- **已完成（后续修复批次）**：SIM 旧闭包 revision/history 防护、跨 tab/折叠状态保留；Agent 跨项目/取消后迟到响应与重复操作；API audit 关闭写入竞态；环境面板隐式网格列/竖排名称/标题压缩、980 工具菜单无可访问名称、Agent 亮色样式。详细限制与截图见交接 §12；504 恢复、停靠与 SIM-1a 完整运行仍待办。
- 验证更新：全仓测试通过（Web 1156/API 449 等），最新 Web 全量 1156、根 typecheck、生产构建及 artifact 门禁通过；四面板 32 组和 UI/Agent/环境/状态保留等双主题双宽度真实门禁通过。1739 源文件无 >800，60 文件 >500；不再沿用旧 18 文件扫描口径。
- **用户最新方案授权**：按 `quality-acceptance-gap-review-2026-09-05.md` 六阶段一次推进，数据/2D→模型素材→仿真→性能/结构→行业深度与整体后验收；每批验证并本地提交。GPT/GPT-6 接入不做，外部下载暂停 164 GLB。GLM heartbeat 与旧夜间 cron 已 PAUSED，覆盖上文历史“自动续跑”状态；当前普通任务继续。
- **已完成（EX-002）**：字段面板/类型槽位/计算字段/管道预览与重试、拖放/键盘/单步撤销/解绑；检查器按来源、分析角色、报表拆分至 290 行。四组真实浏览器与隔离生产数据→保存→刷新→发布匿名读取→草稿隔离通过；完整索引交接 §13、EX-002 规格。下一直接任务 S1-002，不重复建设本批。
- **已完成（S1-002）**：语义模型定义编辑/CRUD、源切换失效提示、管道真实预览、未保存保护；修复数据中心非默认项目刷新失去身份。四组合生产浏览器、Web 1179、根类型/1773 源文件/生产构建通过，交接 §14。
- **本轮待办（用户追加优先）**：脚本/3D/2D 统一体验；预览和发布生命周期自动挂载，手动播放仅用于作者试运行；先补运行模型，再处理快捷键、日志、保存反馈和真调试，方案 `editor-workflow-refinement-2026-09-05.md`。六阶段其他待办不取消，禁止将全量测试通过当作全项目完成。
- **用户最新决策**：所有此前问题都继续，不限编辑器；允许直接补充缺少的素材/模板，必须核验许可及真实缩略图。这条授权覆盖上文“外部下载暂停164 GLB”，不恢复暂停的定时任务。GPT 接入仍暂停。编辑器以 ThingJS 工作流为主、Unity 补充；文件栏缩窄可收起、挂载选择单行；几百行代码按职责提高可维护性，不机械拆行。
- **已完成（编辑器增量）**：浏览预览自动生命周期与私有运行状态、视口就绪后挂载/退出清理、快捷键最新草稿、保存失败重试、完整日志筛选/结构化数据/源码定位、单行目标/152px文件栏/窄窗与亮色根因修复。`script-editor-Fxb4X8` 与 `script-playback-GWxuU2` 各四组合真实浏览器通过；后者13/13 Worker关闭、零作者PUT，1条已知ANGLE X4122驱动诊断单列。详细证据/剩余边界见交接§15。
- **本轮待办（持续）**：正式发布自动运行、作者试运行隔离/运行范围、真调试和跨编辑器联动；语义消费/联动钻取、模型优化全流水线、有效素材模板、SIM真实运行/覆盖层/Study、Agent恢复、16.7ms性能及全仓职责治理。不得把上述已完成增量误报为“所有问题已做好”。
- **已完成（用户配色复核）**：首张亮色截图确有深浅混搭和品牌强调不同步，已修工作区/面包屑/标尺/工具栏及状态色；保留用户画布内容色。`script-editor-Fxb4X8`四组合及实际文字对比度、公共UI `report-final`四组合、Web1190项均通过；交接§15记录漏检根因与当前权威截图。
- **已完成（结构独立批次）**：§15功能先提交`d1c68ac`；纯重构将ProfessionalCodeEditor664→341，服务/类型声明/降级边界独立。原聚焦15项、全仓pnpm test（Web1190/API449及其余包）、根typecheck/构建通过；`script-editor-ljfIQ0`四组合与前一批布局/颜色测量相同，首屏305.3KiB/gzip99.1KiB不变。1793源文件58个>500、零>800；全仓职责治理未完成，下一作者运行控制器及原六阶段见交接§16。
- **已完成（草稿边界）**：真实复现并修复画布点选切脚本丢稿，统一新建/导入/文件切换保护，保存回声保留后续编辑，迟到反馈不跨文件。Web1194/构建、`script-drafts-F8is4b`和相邻`script-editor-1EZHD0`各四组合通过；下一补已复制却无前端的`/apps/:id`公开应用运行页，详见交接§17。其它六阶段待办保留。
- **已完成（EX-004）**：`/apps/:id`只读发布运行、版本依赖授权/历史文件保留、自动生命周期/3D挂载/键盘联动/筛选/导航、撤回与503重试、发布草稿隔离；四组合 `published-application-rbGKnK` 每组8/8 Worker释放、0匿名写和私有接口请求。相邻预览/脚本门禁均4组通过，全仓测试/类型/构建通过；完整证据和明确未启用的匿名数据/AI/旧脚本边界见交接§18，不以当前闭环代替全项目完成。
- **已完成（ASSET-001下载前置）**：原子下载、实际字节/GLB/PNG/许可详情、目录锁与坏目录拒绝、准确计数，素材聚焦24项通过；真实新增2个CC-BY-4.0模型，164→166。**仍未入统一素材库**，保持review-required，后续真实渲染/准确缩略图/署名随导入与交付、目录适配及模型优化闭环见交接§19。原六阶段和作者调试任务不取消。
- **已完成（ASSET-001入库，覆盖上一条缓存状态）**：新增2项真实WebGL审核并接入统一素材库，正常API4100已核实；原164项仍待审，原GLB不改。修导入哈希/待审绕过/6并发重复、资源页刷新身份/精选筛选/跨项目迟到响应、亮色对比度和干净预览图下载。`source-b-library-pUMxr4`四组合通过，暗5.53/亮4.56，原文件哈希/署名/转换/恢复/503/迟到响应均验证。交接§20和ASSET-001为新恢复点；优化另存/交付署名、模型回场景、作者调试、语义消费、SIM/AI/性能等仍本轮待办。
- **接手续更**：用户已要求能并行尽量并行及用量不足提前留档，当前首读`NEXT-AGENT-START-HERE-2026-09-05.md`（检查点提交84ca27c）与交接§21。Agent选择恢复已提交0967ef6；优化器可靠性/追溯和作者隔离有最终四组证据但源码仍待集成提交。语义查询浮层补丁、SIM-1a、公开署名与ASSET-002无缝模型工作流正在接线/最后验收。23:20全仓API492通过、Web1240通过/1架构失败已根因修并13项聚焦通过，不能写成全仓已绿。所有剩余门槛在新检查点逐项保留，不重复建设、不回退并行改动。

### 15.6 2026-09-06 并行修补与功能推进

2026-09-07 r30阶段增量：生产模板可编辑示例→整组修改→筛选→保存刷新→CSV→匿名发布已验证。Web405文件1634测试、Contracts20文件201测试、Web build通过；两轮浏览器 `dashboard-samples-MkpwSQ` 4/4。详见 `dashboard-sample-verification-2026-09-07.md`，原120模板数不变、未完成完整行业包/填报写回，不冒充全项目完成。

2026-09-07 最新用户再次排序（覆盖下方历史顺序）：先做最近七项清单中的 **2 素材/行业模板 → 3 填报/打印/导出 → 6 仿真与 AI**，随后 **1 第三轮 V3 报告修复 → 4 UI 整体收尾 → 5 Vapor 方案 → 7 全量测试/对标/交接/本地提交**。开发中的聚焦测试与必要 UI 验证照常执行，不等同于提前展开全站 UI 专项。协作不做；恢复/SDK仅必要修补；统一语义/公开数据治理仍暂停。V3 与 Vapor 原文已完整阅读，纳入后续队列，未证实项不直接定性为缺陷。已在工作区完成但尚未浏览器验收的 V3-P2 场景回写字段剥离修补保留，不抢占当前主线。

后续模板/打印/素材批次：模板空态/键盘隔离、结构预览、A4打印及优化器八角点取景修补；164旧模型官方许可和结构证据补齐，source-b166缓存/3审核入库/163待视觉审查。完整证据和未完成项见 `template-print-assets-verification-2026-09-07.md`。不是300模板/十行业包/填报全链路已经完成。

2026-09-07 用户最新缩围优先于以下历史顺序：主做交互收尾、素材/模板、填报/打印等原功能；**协作明确排除**。恢复和SDK只修影响正常使用或上述主任务的必要问题，不展开备份演练和插件生态。此前暂停的统一语义/公开数据治理、专项性能/长文件治理仍暂停。具体恢复点见接续检查点“用户最新范围”。

2026-09-07 r19：Vision/2D 检查器/左侧页签/全局工具按钮同族主题缺陷已修；Web401文件1615测试、Web build、根typecheck及2043源文件体量通过。两轮真实浏览器 `workspace-themes-5dc7aC`4/4、相邻Esc `dialog-escape-wvf2hh`4/4，图片源上传与480/800表单实测；准确边界及十维自检见 `workspace-theme-verification-2026-09-07.md`。完整焦点/2D组件属性窄窗仍本轮待办，不宣称全站完成。仿真和AI保持最后；GLM新写的shader/vapor候选方案不自动升级为当前实现任务。

用户最新排序：先推进UI/交互、恢复兼容、SDK插件跨项目与素材/模板，仿真和AI最后做；原第3/6项暂停不变。本批机器人/脚本真调试/独立模型/SDK样例及研究已本地提交 `f3c624e`，严禁push。随后r17空集合恢复误报修补通过：Web400文件1613项/build/typecheck、2041源文件体量；两轮恢复4/4、相邻Esc4/4，见 `recovery-collections-verification-2026-09-06.md`；不把r16机器人证据说成r17全站复跑。

最新追加（r16）：脚本真调试、模型独立实例/保引用替换、SDK文档样例已完成限定两轮真实浏览器验证；URDF原包→素材/压缩→独立姿态→保存/2D/公开，以及ROS1/2显式会话接入也已通过限定集成验证。r15根build/test、r16 Web400文件1606测试/build、根typecheck/2040源文件体量通过。准确构建与两轮截图见 `robot-integration-verification-2026-09-06.md` 和接续检查点；不是实机/认证动力学或全项目最终验收。uni-app X评估已落档，新微信正文未获取。仅本地提交、不改admin/admin和存储；第3/6项、GPT及自动化继续暂停。

最新入口：`continuation-checkpoint-2026-09-06.md`，覆盖上一节历史的“下一直接任务”与旧测试数字。用户继续要求功能并行推进，不是只做报告或测试；仅本地 `dev-studio` 提交、严禁 push。

- **明确排除（用户当前暂停）**：上一进度清单第 3 项 AskData / 统一语义消费 / 公开数据授权治理，第 6 项专项性能 / 大模型稳定性 / 全仓长文件治理；必要回归与新代码体量门禁仍执行。GPT 接入和旧自动化保持暂停。账号、拓扑、原场景不改。
- **已完成（R2）**：React 根渲染/启动失败受控恢复，作者与公开入口 18 个隔离真实浏览器故障用例、零自动写、同路径手动恢复；提交 `752b085`，证据 `application-error-verification-2026-09-06.md`。不宣称任意事件/异步错误都由 React boundary 捕获。
- **已完成（相机取景修补）**：真实 17.5 cm 夹爪旧固定最小 2 m 导致只占屏 10.3%，修八角点透视适配、默认轨道范围、近景标记与网格遮挡；用户自定义范围和原模型不改。两轮 `camera-framing-wGgINY/ihB18A` 共 44 作者状态、4 保存/刷新/发布匿名链路通过，44 个取景状态最长边 33.11–81.96%（dark）/39.36–76.81%（light），匿名零写、GLB 哈希不变。取景飞行动效与跨比例公开构图仍待办，详见相机报告，不声称全套画质或 Kimi-95 完成。
- **已完成（限定浏览器验证）**：F1 显式 Esc 仲裁、发布 busy 保护、弹窗局部双主题最终 `dialog-escape-gaDn1U` 四组通过；检查器数字输入与局部主题 `inspector-theme-7ajweL` 四组通过。代码与完整报告将按批次本地提交，Vision 整套主题不包含在本次通过范围。
- **本轮待办（并行）**：SIM 停靠/收起与真实视口让位；SDK 外部独立消费打包验收；编辑器保存快照回声与 3D→2D 模型状态完整同步；限定读请求恢复与目录失败重试。已发现 SDK 归档缺 dist、保存响应误把外部引擎变化当作新草稿而留空场景，按真实根因修，不删除数据或放宽断言。
- **项目级后验收**：全功能/真实工业场景整体验收继续，不以当前修补或固定夹具代表全部功能完成。原事故无可靠事故前基线，不能独立保证历史数据全恢复；不运行旧 GLM 破坏性脚本。
- **已完成（SDK 可消费性前置）**：三个私有包补明确 `files` 清单解决 tarball 漏 dist；外部独立消费者 `sdk-consumer-cGONEo/lKsvLC` 两轮空 store 离线安装、NodeNext/Bundler 严格声明、Node 与 Chrome 同结果、零外部/业务请求通过。新增 `pnpm gate:sdk-consumer` 与可执行样例；完整证据 `sdk-external-consumer-verification-2026-09-06.md`。仅协议/调度/HTTP SDK，不代表公开发行、嵌入式 Viewer 或第三方插件生态完成。
- **已完成（保存一致性）**：修复冻结场景缩略图直接赋值与 Store 把外部引擎新增模型误当并发草稿而拒收的两重根因。发送前取实时基线，三方回声合并保留后续本地编辑/删除/撤销历史，迟到响应不跨项目/文档。r6 `scene-shell-theme-ulm3QR/ScDsCs` 共8组实际模型保存→二维显示→三维返回，完整models数组及原GLB哈希保持，详见 `application-save-reconciliation-verification-2026-09-06.md`。
- **已完成（r6局部验证）**：对象目录/品牌焦点两轮8组、检查器 `inspector-theme-slAvBf` 4组、Esc/真实非空历史/恢复副本 `dialog-escape-xMgPZC` 两轮4组通过。局部令牌改进遵循 design-taste-digitaltwin，报告保留2D/Vision旧主题及980计数等不足，不据局部通过称全站Kimi-95。目录 `read-recovery-oHT3I5` 两轮4组验证有限读取恢复、持久错误、真实鼠标双击/键盘重试、写失败保稿，真空CTA精修仍待新构建。
- **已完成（命令基线）**：r5 根 build/typecheck/test均退出0（Web1364/API494/Core79/server-sdk90及其余包）；r6 Web构建/全量1367通过。09:06 r7前置Web1373、根typecheck/1931源文件体量通过；随后恢复比较修补需追加回归，不混用旧数字。正常web API4100/Web5173健康，未改账号与拓扑。
- **本轮待办（收口）**：SIM菜单窄画布边界/手柄覆盖最终验收、目录空态主CTA、仅字段顺序不同引发恢复提示的稳定比较修补；统一新构建与浏览器复跑、按模块本地提交。非修补功能完整队列保留在最新检查点，不降级为全部完成。

#### r9 本批最终状态（覆盖上文历史待验收描述）

本批本地提交：保存一致性`b0f5fb4`、目录/弹窗/局部主题修补`e62bb8b`、SIM停靠`5c3c843`；同在内层`dev-studio`，未push。恢复入口为`continuation-checkpoint-2026-09-06.md`。

- **已完成**：三目录有限读取恢复/持久错误/手动重试/取消身份保护；真空单主CTA及按品牌亮度选择中性文字。`read-recovery-EVkckS/mqaLz2`两品牌各两轮双主题共8/8，金9.716:1/紫6.441:1；真实鼠标双击/键盘/POST失败保稿再提交仍通过。
- **已完成**：Esc/发布busy/非空历史/真实草稿恢复 `dialog-escape-p6S2iL`两轮4/4；2D/3D模型保存与主按钮相邻 `scene-shell-theme-ER7rgY`紫色4/4，API模型与原文件哈希不变。仅键序差异的恢复误报已修，真实字段/数组/微小数值差异仍保护。
- **已完成**：SIM左右停靠/44px收起/恢复浮动/真实canvas让位、窄画布菜单和六方向按钮可达、输入DOM连续。`simulation-docking-33Wdbl`两轮4/4，布局零API写；真实正式Study全链仍为r7 `scene-plant-flow-ApwMDa`四组证据，不混用构建归属。
- **已完成**：r9 Web构建与371文件1387测试退出0；r8根typecheck/1932源文件体量通过；r5根build/test包含API494项通过。09:30正常web服务健康，API4100/Web5173，未修改账号、拓扑或原数据。截图两轮亲审和同族检查按design-taste-digitaltwin执行，各报告明确低于9分或未测项，不声称全站Kimi-95。
- **本轮待办**：脚本源码断点/单步/调用栈、独立模型实例与保引用替换、SIM历史/连续AGV/机器人/多域轨道、AI工业工作流、行业包/真实模板、SDK文档样例与插件工作流；已知2D/Vision旧主题、更窄断点/焦点、稀疏快照兼容和R3隔离恢复证据也保留。准确列表与报告链接见`continuation-checkpoint-2026-09-06.md`，不能把本批完结写成全项目完成。第3/6项和GPT/自动化继续明确排除当前执行。

#### 2026-09-13 编辑器对象、导入与导演台收口

- **已完成（本次增量）**：项目资源卡片、可选择/裁剪/截取并保存缩略图；优化回填的快照恢复竞态；2D/3D 右键编组/取消和出组；轨道双击加帧、相机手势录制、四位参数与分段过渡；导演台窄布局和按钮统一；面板收起按钮锚定、ViewCube 间距、视觉样例栏与 AI 模式按钮对齐。Web 2330、Contracts 248、API 缩略图 4 项通过，生产构建通过；两轮双主题浏览器主链路、二维和媒体缩略图各 4/4。报告：`docs/specs/resource-director-refinement-verification-2026-09-13.md`。
- **已完成（最新收口）**：隐藏二维右键无效的重叠对象选择子菜单；现有场景实例进入优化时携带准确实例 ID，优化页显示“应用优化并返回场景”，返回通过 `replaceModelManifest` 原位替换并保留身份、位姿与绑定，新上传才新增。导演台移除重复时间滑块，帧/轨道支持按钮和 Delete 删除，相机与变换手势自动录帧；对象和主方向光再次点击取消选择，方向光文字对齐；3D→2D 在旧应用 ID 失效时按场景重新解析所属应用。Web 494 文件/2342 测试通过（另 2 文件/2 测试跳过），类型检查和生产构建通过；1440/980 深浅主题两轮截图通过。
- **项目级后验收**：仓库门禁仍被 Git 索引中的已删除 `apps/node-red/package.json` 阻断；未恢复 Node-RED 或改治理规则。模型替换需要保引用兼容检查，不把固定 GLB/媒体样本推广到任意格式。其他引擎/脚本/业务域的排除和待办不变。

#### 2026-09-13 AI 电池原生推理与分析报告

- **已接入**：BatteryMFormer SPM-PINN 导出为独立 FP32 ONNX 包，由 Rust `ort` 执行；制品包含适配器、BatteryLife 工况嵌入和哈希清单，产品运行不依赖 Python 或原模型项目。真实合成业务记录经 API 的“标准专家 → PINN 风险路由”贯通，PINN 输出保留可辨识度、融合门、物理拟合、等效内阻、有效扩散时间、衰减率与 OCV 证据。
- **页面收口**：保留 SPM-PINO 多物理神经算子与 TwinMoE 风险路由主技术轨；新增结构化分析报告，呈现观测/预测边界、目标 SOH 与删失语义、路由原因/分歧、PINN 物理证据、模型版本和依据。电池页不再显示无关的全局 Study 底部记录，电池绑定的最近运行移入右侧证据栏；示例动作移出数据来源页签，改为“运行示例”次操作。
- **验证边界**：PINN PyTorch/ONNX 最大绝对误差 `3.8147e-6`；Rust 实际推理与 API 动态路由已运行；聚焦测试、类型、构建和浏览器无横向溢出门禁以本任务最终回执为准。PINN 严格测试 MAPE 仍低于标准专家，因此仅由风险路由触发，不替代标准主专家。
- **数字孪生续接**：Rust 原生运行时补齐源项目在线同化、10 分钟 LFP 多物理域门禁、TwinMoE 风险收益路由、受门控迁移校准、风险不确定性区间、CLF-CBF 影子安全投影和可回放证据；域外动态模式明确由 SPM 守恒回退，`both` 模式只把 PINO 保留为分歧观察。未迁移离线训练展示卡、市场工单和研究型适配器训练流程，不把这些非在线孪生能力写成已接入。
- **最终验证**：Rust 7 项测试与 Clippy 严格门禁、API 电池聚焦 27 项、Web 电池与样式 4 项、两端类型检查、API/Web 生产构建均通过；真实 ONNX 服务已覆盖域内 PINO、三项域外 SPM 回退、64 点迁移修正、CLF-CBF 影子限幅、证据回放和非法会话 400。1280/980/480 三档浏览器无页面横向溢出，RUL 示例实际路由到 PINN 并呈现物理辨识证据，控制台零警告/错误。全仓源文件体量门禁仍被 6 个本任务外既有文件阻断，不将其记为本批完成。
- **样例与结果补全（本次最新）**：内置样例改为首选数据源并扩为 8 个，覆盖 NCA/LFP 公开验证、NMC/LFP 大容量工程、TEMPEST 280 Ah 右删失老化、SOC 连续窗口、96 电芯 Pack 与 LFP 极端脉冲；不再保留独立“运行示例”按钮，选择不兼容样例时自动切换到可执行目标。8 个样例均已在真实浏览器通过主按钮运行。报告新增输入行数/圈数/电芯数与电流、电压、温度、SOH、容量范围；Pack 以 96 电芯聚合和最弱电芯为主结论，不再用展平后的单模型值冒充 Pack 健康度；RUL 同时展示标准/PINN 候选寿命，并在标准结果因 24.4% 分歧被保留时继续呈现 PINN 物理辨识证据。
- **可编辑工况推演（本次最新）**：电池页可编辑初始 SOC/SOH/温度以及最多 6 段时长、C-rate、环境温度，经 `battery.twin.initialize` 和 `battery.twin.simulate` 直接调用 Rust 原生孪生。真实浏览器已验证 10 分钟域内工况由 SPM-PINO 生成 64 点主轨迹，改为 21 分钟后 TwinMoE 按验证域自动切至 SPM 守恒回退；结果包含终点 SOC、峰值温度、最高电压、吞吐量、不确定度、路由路径、安全投影次数、模型版本和告警。未加入 Python 运行依赖。

- **已实现**：三维对象管理收敛为单一目录；对象行与选择集统一多选标记、隔离、碰撞和编组入口；二维支持 Ctrl/Cmd+G 编组、Ctrl/Cmd+Shift+G 解组，三维支持 Delete/Backspace 删除未锁定对象；更多菜单支持外部点击与 Escape 关闭。
- **已实现**：RVT 转换方式与 Revit 版本移入“添加模型”的 RVT 条件导入设置，不再挤占对象目录；上传后的优化或直接插入会等待项目中的权威 ready 模型，转换失败不会继续打开后续工作流。模型优化和拓扑编辑的回场景参数继续沿用现有回填链路。
- **已实现**：场景导演台统一时间线、镜头与漫游，新增相机/对象轨道首帧、逐轨加帧、关键帧选择/拖动/编辑/复制/删除和属性检查器；面板拖动缩放时只扩展轨道工作区，不整体放大按钮与文字。
- **视觉修补**：ViewCube 工具栏上移并留出间距；主方向光不再默认伪选中；二维基础控件/资源库标签完整显示，卡片密度收紧；三维项目资源和工业预制体缩略图提升至可辨识尺寸；对象空态不再出现第二套创建入口。
- **验证边界**：聚焦单元测试、Web 全量测试、生产构建和深浅主题真实浏览器门禁结果以本任务最终回执为准；不将此批编辑器交互收口描述为全项目或任意工业文件转换器的完整验收。
2026-09-13 23:00 Codex Deep Engine 本轮收尾（未提交、未 push）：当前目标平台冻结为 Browser WebGPU + Windows 原生 wgpu，macOS/Linux/Android/iOS 全部移出当前开发、构建、测试和完成分母；Unity 相关兼容继续暂缓。P2 明确保留 Shader、Three 插件兼容、无感切换、Windows 原生客户端、Deep2D/GUI/Chart/Host、统一资产包与 Windows 发布。P0 新增确定性缺失法线生成、真实导出器四元数舍入归一化、通用 authored FLOAT VEC4 TANGENT ownership/正交/手性验证；固定 Khronos TextureEncodingTest 与 AlphaBlendModeTest 已入库并核验许可/hash，分别覆盖色彩空间+2 条缺失 NORMAL 和 9 条 authored tangent+OPAQUE/MASK/BLEND。Deep 全包 181 文件、1554 通过/28 跳过，Node 策略 26、runtime purity 400 Browser/142 Native/194 Windows packages、882 文件体量零告警，type/build 通过；NVIDIA 浏览器真机两样本首帧和控制台 0 warning/error，证据 `webgpu-1789310375339.json`、`webgpu-1789310831043.json`。完整接手边界、下一直接任务与命令见 `docs/codex-glm53-handoff-2026-09-13.md`。

2026-09-13 23:00 九小时并行续跑：用户把 23:00 定为本轮文档检查点，随后 Codex 与 ZCode GLM 并行到 2026-09-14 约 07:50。Codex heartbeat 每 30 分钟继续 Browser P0，当前三支为 sparse accessor、真实资产 GPU 像素断言、公平 benchmark shader 等价/冻结画面修复；GLM 按交接 §7.2 独占 `packages/deep-engine-native/**`，以多个中等复杂度小任务完成缓存复用、revision 失效、device epoch、失败回滚、Windows smoke，提前完成才二选一补矩形 clip 或 image quad。两边不得改同一文件，不 push。
2026-09-13 23:23 Codex 全仓提交前收口：用户授权 Codex 后续在功能切片与门禁通过后自主管理 commit/push，禁止强推；同时删除完整 Three 插件逐个兼容、复杂 Shader Graph 产品、非 Windows 平台适配、重型 RT/路径追踪、UE 全套虚拟几何和长尾格式新 decoder，保留高频 Three 桥、轻量 Shader、Nanite Lite、glTF/GLB 深度支持、Browser WebGPU 与 Windows native。权威执行计划、backlog、Three/Shader 规格和 GLM 交接已同步，并把“先核对依赖/标准/本地实现，能复用或接线就不重写”设为硬门禁。提交前修复 6 个 >800 行源文件，按稳定职责拆为最大 268 行的新模块；全仓 `pnpm gate:repository`、typecheck、生产 build/API import smoke、3496 文件体量门禁和串行 `pnpm test` 通过：Deep 182 文件/1566 通过/28 跳过，API 145/643，Web 496 通过/2 跳过、2349 通过/2 跳过。并行高负载首轮曾使 API 两个 1 秒异步转换等待超时，聚焦 13/13 与随后全量串行复跑均通过。
