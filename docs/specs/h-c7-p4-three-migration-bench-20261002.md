# H-C7-P4:Three 高频迁移 20 题基准(2026-10-02,主线程第一刀)

## 定位与现状核查

- 已验底座(不重建):`three-author-parent-migration.mts`(Box/Sphere/Group/Standard/directional+point/50° 相机桥直接 Node 过)、`scripts/native-author-parent.mts` CLI(提交/取消/CAS 三项)、SDK 命令合同(object.create/delete/set-parent/set-visibility/set-transform/material.set/camera.set/fly-to/selection.set/animation.control/data.apply/component.update)、混批图元删除(2026-10-02)、编辑器保存/撤销/快照链。
- P4 真实缺口=**可运行迁移交付与真实任务证据**,不是再建 Three 投影。本文件定义 20 题基准:每题=Three 惯用任务 → Deep 原生等价 → 可判定验收门。任意 addon/GLSL 不承诺自动兼容(沿主计划边界)。
- 题目状态:ready=依赖命令与宿主已齐(不是验收通过);done=已注明口径的证据落盘;partial=部分原门通过但仍有精确缺口;blocked=验收入口/依赖或允许运行窗口未满足。
- 六步核查与本批证据/根因修复分章记录见 `docs/specs/hc7p4-ready-evidence-20261002.md`；root 账本只读，非本线回填目标。

## 计数校准（每题只占一行）

- 全表 **20 个唯一 ID**，A/B/C/D 各 5 行；补齐历史错位的验收门/状态列，不把组合证据或共享测试重复算题。
- root旧枚举“A1/A2/A3/B3/B4/B5/C1/C3/C4/C5/D2/D4/D5”实际 **13题**，不是11题；root原文不改，本表校正。
- 本轮按每行已注明的完成范围：**done 17 / partial 1(B1) / blocked 2(D1/D3) / ready 0**。这不是20题GPU全门已关：CPU/合同/组合子范围不升格成GPU、Tween、100盒或双端HDR认证。
- 五ready题本批结论：A4/A5/B2/C2 done、B1 partial；C2/B2共用两fresh的42检查只计两个题，不计为84个独立案例。

## A 组:场景生成(5 题)

| # | 任务 | Three 惯用写法 | Deep 原生等价 | 验收门 | 状态 |
|---|---|---|---|---|---|
| A1 | 百盒图元阵列 | `for` + `new Mesh` ×100 + `position.set` | 单事务混批 100×`object.create-primitive`+`object.set-transform` | 对象集/坐标逐值一致;同事务原子回滚 | done(CPU 样例):25 盒 50 命令 committed 单收据、坐标逐值一致(≤1e-12)、幽灵毒丸 rolled-back 零残留(`samples/a1-primitive-array.mts`,a1-result.json PASS;不是100盒实测) |
| A2 | 层级组装(机械臂 6 节) | `Group.add` 嵌套+局部变换 | create 链+`object.set-parent`(keepWorldTransform 双模式) | keepWorld 双模式逐值一致;循环父级拒绝 | done(CPU 样例):keepWorld false 末端 worldMatrix 与 Three 逐值一致(≤1e-9)、keepWorld true 重父级前后逐位不变、循环父级 rolled-back(`samples/a2-hierarchy.mts`,a2-result.json PASS) |
| A3 | 参数化楼梯(50 级) | 循环 box+增量 y | 混批 create+transform,批量增量坐标 | 对象数/包围盒/100% y 单调;同事务原子回滚 | done:**64 命令上限真实约束验证**——100 命令拆 3 事务序列(tx1 committed→tx2 注幽灵 rolled-back **仅自身回滚 tx1 保留**→tx3 重试 committed),50 级 y 单调+坐标逐值一致+ghost 零残留(`samples/a3-stairs.mts`,a3-result.json) |
| A4 | 场景快照往返 | `scene.toJSON`→重新 import | 保存项目→重开场景(useAppSceneSyncEffects→applyScene) | 重开后对象集/材质色/层级/变换与保存前一致;revision 前进 | done(正式入口+既有浏览器):5文件39/39，新增原入口save→JSON→applyScene local revision 3→4恰1次；既有两轮1模型+2图元/2成员编组保持。证据 `test-output/three-migration-bench-20261002/ready-evidence/a4-result.json`，旧浏览器非fresh范围见报告 |
| A5 | 替换流(删旧建新同事务) | `remove`+`add` | 混批 `[create X, delete Y]` | committed 后 X 在 Y 无;失败注入→Y 恢复(快照)+X 移除(逆算子);同 ID 微任务替换保留用户对象 | done(正式CPU):editorPrimitiveDeletion 11/11，混批committed/幽灵rolled-back/同ID微任务保护全部值级通过；`failed/rollback-failed`保护新对象不伪称回滚成功。证据 `test-output/three-migration-bench-20261002/ready-evidence/a5-result.json` |

## B 组:视觉修正(5 题)

| # | 任务 | Three 惯用写法 | Deep 原生等价 | 验收门 | 状态 |
|---|---|---|---|---|---|
| B1 | 材质升级 clearcoat | `MeshPhysicalMaterial` 替换 | `material.set` + I23 分层 | 作者状态保存重载一致;活动层参数 fail-closed 拒未支持扩展 | partial:既有正式31/31(I23守卫绿)，material.set无clearcoat/编辑器v2→adapter clearcoat v3→runtime仅v2仍阻断；非clearcoat v2持久化不能替代。证据 `test-output/three-migration-bench-20261002/ready-evidence/b1-result.json` |
| B2 | 颜色分级 | `renderer.toneMappingExposure` | studioUngradedColor+colorAdjustment userData 链 | 恢复后分级参数保持;zero 调整逐位恒等 | done(根因修+正式CPU/双fresh):原25/25+material runtime6/6，3线性色9通道zero F64逐位恒等及graded错误基准负控；两轮42/42共同门，保存base #D4A84F/0.35/-0.30，重载display #E5C490恒等，zero回base。证据 `test-output/three-migration-bench-20261002/ready-evidence/b2-result.json` |
| B3 | 批量显隐 | `mesh.visible=false` ×N | 混批 `object.set-visibility`(scene/mesh/object 三档) | 隐藏/保留集合精确;失败回滚 | done(CPU/合同面):12 对象混批定向隐藏 6+保留 6 精确;scene 级=总开关语义(不覆盖对象级显式隐藏)伪 driver 建模;回滚恢复(`samples/b3-c1-visibility-selection.mts`;mesh 级合同=宿主域) |
| B4 | 相机巡检飞行 | Tween position/target | `camera.fly-to` | camera.set 终值一致;场景不匹配拒绝 | done(CPU/合同面):camera.set 终值 pose 逐值;fly-to 记录+场景不匹配 rejected(`samples/b4-c4-c5-camera-regen-data.mts`;不是完整Tween浏览器门) |
| B5 | 雾/环境切换 | `scene.fog`/`scene.environment` | 作者状态(雾/IBL) | 作者档保存重载+命令面;双端 HDR 门沿既有 I-C21/I-C23 底座另计 | done(已批准历史验收复用):P4-B5两轮21/21、4事务committed/轮、10图；lighting/environment/weather保存重载保持。真实报告 `test-output/p4-b5-lighting-20261002/round{1,2}/report-round{1,2}.json`；本批只引用，未新证双端HDR |

## C 组:交互与编辑流(5 题)

| # | 任务 | Deep 原生等价 | 验收门 | 状态 |
|---|---|---|---|---|
| C1 | 拾取高亮 | `selection.set`+`material.set` | 选中态可逆;失败回滚选区 | done(CPU/合同面):选中 b7/b9 高亮→切换选中 b8→b7 恢复原色;幽灵 selection 注入→rolled-back 选中态不变(`samples/b3-c1-visibility-selection.mts`,b3-c1-result.json) |
| C2 | 撤销重做链 | history 事务(已有 Ctrl+Z/Y) | 10 步编辑全链可逆;较新 revision 拒恢复 | done(根因修+正式CPU/双fresh):history32/32(local CAS+失败/重复/新分支)，原runner两轮42/42共同门各10编辑→10undo→10redo，TRS/分级参数/renderedColor严格同相位，重按0；旧37控件绿但色漂移只保partial。证据 `test-output/three-migration-bench-20261002/ready-evidence/c2-result.json` |
| C3 | 批量重父级 | 混批 `object.set-parent` | keepWorld 逐值;循环/奇异拒绝 | done(组合证据):A2 已验单条 set-parent keepWorld 双模式逐值+循环拒绝(graph CLI 同路径);A1 已验混批机制;SDK 批量重父级=两者组合,无新机制(组合证明见两样例) |
| C4 | 参数化重生成 | 混批 `[delete Y, create X]` 同 ID 语义 | 同ID新定义保持;失败回滚恢复旧定义 | done(CPU/合同面):同 ID box→sphere 重生成属性为新定义;再删除+幽灵注入→rolled-back→sphere 定义恢复(`samples/b4-c4-c5-camera-regen-data.mts`;微任务替换=浏览器域已有专测) |
| C5 | 数据驱动更新 | `data.apply` | values与时间戳保持;缺失目标回滚 | done(CPU/合同面):values 传播到目标对象记录+时间戳留存;缺失对象→rolled-back(`samples/b4-c4-c5-camera-regen-data.mts`) |

## D 组:性能基准(5 题,全部量化的既有底座复用)

| # | 任务 | 验收门 | 状态 |
|---|---|---|---|
| D1 | 1000 独立 mesh vs Deep 合批 draw 数 | 渲染统计读数;batch 削减比登记 | blocked(渲染统计用户面=H-C5-K17) |
| D2 | 视锥剔除帧收益 | 离屏对象 GPU 绘制 0;帧时登记 | done(CPU 侧):1000 对象两档相机,octree queryFrustum 与全扫 aabbIntersectsFrustum 集合逐 id 一致(far 0%/near 41.8% 剔除);耗时参考:octree 0.41-0.59ms vs 全扫 0.23-0.26ms——**1000 对象规模全扫更快**(树遍历开销>暴力),octree 收益点在更大规模/更高剔除率,如实登记(`samples/d2-frustum-cull.mts`,证据 d2-result.json;GPU 绘制 0 证据归 T26/渲染统计域) |
| D3 | 首帧时间(Three 冷启 vs Deep runtime 包) | 两端 p50/p95 帧预算内登记 | blocked(本批帧时禁止；旧B2 1763.5ms单底座不能替代两端p50/p95门) |
| D4 | 10k 对象事务提交时延 | submit 延迟登记(47.4→2.2ms 底座) | done:10,016 对象/313 事务全 committed,SDK 层 prepare p50 0.146ms/p95 0.365ms、commit p50 0.005ms、墙钟 56.1ms、≈17.9 万对象/s(`samples/d4-transaction-throughput.mts`,口径=sdk-transaction-layer-cpu 非引擎 submit 层,证据 d4-result.json) |
| D5 | HLOD 代理切换 | 10k→代理削减率+轮廓 0px(97.6% 底座) | done(CPU 决策面):10k 实例→13361 节点/代理批 3361(削减 66.4%,按全父层目标);decideHlodFrame 近档全展开/远档折叠 84.36%(rendered 1564),滞回稳定;GPU 轮廓 0px 归 T26 渲染域(`samples/d5-hlod-proxy-switch.mts`,d5-result.json) |

## 运行方式

- CPU/Node 级样例:`packages/deep-engine/examples/three-migration-bench/samples/*.mts`,`node --conditions=development --import ./apps/api/node_modules/tsx/dist/loader.mjs <file>` 直跑;输出 JSON 证据到 test-output/three-migration-bench-20261002/。
- 浏览器级题目(A4/B1/B2/C1/C2):验收入口=既有正式测试文件+编辑器产品链,不新建第二宿主。
- 每题完成一行回填:实测数字+证据路径;不虚报 ready→done。

## 第一刀样例(本批交付,实测双 PASS)

- `samples/a1-primitive-array.mts`:**PASS**——50 命令混批(25 create+25 transform)单收据 committed,对象数/坐标与 Three 侧逐值对拍(≤1e-12),幽灵对象毒丸注入→rolled-back 零残留。证据 `test-output/three-migration-bench-20261002/a1-result.json`。
- `samples/a2-hierarchy.mts`:**PASS**——6 节机械臂 keepWorldTransform:false 重父级后 graph 末端 worldMatrix 与 Three 等价 reparent 逐值一致(≤1e-9);keepWorldTransform:true 重父级前后 tool 世界矩阵逐位;循环父级 rolled-back 拒绝。证据 `…/a2-result.json`。
- 两样例均如实标注 `gpuExecuted/browserExecuted:false`(SDK 事务与 graph 权威层级语义;浏览器宿主沿既有正式测试验收)。

## 如实边界

- 本文件是基准定义与可运行证据，不等于20题全部原门/GPU验收完成；D组性能题的GPU/实机口径沿各自底座门，D1/D3本批未测；B1作者clearcoat ABI仍partial。B5已批准历史证据复用，不重新占GPU或冒充双端HDR。
- 本批先CPU核验，协调者后续明确授权C2/B2根因修与GPU串行双fresh：原runner42/42×2、34图/轮，全部逐图复核；frameTimingMeasured/cargoExecuted始终false。console有404/Three编译器warning/第二轮WS关闭warning，pageErrors=0，不宣称console clean。
- Three 侧对拍用 r185 真实 API(npm 依赖已有),不引入 addon。
