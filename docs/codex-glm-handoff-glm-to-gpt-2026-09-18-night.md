# GLM → GPT/Codex 主线交接（2026-09-18 深夜终版）

## 承接规则（不放宽）

1. 先读 `docs/active-task-recovery-ledger.md` + 本文 + 引用 spec；**先查证据再动手，禁止重复建设**（`bim-studio/AGENTS.md` 已有强制防重复门禁，2026-09-18 生效）。
2. 每个任务必须留：产物、命令与数字、证据路径、剩余边界；不得以单测绿冒充产品验收。
3. 用户长期要求：极速并行推进、最高质量、不偷懒不虚报；磁盘不足时自主清理历史测试符号/缓存；提交按功能切片自主管理（AGENTS.md 2026-09-15 授权仍有效）。
4. 工业格式硬门槛、X_T 命名、自研/开源本地离线路线不变（AGENTS.md 工业节全文有效）。

## 本会话已提交切片（全部带真实证据）

| commit | 内容 | 证据 |
|---|---|---|
| `ec9b706`(外层 bim 仓) | 工作区 AGENTS.md 加执行纪律 | — |
| `b02c83b` | **Deep2D 表格链全收口**：位置无关压缩 146→90 资源(预算 132 未放宽,R9c 严格绘制流证明)、C4/C5 双编译一致性(测量缓存漏 filterData + 布局双捕获两根因)、R10g 正式候选 201+8 过滤窗、真实排序 CSV/XLSX 逐字节导出×2 轮+取消窗(GetGUIThreadInfo 焦点 WM_SETTEXT 自动化) | `test-output/dashboard-table-production-r10g-20260918/`、`dashboard-table-window-r10g-*-r19.log`、spec `deep2d-table-interaction-2026-09-18.md` |
| `4a5d6d9` | **工业 S0 收口**：13 分发物 99.99MiB 预算对照、10 CLI 冷启动三轮、9 exe 静态无网(网络 DLL 0 导入)、四组许可闭包 | `industrial-s0-install-size-coldstart`/`industrial-s0-license-closure-2026-09-18.md`、`test-output/industrial-s0-install-coldstart-20260918/` |
| `01d5036` | **Engine Fog 收口**：solid-environment v7 author fog 解析(fail-closed)、authored_exp2 进渲染(content_profile/drop_preview 守卫)、legacy 输出雾 shader 动态 near/far、CPU 公式对齐 Three FogExp2 | lib 401/bin 140/clippy 0/GPU 三证(changed=47723 像素方向性验证等)、`test-output/fog-authored-20260918/` |
| `5b5af78` | **GI 跨端阈值矩阵**：同 GLB 同机位同光照,Chrome WebGPU vs Native 成对采图+差异图 | `scripts/verify-gi-crossend-matrix.mts`、`test-output/gi-crossend-matrix-20260918/`(off: SSIM .238/MAE .077/PSNR 21.7;on: .063/.175/12.3;结构对齐,残差=GI 亮度标度+噪声) |

## 进行中（半成品，接手注意）

### 1. 场景剖切接线（接近完成，差最后一跑）
- **已完成**：相机合同 v3(`clippingPlane` 可选,TS/Rust 双端校验+测试全绿:TS camera.test、Rust runtime_camera 4/4、web 37/37、native lib 402);`compileSceneCamera` 发 v3+plane;`sceneInactiveFields.compiledClippingPlane`(axis/face 编译,box 保持 deferred);编译证据字段 `deep.scene.section-plane.v1`;Native `PlayerView::from_camera` 消费 plane 进 `view.clipping`(mesh shader section_rejected 早已存在,键盘 C 键路径未动)。
- **构建已绿**：deep-engine dist、API(含场景编译器 bundle)、native debug exe 均已重建支持 v3。
- **卡点**：`scripts/verify-scene-clipping-e2e.mts` 报 `Non-JSON value or cyclic input`(nativeSceneCandidateCompiler.ts:96 worker 边界)。**非剖切逻辑问题**——单测证明 `compileSceneCamera` 输出正确 v3 `[0,0,1,-1]`;复现命令因 tsx -e 的 top-level await+CJS 报错不可用。下一步:在 e2e 脚本里先 `console.log(JSON.stringify(scene))` 或直接调 `compileSceneRuntimePackage`(写成临时 .mts 文件而非 tsx -e)定位哪个字段非 JSON——怀疑 fixture 里 `models:[]` 空+`loadModel` 返回空 Uint8Array 的组合走了特殊路径,或 `structuredClone(scene)` 后 `clipping` 某可选字段 undefined 键。修好后断言:clipped vs open 像素必须不同(脚本已写好 changedBytes>10000 断言+两轮稳定性)。
- 文件:`compileSceneCamera.ts`、`sceneInactiveFields.ts`、`compileSceneRuntimePackage.ts`、`camera.ts`、`runtime_camera.rs`、`player_view.rs`、`verify-scene-clipping-e2e.mts`(均未提交)。

### 2. 发布链 OS 级证据（部分完成）
- 已采:3 个场景 EXE×隔离 LOCALAPPDATA/USERPROFILE 启动 6 次(`test-output/scene-publish-offline-20260918-main/evidence.json`,含毫秒数)。
- 未闭:netsh 防火墙规则需管理员权限(exit 1),OS 级禁网如实保留未做;干净安装/卸载/用户数据保留语义未验。

### 3. V11 Kenney Nature Kit(审查半程)
- `nature.zip` 10,537,521B SHA fa7974a0…,CC0,329 GLB 全 v2 长度匹配;48 代表模板已筛(trees/shrubs/fences/ground 各 12,`test-output/de26-v11-nature-review-20260918/evidence.json`)。
- 剩:几何/单位/落点/缩略图/产品内拖放验证;`sync-open-asset-packs.mjs` 同步入库。

## 未动队列(按优先级)

1. **动态场景其余**(B3):剖切收尾后→轨迹动画/dataBindings/interactions 接线(审计结论:runtimePackage 已有动画位,`sceneInactiveFields` animation/dataBindings/interactions 仍 deferred;Native 侧 scene-director-timeline/shared-scene-script-protocol 内核已有证据,先查再接)。
2. **GI 一致性收敛**(B2 延伸):矩阵已建,残差=引擎间光照标度差;终门前需统一曝光归一化口径或引擎侧对齐,属终门数据基础。
3. **D24-D28 项目级后验收**:三套 50 万三角资产、20 分钟稳定/故障门(不能用单 feature 证据替代)。
4. **工业 S1-S6 差额**(stage-delta 表):S1 跨实例取消转发+多实例矩阵;S2 JT LOD/3DM 44 非共形边;S3 点云合同/Tiles 运行时;S4 X_T 79 零面积三角;S5 RVT 结构机电/SW 三来源装配;S6 七方向版本保留集+混合发布。
5. **DE26**:V1-V11(V12 不做);readiness-inventory 待办表为权威。
6. **终门**(用户指定,最高优先):WebGPU 客户端 vs 网页端 2D/3D 全量验收=一致性+性能+视觉,对标 Three/Babylon/Unity(引擎层/渲染后端层分开声明);P0-08 SSIM 口径+GI 矩阵是数据基础,3D 全局 SSIM 阈值需换分窗口/曝光归一化设计。

## 环境与坑

- **dist 过期是本日最大时间黑洞**(3 次):API/验证器按生产条件解析 workspace dist;**改 contracts/deep-engine src 后必须 `pnpm --filter @bim-studio/api build`**,否则现象是 Unknown field/Non-JSON 等误导性错误。
- 子代理曾因 5 小时额度上限(23:30 重置)与 OAuth token 失效两次退出,无残留产物;额度已解除限制,仍按"先查证据"纪律用。
- `verify-dashboard-table-window.mts` 对话框自动化已内置(GetGUIThreadInfo/WM_SETTEXT/EntryPoint=SendMessageW),复跑注意 PS5.1 C# 编译器不吃 let-chains/弃元,rustfmt 用 --edition 2024。
- cargo fmt 全仓有历史未格式化文件,勿整仓格式化混入他人改动;只 rustfmt 本切片文件。
- 深夜环境:Chrome 路径 `C:\Program Files\Google\Chrome\Application\chrome.exe`、RTX 4060 Vulkan、DPI 120。

## 证据总入口

`docs/specs/deep2d-table-interaction-2026-09-18.md`(表格)、`industrial-s0-*`(S0)、`deep-engine-mainline-remaining-audit-2026-09-18.md`(Fog 节已更新)、`scene-native-baked-gi-consumption-2026-09-18.md`(GI 矩阵节)、`test-output/gi-crossend-matrix-20260918/matrix.json`。
