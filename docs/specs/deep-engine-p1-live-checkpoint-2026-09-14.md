# P1 Native / Windows 实测检查点

## 跨包资源源域隔离（源码晚于 23:26 候选）

原 GPU cache 的 revision 与 GPU version key 只包含局部资源 id/revision，整个设备 epoch 共用一张表；不同项目拖包时同名几何/纹理会误报内容漂移。现在 PlayerContent 保存稳定源域，Renderer init/stage 使用内部 namespaced manifest，原 RenderPacket/entity ID 不变。同一个 device cache、预算、弱引用资源退休和提交票据继续使用，没有清空缓存。

文件来源采用与 LKG 一致的原始绝对路径/Windows 小写规范，不使用恢复快照路径；目录和 manifest 入口归到同一 manifest。域包含来源类型、Runtime packageId，Asset Directory 另含外层 packageId；packageHash/version 不入域。同源同 revision 改内容仍拒绝，同一文件更换 packageId 视为新包。内存包使用 packageId，裸 RenderPacket 保持原默认域。Live watcher 同样绑定授权源。

每个设备 epoch 最多保留 256 个源域、65,536 个 geometry/texture revision 身份；到限明确拒绝新身份并提示重开 Viewer，不遗忘旧 revision，也不重置全域 GPU 预算。stage 与 commit 均重检容量；晚提交票据不能覆盖已提交的另一内容。

真实 RTX 4060 同设备测试：两个源文件使用相同 packageId、geometry/texture id/revision，但内容不同，HDR 334 像素变化；同源漂移、零尺寸和全域预算失败均保留旧源；回到 A 后 HDR 差异 0，强存活资源数量回基线。B 真正 present 后写 LKG，再损坏 B 源，恢复内容仍使用 B 源域。旧 A GPU 资源退休后，A 的 revision 漂移仍被拒绝。256 域上限、65,536 revision 上限和迟到票据冲突测试通过。IBL shader 对照已移除先前避免 ID 冲突的几何重命名，仍通过。

源域核心 all-targets 测试退出 0，strict clippy/fmt 通过；Windows 大写 manifest 路由与 Asset 外层 owner 补充后，最新复测被并行 P3 `deep2d/hit_index.rs` 尚未完成的 clip-context/entry 字段变更阻断，已报告主线程，未修改 P3。源码文件最大 298 行。待 P3 稳定后复跑最后补充与总检查。

23:26 冻结 ZIP 保持 `fdf77c6c93bc1d26738dca1c4740425e90d00f9a98c7b32437ec80e929cba5c6`，不含本节源域隔离；未重打任何包。

## Windows prefiltered IBL / directory drop 候选（23:26 北京时间）

独立候选目录 `packages/deep-engine-native/artifacts/windows-portable-prefiltered-ibl-drop` 已生成，不覆盖两个旧包。包含当前 Native 同设备目录/Runtime 拖包、prefiltered IBL 事务，以及新增共享 `runtime-package-prefiltered-ibl-v1.json`。通道仍为 candidate，签名、安装/更新、硬件矩阵和完整 P1 验收未完成。

| 身份 | 值 |
|---|---|
| ZIP | `deep-engine-native-0.1.0-x86_64-pc-windows-msvc.zip`，4,014,365 bytes，41 项 |
| ZIP SHA-256 | `fdf77c6c93bc1d26738dca1c4740425e90d00f9a98c7b32437ec80e929cba5c6` |
| EXE | `bin/deep-engine-native.exe`，10,490,368 bytes |
| EXE SHA-256 | `554c3ddd76af8ddb9c17452524c8c6c11f749509d4ea3aaeef74eb096de45819` |
| Native 构建输入指纹 | `8ce74c72f0eefa7b1978d757b53eae1abb23694e4aa9a1754ac7bbfeefd0b14b` |
| SBOM input SHA-256 | `aa4fc1f5ddcf3ab4a842381e070674c26d58699ea7bc1090ab0ecff5e1629b85` |

构建前后及 23:25:56 独立核对时 source fingerprint 一致；此指纹覆盖 Native 源/着色器/打包脚本、随包共享夹具和许可证输入，不代表整个仓库冻结。SBOM 输入包含 88 个组件、89 条依赖关系、275 个构建输入。`renderer.rs` 的 IBL summary 按职责移至 environment_update，当前 297 行；all-targets strict clippy 和 fmt 再次通过。P3 全仓 source-size 集成仍由主线程验收。

构建 staged/final 各 26 项 smoke 通过。Windows PowerShell 5.1 新解压目录 `independent-99059cc13ede444bb57fb040c61d59c6` 再跑 26/26：新 prefiltered IBL 合同与真实 GPU 首帧、author LOD、目录完整导入、manifest/chunk 损坏后新进程同源恢复、其他源拒绝、既有剖切/选择/着色器等。全过程使用独立临时 LOCALAPPDATA，未写用户日常缓存；临时源与恢复数据已清理。41 个 payload/ZIP 条目哈希、9 个内嵌着色器完整源、SBOM、Windows PE/静态 CRT 与无浏览器纯度通过。

完整独立证据保存为候选目录中的 `independent-verification.json`，SHA-256 `9f3ff5a605a050016206b3a31f276d9826aff6048e565d8e8123a7b3cee0f0bb`。实际拖放事件/IBL像素事务证据仍为前节 source GPU 测试；解压 EXE 验证的是包解析与 GPU 首帧，未另做人工资源管理器拖拽。

旧 author-recovery ZIP `13dd01f0c82aec5dea20988699d2a0224e17fc2dfde52f3513759b74e9a3eab2` 与 annotation ZIP `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe` 再核对未变。

## 同设备 prefiltered IBL 拖包（源码晚于冻结候选）

共享 `deep-engine.ibl-prefiltered` v1 已接 Native payload decoder，复用现有 canonical base64 和 half 转换。完整 mip、尺寸、source 声明、半精度有限非负、精确字节数严格校验；64 MiB 总预算先于任何 base64 扫描/解码分配。GPU identity 使用索引中已验证的 payload hash，不把 source hash 当实际 HDR 证明。旧 builtin wire 未改。

同设备暂存 IBL、标准 PBR frame binding 和 ShaderMaterial bindings，与 scene/Deep2D 共同离屏验证、恢复和发布。不呈现候选预览；失败恢复 active，成功后的实际 present 才写 LKG。IBL 单环境/过渡预算为 64/128 MiB。实时 RenderPacket 更新仍要求环境不变，本次打通整包拖放。

验证：共享 IBL 协议 4/4、既有 Runtime 合同 4/4；lib 51 项、bin 57 项通过（11 个显式 GPU 探针默认忽略）。真实 RTX 4060 Vulkan `package_drop_probe` 显式通过：目录/manifest/Runtime→prefiltered 拖包后 GPU 与 LKG；同 id/revision 换 payload 的标准 PBR HDR 521 像素变化，亮度 305.47037→177.97925；仅显式 ShaderMaterial 实例 HDR 184 像素变化，128.51228→97.18885，零 shader isolation/fallback。两路切回并拒绝零尺寸候选后像素差异均为 0，renderer id 不变。目录普通测试 4/4、恢复 preflight 1/1，本次未重复其余独立 GPU 测试。

`cargo check --locked --all-targets`、`cargo clippy --locked --all-targets -- -D warnings` 和 fmt 最终复跑均通过。期间并行 P3 测试迁移曾导致 `tests/chart_ir_contract.rs:3` / `tests/retained_ui_contract.rs` 导入失败；主线程收到证据后现已消除，本切片未修改 P3。本切片文件最大 293 行。旧 `runtime_lkg_retirement.rs` 等价合并嵌套 if，消除自身 lint。

记录时 Native source 指纹 `1acad7c24e5309e051852759a4df8f9d5c7a3bedf434552a21b7ec115fe02198`，并行 Native 集成仍可能变化。candidate ZIP 仍 `13dd01f0c82aec5dea20988699d2a0224e17fc2dfde52f3513759b74e9a3eab2`；annotation ZIP 仍 `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe`。二者未重打，不含本节 IBL 扩展。

尚待：完整 HostCapabilities/崩溃恢复矩阵、人工拖拽和产品视觉验收；跨包相同 geometry id/revision 不同内容仍受既有 cache 身份冲突拒绝策略约束。详见 Native `docs/prefiltered-ibl-v1.md`。P1 全部完成状态不变。

## Asset Directory 拖放接线（源码晚于冻结候选）

普通 Viewer 的现有 `DroppedFile` 路由现在接受单个 Asset Directory 文件夹或 `manifest.json`，并保留 Runtime Package JSON（含合法文件名 `manifest.json`）。批次在事件循环空闲前收齐，多路径和取消不发布；背景 IO 仍使用原 latest mailbox。资产 CLI 与拖放共用完整目录/LKG loader，普通 Runtime 拖放也接同源持久 LKG。标注草稿/保存失败保护继续沿用。

真实窗口测试暴露旧拖放重建方式的阻断：旧 renderer 存活时，同窗口建立第二候选设备的子进程连续两次退出 2173，没有 Rust panic 或 GPU error 明细；未据退出码归因为驱动。当前改用同一设备 stage scene/Deep2D，RAII guard 临时装配候选到完整离屏输出目标做 GPU 验证，不呈现预览、不提前提交资源票据；成功后走已有 cache/CPU 发布，失败恢复旧资源并重绘。LKG 仍只在随后真正成功 present 后写入。普通帧提交验证移到 present 前；临时 acquire skip 在待保存首帧时会重绘重试。

验证：真实 winit `DroppedFile/HoveredFileCancelled` → 后台读取 → GPU → 发布/LKG 探针通过，覆盖多路径、取消、缺失源保留，以及目录→manifest→Runtime 往返；另验证改变 IBL 和零尺寸候选拒绝、失败没有目录 LKG。focused 队列 5 项、源路由/批次 2 项通过；`cargo test --locked --all-targets` 退出 0；目录 5/5、恢复 4/4、实际 LOD/CSM GPU 4/4 显式复跑通过。fmt 通过；仅诊断允许既有 P3 两类 lint 的全目标 clippy 通过，严格门禁口径不变。相关文件均 ≤291 行，未修改 P3 或 author LOD。

限制：同设备拖放暂拒绝 IBL id/revision 变化并保留旧内容，需单独启动 Viewer；跨 IBL 热切换仍为本轮待办，不能标 P1-03 全部完成。测试为真实 winit 合同事件注入，并非人工资源管理器拖拽验收。

当前 Native 指纹 `763f3956aec8468ade892c2abda65349cd4c8f6b425d8e844aad103eb2b8c086`；冻结候选仍记录 `13dd538cce5b785781b94a3b5ae86ad0501df40739f483c62274041c3d76a2d3`，差异来自本节拖放/候选离屏验证/测试源码。候选 ZIP SHA 仍 `13dd01f0c82aec5dea20988699d2a0224e17fc2dfde52f3513759b74e9a3eab2`，旧 annotation ZIP 仍 `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe`；两个包均未重打。目录 profile 已纠正旧“ZIP inclusion 未覆盖”说明。

## Windows Author LOD / Asset Recovery 候选（22:43 北京时间）

新产物位于 `packages/deep-engine-native/artifacts/windows-portable-author-lod-recovery/deep-engine-native-0.1.0-x86_64-pc-windows-msvc.zip`，通道为 `candidate`，3,975,756 bytes，40 个文件。它包含 author-selected LOD、资产目录完整 LKG，以及第一方 `runtime-package-author-lod-v1.json` 和 `asset-directory-v1/manifest.json` / 全部 3 个 digest blob。README 明示候选资格和仍未过的 P3 集成门禁。

| 身份 | SHA-256 |
|---|---|
| ZIP | `13dd01f0c82aec5dea20988699d2a0224e17fc2dfde52f3513759b74e9a3eab2` |
| EXE | `ebf8fb8ec426f5bdb32fba35a2cf7990baf55c1ce73cf969b5ed40daf21a34b0` |
| Native 构建输入指纹 | `13dd538cce5b785781b94a3b5ae86ad0501df40739f483c62274041c3d76a2d3` |
| SBOM 输入文件 | `2d420b97ef9e0cda4e8e4841cf761b94a366c20afe6d9c3533a95354a3a90ea2` |

静态 CRT release 构建、打包 staging / 最终目录各 24 项检查通过；Windows PowerShell 5.1 独立解压后再次 24/24 通过。独立记录为同目录 `independent-verification.json`，解压目录 `independent-97fc195bccd14193a2f41768c3c0670c`。验收检查 40 项 payload 长度/SHA、ZIP 内容一致性、PE/static CRT/purity、9 个内嵌 shader、SBOM 的 88 个组件/89 个依赖关系/266 项构建输入；源码指纹与构建时记录一致。

所有 smoke 的 LOCALAPPDATA 均重定向至每次新建临时 sandbox 并在结束后恢复、清理。恢复测试修改 sandbox 内复制的资产目录，不修改交付 fixture：首次 GPU present 保存→新进程损坏主 manifest 恢复→再次损坏 chunk 恢复，均有 `active=last-known-good` 与 clean GPU 提交证据；另一来源坏包被拒绝。原 `windows-portable-annotation-reliability` ZIP SHA 仍为 `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe`，没有覆盖。

本候选不是 release 门禁通过声明：严格 clippy/source-size 的 P3 问题、签名/安装卸载/跨显卡/更新回滚和完整 P1 验收仍待完成。

## Author-selected LOD 主画面 / 阴影消费者（仅源码）

Native 读取同一 `runtime-package-author-lod-v1.json`（packageHash `7089eba4ab7d3f5dfc8eaf49904b7367fdcd75db4d978075fa60aee14326744c`）。新增严格策略分支：旧省略 strategy / `screen-space` 保持原合同；`author-selected` 接受 1–8 层、非负安全整数 revision、非递减有限 distance、0–1 hysteresis、严格递增 selectedLevels（可空/多选），拒绝未知字段/策略和重复 JSON 键。每层几何驻留、材质特性验证，主几何固定第 0 层。

`native_gpu_lod_v1.wgsl` 的同一生产 compute 为主画面和 4 个 CSM 视图直接发射所选层，不执行相机像素阈值/texel/历史滞回重选；各视图仍独立视锥裁剪。批次身份包含 author revision/选择/参数。修复原 `lod_changed` 相等比较方向反转，选择变化会使阴影失效。Viewer CPU 拾取只检测当前 author 所选几何，保留原 instance ID；空选不命中，多选取最近交点，旧 screen-space 行为未改。

验证结果：共享合同/准备/变化测试 3 项通过，旧 LOD 合同 11、准备 7、bounds 4、shadow 分类 10 项通过；拾取 7 项通过（含零选/低层/多选最近命中/修改选择后重测/无效索引）。RTX 4060 / Vulkan 真 GPU 上 author 主 HDR 字节和 4 层深度与直接展开所选几何逐值相等；同组旧 LOD/表面标志 GPU 共 4 项全部通过。显式 1 字节 GpuSceneCache 驻留预算实测拒绝候选发布且 live bytes 保持 0，所有几何仍受原预算约束；展开可见槽上限仍为 1,048,576。

本批 `cargo test --locked --all-targets` 全通过；之后拾取增量 7 项和 GPU 4 项再次通过。严格 clippy 仍失败于 P3 `chart/chart_ir.rs:277`；仅诊断允许既有 `collapsible_if` / `needless_borrow` 两类后的全目标 clippy 通过。未修改 P3、TS 或冻结 ZIP；生产 flag 是否启用由主线程跨端合流验收决定。此结果只覆盖 LOD 执行切片，不代表全 P1 或产品视觉评分通过。

## Asset Package 完整目录自动 LKG（仅源码）

`--asset-package` 已接同源完整目录恢复：主 manifest 和所有 chunk 通过目录校验后保留本次原始 bytes；首次 GPU 提交校验 clean 并成功 present 后，写入 `%LOCALAPPDATA%/DeepEngineNative/asset-recovery/<source-path-sha256>/` 中的完整快照，调用同一目录验证器再次检查全部 chunk/DAG/license，再原子发布来源绑定索引。普通预检不落 LKG。后续进程遇到主 manifest/chunk 损坏，只恢复同源索引指定的快照，所有内容与许可证均重新校验；控制台和标题提供恢复原因。该索引不与 Runtime Package 的单文件索引混用。

写锁隔离并发；同 manifest 且完整快照仍有效时复用。失败写入不污染旧 active 或当前 GPU 场景，自己的新候选只按已知生成文件清理，不递归删除。成功发布后保留 active/上一版，退休已验证旧生成目录，未知文件/源文件不删除，无法退休会报告。恢复字节在准备后释放，成功源的待保存快照在呈现后释放。

`asset_package_recovery` 4/4 显式含真实 GPU 测试通过：独立进程呈现保存→主 manifest 损坏重启恢复→主 chunk 损坏重启恢复；缓存 LICENSE 篡改拒绝、另一来源不兜底、恶意 Unicode snapshot 索引拒绝；headless 不生成成功记录；不可写缓存仍正常呈现；只读 active 索引导致发布失败时旧索引/快照不变且候选清理，随后仍能恢复旧场景。冻结 ZIP 未重打，P1-01 的完整 provenance/迁移/分离几何纹理执行等原待办不变。

本批最终 `cargo test --locked --all-targets` 退出 0，目录原回归显式 GPU 5/5，恢复 4/4；仅允许既有 P3 两类 lint 的全目标 clippy 通过，严格门禁不改口径。新增恢复文件 248/67 行，CLI 集成不触及 LOD 或 P3。冻结 ZIP SHA 仍为 `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe`。

## Asset Package 目录主链（仅源码，冻结 ZIP 未更新）

新增 [Native Asset Directory Profile v1](../../packages/deep-engine-native/docs/asset-directory-profile-v1.md)，不修改既有 TS v1 字段。`--asset-package` / `--headless-asset-package` / `--smoke-asset-package` 读取完整 `manifest.json` 与 `blobs/<sha256>`。Rust 验证来源/导入器/compatibility evidence、唯一 ID/逻辑路径、DAG、重复键、预算、Windows NFC、目录 reparse/ADS/跳转；所有声明 chunk 实际长度/SHA-256 与 256 MiB 合计预算全部通过后才选 entryScene。明确 scene MIME 为 `application/vnd.deep.runtime-package+json`，再交已有 Runtime Package 验证和 Player，不把 Runtime Package 改名。

共享夹具 `packages/deep-engine-native/tests/fixtures/asset-directory-v1/manifest.json`：SHA-256 `e2f1f9489c8b6be4d82d1e0c8f365fae9d171df9564869ed13478fa3ef56c008`，3 个 chunk/14,452 bytes。场景为已有第一方 Runtime Package；另外两块为真实仓库 LICENSE 文本及严格版本化 license evidence，关联 packageId/sourceHash/resourceIds/licenseTextHash 和资源依赖。依赖顺序为 `metadata/license-text → metadata/license → scene/main`。许可证证据绑定不替代正式 provenance/migration 合同。

验证：Deep TS 当前源码 build 通过，再以其 validator 读取同一磁盘 fixture，检查所有 chunk 和 DAG 顺序，4 个共享非法变体通过。Rust 目录集成 5/5（显式运行真实 Windows GPU）、license source/package/resource/text 绑定负例单测通过。真实 junction blob 目录被拒绝；损坏/缺失/长度伪报/预算/循环/重复路径/NFD/坏evidence均覆盖。`cargo test --locked --all-targets` 通过；随后数字表示兼容补丁的同组 5/5 再过（schema `1.0` 与 TS JSON number 一致）。新增模块全部低于 300 行；没有修改 P3 或 TS 公共字段，没有重打 ZIP。

仍为本轮待办：分离 geometry/texture chunk 被 renderer 真正引用、重导入持久事务、版本迁移与完整 provenance、Asset Package 自动 LKG/拖放入口。此目录 profile 使用自含 Runtime Package 场景，不将独立 license chunk 消费扩大成共享几何/纹理链路完成。

## 普通启动自动 LKG（仅源码，冻结 ZIP 未更新）

普通 `--package` 与其 smoke/headless 变体现在共用自动恢复读取。先用既有有界文件读取和完整 Runtime Package 校验读取源包；源包失败时，按本地绝对来源路径的 SHA-256 查找 `%LOCALAPPDATA%/DeepEngineNative/package-recovery/` 中的索引和已验证快照，再次核对来源、版本、包 hash 及全部包合同后恢复。stdout 提供原始失败和恢复身份；成功呈现后的标题提示已恢复 LKG。

有效源包仅在首帧 GPU 提交检查通过、呈现成功后记入 LKG；headless 预检不会写成功记录。保存的是本次读取的原始快照，不在首帧后重新读取可能已被覆盖的源文件。来源恢复仅支持本地磁盘路径；UNC/设备路径、ADS、父目录跳转、symlink/reparse 路径不参与缓存。普通有效包即使无法建立缓存仍可打开。快照和索引分别 sync 后原子替换，索引最后发布，进程文件锁避免并发 writer；写失败保留当前场景及旧索引。

缓存预算修正：完整验证同 hash 快照后直接复用，按实际新增字节计算；当前候选与上一 active 的保留预算为 512 MiB，不再因旧目录已有 128 项永久拒绝更新。新 active 索引成功发布后，写锁内最多检查 256 项，只退休本 source 目录中 hash 文件名与完整包校验一致、非当前/上一 active 的普通生成快照；再次检查索引、路径和文件类型，源文件、未知文件与坏快照不删除。删除失败报告 `lkg/retirement-deferred`，旧缓存可能暂时超过保留预算，后续提交继续尝试清理。

追加验证 5/5：预算同 hash 300 MiB 算术边界不重复计费（包解析本身仍有 256 MiB 上限）；512 MiB 等值通过、超界拒绝；有效只读快照重复提交证明实际复用；130 版本旧目录在索引写失败时不退休，成功后仅保留当前及上一版，外来文件与源文件原样保留。跨进程真实 GPU CLI 2/2 再次通过；仅放行原有 P3 两类 lint 的全目标 clippy 通过。

验证：`runtime_lkg` 3 项覆盖新实例重开、源损坏、不同来源隔离、坏索引/快照、拒绝路径、只读索引不污染旧记录、writer 竞争后仍可恢复。`runtime_package_lkg_cli` 2 项显式含 GPU 测试通过：独立进程一呈现并保存→源文件损坏→独立进程二自动恢复且真实 GPU 提交 clean；另验证缓存不可写时仍正常呈现、headless 不记成功、无索引/坏索引失败。`cargo test --locked --all-targets` 通过；此后新增的最终测试再单独通过，全目标 clippy 在仅放行原有 P3 两类 lint 下通过，严格门禁状态不改。

本切片不覆盖拖放/热更新的跨进程 LKG 记录、GPU 初始化失败后的自动回退、强制进程终止时未提交标注恢复或系统 device-loss 注入。冻结便携包仍是下文 `6d23a7…` 版本，尚不包含此次自动 LKG。

## 标注可靠性修复（剖切包冻结之后）

打开包、Runtime Package 热更新、RenderPacket 热更新在改变 renderer/content 前检查标注。未完成草稿阻止切换；已提交未保存的标注自动保存，失败保留当前场景与标注。窗口关闭/Esc 和 F9 同样保护。dirty 由当前记录与最后一次成功保存/加载的快照比较，删除也能检测。失败保存不改变快照。用户结束或取消草稿后可重试切换。

按本地 winit 0.30.13 的 `Ime` 合同及 Windows `WM_IME_COMPOSITION` 实现处理 Enabled、Preedit、Commit、Disabled：预编辑文字独立显示，不写入标注；组合期间不响应 Enter/Esc/Backspace/普通字符；Commit 才追加文本；Disabled 清空预编辑。设置系统候选框锚点。没有基于猜测增加 Commit 去重逻辑。真实窗口事件探针覆盖组合期间快捷键、空 Preedit→Commit→Disabled、未提交组合取消，随后验证中文记录原子保存与恢复；不是系统输入法人工验收。

验证：标注单测 4/4，包含 dirty 保存失败保留、成功重试、删除持久化及草稿保护；`cargo test --locked --all-targets` 退出 0；实际 RTX 4060/Vulkan 选择探针通过。仅允许已有 P3 两类 lint 的全目标 clippy 退出 0，严格门禁状态不变。自有文件最大值仍不超过 300 行。

修复版交付包：`packages/deep-engine-native/artifacts/windows-portable-annotation-reliability/deep-engine-native-0.1.0-x86_64-pc-windows-msvc.zip`，3,836,346 bytes，SHA-256 `6d23a7e530112535b4e79027cc22c05fd43a98cb7c65640aa3cbb160db4944fe`。EXE 10,030,080 bytes，SHA-256 `72fb2bf62f0d52bd42558f6e0e99791f64317a6da5ee7a191cd2581121e8940b`；输入指纹 `bd3ed07e891142dd9167db2b7832079897977055f7f25b8923c28848b7a6862d`。构建及 Windows PowerShell 5.1 独立解压复验均为 17/17，35 files，purity 通过；真实窗口探针输出 `ime=preedit-commit-disable draft=protected`。解压验证目录为同输出根下 `verified-16115078eb524ba6976cdef21b30b797`。此前冻结包保持不变。

剖切包冻结身份：ZIP 3,825,486 bytes，SHA-256 `767bccbd9c8973fe83e61f3475bd7f8ad67aaad9d1aaeca76a6cc9148bf34f39`；EXE `5732061caeb1f257a06a9c759014a86406a74535aae74ea1917247e327d08733`；输入指纹 `91dd38586d73bf3ae079f9d25295476f8242525aede1c544ca6de0ac20e29b7f`。独立解压目录 `packages/deep-engine-native/artifacts/windows-portable/section-check-0e36bf08b57242ba81869bf08caf2081` 验证 17/17、35 files、9 embedded shaders、purity 通过。额外显式运行 GPU LOD / ShaderPackage 的 5 个 ignored 测试全部通过，包括自定义包与内置 ABI 分离、HDR 和四层 CSM 精确比较。此包尚未包含后续标注 dirty / IME 修复，不作为标注产品闭环。

## 21:38 剖切与持久标注增量

已接入实际 Viewer 键盘剖切：C 开关、X/Y/Z 平面轴、PageUp/PageDown 以 0.1 场景单位移动、方括号绕固定对角轴旋转、Backspace 重置。法向每次旋转归一化，位移限制 ±1,000,000。原生独立 `group0/b8` 16-byte 平面保留既有 208-byte Frame ABI，不改 Browser/RenderPacket 合同。主 fragment、solid/MASK caster 使用同式裁剪；平面变化使阴影缓存失效。拾取过滤被裁区域，并匹配单面材质背面剔除；测量复用该命中结果。

自定义 ShaderPackage 的版本化布局保持原有 8 项绑定；该场景请求剖切时明确提示 unavailable，不静默留下未裁阴影。最终打包曾发现内置新增绑定误入自定义包，已分离两条绑定路径；自定义包真 GPU 首帧复验通过。

`--smoke-section` 在实际三帧间执行产品剖切控制，读取 HDR 像素和全部 CSM 深度：

| 固定夹具 | 开启：HDR 改变像素 | 开启：阴影改变像素 | 关闭后与原帧差异 |
|---|---:|---:|---|
| render_packet_v1 | 705 | 937,719 | HDR 0 / shadow 0 |
| render_packet_alpha_v1（含 MASK/BLEND） | 307 | 253,354 | HDR 0 / shadow 0 |

标注：选择对象后 A 开始文字输入，Enter 提交、Esc 取消；F5 保存、F9 恢复、Tab 跳转、Delete 删除当前标注。位置为真实命中的世界坐标，身份为作者对象 ID。侧文件位于 `%LOCALAPPDATA%/DeepEngineNative/annotations/`，按包身份及场景内容指纹隔离，不写入项目包。文件上限 1 MiB/1000 条/每条 256 字符；有限坐标、版本、场景和对象存在性校验通过后才替换内存记录。保存使用独占临时文件+sync+原子 rename，失败保留旧文件；损坏或跨场景文件加载失败保留当前记录。

新增持久化测试覆盖中文往返、重复保存、坏文件/错场景/失效对象拒绝、NaN/长度/数量和临时文件冲突。选择 GPU 探针新增标注输入提交及真实文件恢复断言，输出 `annotations=persisted`。系统中文 IME 和可见标题编辑尚未人工遍历；标注当前为窗口标题与相机跳转，未制作场景 billboard。标注需 F5 才持久保存，切换包会清理当前内存记录。

`cargo test --locked --all-targets` 再次退出 0；后续自定义 ShaderPackage 的绑定修复已独立 GPU 复验。严格 clippy 仍受前述 P3 两项阻断，临时允许这两类 lint 的全目标检查通过。自有文件按职责收口：cli 297、renderer/init 297、renderer 294、shadow_map 282、shadow_probe 280、标注控制 156 行；未修改 P3。

当前仍未通过产品两轮可见窗口截图与 Kimi-95 评分；剖切不生成封口面，标注未完成可视锚点和系统 IME 人工验收。P1-04 整体仍有告警、连续运行资源回落等待办。

## 21:17 交互切片增量

已将对象选择、相机聚焦和两点测距接入实际 Viewer。左键三角形命中取得作者 `instance.id`，窗口标题显示选中对象；相机中心与距离同步到 frame uniform、CSM、GPU culling 和 LOD。空白点击取消；成功打开新包重置视角；包/packet 发布清理选择和测量锚点；Home 恢复默认视角。GPU 重建保留 CPU 相机状态。

M 切换两点测距。点击两个真实三角形上的世界坐标后显示距离，第三次点击开始下一组。单位明确为 scene units，未假定包坐标等于米。测距点击保持相机不动。

验证：新增 5 项拾取单测覆盖身份、最近深度、实例变换、聚焦旋转与窄视口一致性、空白/无效索引/NaN/零尺寸/近远裁剪/退化三角形；测距测试覆盖两点、重新开始、禁用和 NaN。`cargo test --locked --all-targets` 退出 0；聚焦 player_* 测试 9 项通过。`--smoke-selection` 在 RTX 4060 / Vulkan 实际两帧间投递 CursorMoved/MouseInput 到产品事件处理器，验证 `golden-instance` 选择、聚焦帧提交、空白取消和两点距离 `0.031515 scene units`，GPU scopes/callbacks clean。包发布清理函数由探针断言，实际拖包交互尚未人工遍历。

严格 clippy 尚未通过：`chart/chart_ir.rs:277 collapsible_if`；临时在命令行放行该诊断后发现 `deep2d_gpu_cache_tests.rs:207 needless_borrow`。两处均属 GLM P3，未修改。仅为检查其余代码而放行这两类 lint 的 clippy 全目标检查通过，不替代正式门禁。

新增交互使用原生窗口标题，没有新增 GUI 或修改 P3。当前选择是基础几何三角形拾取；尚未实现透明纹理像素级命中、LOD 最终选中层几何对齐、选中描边与测距连线。未进行大模型拾取性能或两轮产品截图验收；P1-04 仍有剖切、标注、告警及长稳等本轮待办。

21:18 最新交互包已构建并单独解压复验，15 项全部通过；新增 `viewer-selection-measurement` 真 GPU 门禁。当前同名 ZIP 已替换为新包：3,789,898 bytes，SHA-256 `b2d7c066bc972dd5461a06291da23143fee98553e3f481adf1ac3962d006ca0d`。EXE 9,932,800 bytes，SHA-256 `b2bf867f0e8e28a7338de2f1dedc42f218ac790f052ced93bd8af83a98f287a8`。输入指纹 `00c018b8f9c3b572e21e030d10f622672e46578451786a4c806edad99dfb7641`。独立解压目录：`packages/deep-engine-native/artifacts/windows-portable/selection-check-6d28a38a4812455dbe008205b559d631`。

下面保留 21:05 基线及旧包身份；旧 ZIP 哈希不再代表当前同名产物。

2026-09-14 21:05，北京时间。P1 整体为本轮待办；本次完成便携包候选与故障检查，不代表 Viewer 全功能完成。

## 已完成

- 从当前 Native 源码构建 Windows x64 release、static CRT EXE；portable purity、9 份内嵌 WGSL 原文、35 项 payload/ZIP 哈希一致性通过。
- 修复 portable smoke 无截止时间：每项最多 60 秒，超时终止子进程；并发排空 stdout/stderr，保留退出码、UTF-8 文本和耗时，子进程不创建控制台窗口。
- 新增 3 项打包门禁：坏主包回退至 last-known-good；主包与备份均坏时退出 1；GPU 运行中合法热更新后拒绝坏候选并保留最后正确帧。与原 11 项合计 14 项通过。
- 从 ZIP 新解压到独立目录后，重新验证 14 项和所有文件哈希通过。Windows PowerShell 5.1 再验同一包通过；进程参数转义、Unicode、stderr、非零退出、超时回归在 PS5.1 与 pwsh 双通过。

本机：NVIDIA GeForce RTX 4060 Laptop GPU；wgpu Vulkan；surface Bgra8UnormSrgb；rustc/cargo 1.93.0。GPU smoke 为 64×64 离屏位置窗口，不是产品画质截图。

## 产物身份

路径以仓库根目录为基准，生成产物在忽略目录中，不提交二进制。

| 产物 | 路径 / 身份 |
|---|---|
| ZIP | `packages/deep-engine-native/artifacts/windows-portable/deep-engine-native-0.1.0-x86_64-pc-windows-msvc.zip` |
| ZIP 大小 / SHA-256 | 3,779,883 bytes / `ce3b02a8797f84cda20294c14f115273f0d79255687e7fcf03dfb4266a6489eb` |
| EXE | 同名解压目录下 `bin/deep-engine-native.exe`，9,904,128 bytes |
| EXE SHA-256 | `a0e53a25c9b34172dd6e5e8aaf8a3235fcb461488e80683fcc8d31f7378cec87` |
| 源输入指纹 | `0509031b4c6bb30b28f3fd748bc8a134571aa5db60c58188382dadcc13df3466` |
| 供应链证据 | `licenses/rust-sbom-input.json`，88 个组件、89 条依赖关系、233 个构建输入；这是 SBOM 输入证据 |
| 新解压验证目录 | `packages/deep-engine-native/artifacts/windows-portable/extracted-check-67277ff5d1b64ae7b6cbc67ca42ff926` |

`manifest.json` 保存每项 smoke 证据和耗时。坏备份检查的退出 1 是预期成功条件。

最短复现：

```powershell
& packages/deep-engine-native/scripts/package-windows-portable.ps1
& packages/deep-engine-native/scripts/verify-windows-portable.ps1 -PackageRoot packages/deep-engine-native/artifacts/windows-portable/deep-engine-native-0.1.0-x86_64-pc-windows-msvc
```

解压后 `Run-Viewer.cmd` 打开冻结 Runtime Package；自带 EXE 可用 `--package <文件路径>` 打开其他已支持包。运行中的 Viewer 接受拖入 Runtime Package JSON。

## 本轮待办与集成阻断

| 项目 | 本次核对结论 |
|---|---|
| P1-01 统一资产包 | 当前交付为已有 Runtime Package golden；完整内容寻址 DAG、GUID、迁移与重导入矩阵未在本次完成 |
| P1-02 原生 3D 对齐 | PBR/LOD/纹理/Shader/CSM/IBL 固定夹具真 GPU 通过；Browser/native 全材质动画画质矩阵未通过 |
| P1-03 HostCapabilities | 已有异步拖包、迟到隔离、失败保留；完整 HostCapabilities、持久缓存和崩溃恢复产品闭环未完成 |
| P1-04 Viewer | `app/window_events.rs` 现有方向键仅左右旋转，R 重建、Esc 退出、拖包；选择、剖切、测量、标注、告警和连续导航资源回落尚无完整产品链证据 |
| P1-05 Windows | 本机便携候选与解压校验已完成；安装/卸载、签名、更新回滚、AMD/Intel/DX12 矩阵未通过 |

主线报告 `pnpm gate:deep-p0:native` 中 cargo test/fmt 已过，但 clippy 阻断于 GLM P3 文件 `src/chart/chart_ir.rs:277` 的 `collapsible_if`。本工作未修改 P3 文件，不能将整体 Native 门禁记为通过。

本次只改打包执行和验证脚本，保留所有并行源码改动。已读 `design-taste-digitaltwin`；Unity / ThingJS / 西门子对标仍适用于 Viewer 验收。本次无视觉改动、无两轮产品截图；10 维视觉评分均未评，不能记 Kimi-95 或 P1 画质通过。
