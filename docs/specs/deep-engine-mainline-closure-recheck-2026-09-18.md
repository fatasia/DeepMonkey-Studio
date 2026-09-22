# Deep Engine 原主线复核（2026-09-18）

本报告核对 SceneSnapshot → 正式 Web/Native 交付原主线。DE26 新增强不计入这里的完成率，原 D11–D28 也不能因映射进 DE26 而后置或删除。

依据：`codex-mainline-handoff-2026-09-17.md` 阶段 3、`codex-glm-handoff-2026-09-18.md`、`deep-engine-next-development-tasks-2026-09-15.md` 及当前消费者代码。旧任务表中的初始“待办”不是当前状态，以下区分已核实的历史证据与本轮复跑。

## 已实现和已有证据

项目后验收机器门禁固定为 V01–V05 五张卡；每张卡必须有状态和明确理由，只有显式 `independentEvidence=true` 才允许 `passed`。A04/A08 配对证据只能形成 `partial`，不能隐式升级为项目通过。

| 原范围 | 已核实实现 / 证据 | 本轮状态 |
|---|---|---|
| D01–D06 发布正确性 | 生命周期拆分、严格兼容合同、快照预检、归档 hash/依赖闭包、独立产物状态与重试、冻结私有资源与事务复核已入库；交接 commits `2c03003/81d3db7/dae7ad2/9aa965c` | 已复跑 scene API 103、Web scene 326 专项；不重复建设发布状态机 |
| D07–D10 静态 Native 交付 | v5 编译几何/材质/纹理、局部原点与相机；历史 HTTP → 服务端候选窗口 → 正式 ZIP → 停 API → 同 ZIP 离线窗口 | 历史证据 `test-output/native-publication-http/e324c9e2-c692-4bab-a2fb-68d979f36432/`：同 EXE 与运行包 SHA，候选 12 帧 / 离线 3 帧，Vulkan 1200×800、GPU clean；本轮现链复跑待补 |
| D09 坐标正确性 | 历史 6 个近远 GPU smoke、世界相机/选择/测量与失败旧帧恢复；范围见 `scene-local-coordinates-2026-09-15.md` | 这些不是任意连续跨原点/法线/阴影全面验收 |
| Web bridge / 内核 | Studio Deep WebGPU bridge 的环境/灯光/阴影/覆盖层，Native PBR/IBL/CSM/ACES/Bloom 等模块已有 | Deep 本轮全量 389 文件、3193 passed / 41 skipped，typecheck/build/purity 过；桥接功能不自动等于 Native 作者字段消费 |
| 正式包恢复 | 原候选/LKG/包 hash/资源闭包与 portable/EXE 恢复链复用 | 本轮 `test-output/p03-05-atlas-semantic-20260918/evidence.json` 17 步 / 11 截图通过；冻结 atlas 逐张内容 hash 匹配，不按动态图集总数降断言 |

独立 HTTP/JsonStore/Local 证据与实际 Postgres/MinIO 不混用。历史实际 Postgres/MinIO 最小场景已有工作台发布、私有字节 → Web 导出函数 → CLI → 窗口证据，但浏览器 ZIP 落盘与完整 OS 断网链仍未闭合。

## 当前生产边界与真实剩余

`apps/web/src/delivery/compileSceneRuntimePackage.ts` 原 v5 输出 camera + renderPacket；同日 v6 新增无天空盒、无 HDR、无网格的作者纯色环境消费与环境 hash 绑定。真实发布前/离线 EXE 共 6 窗像素一致，见 [纯色环境报告](scene-authored-solid-environment-2026-09-18.md)。`sceneInactiveFields.ts` 只消除已证明无效果的禁用状态；其他普通 Studio 环境、网格、灯光、雾、导航、后处理不能直接当无效默认值丢弃。已有 GPU 模块与 Web bridge 不是这些 Native 作者字段已接线的证据。

| 原范围 | 仍需关闭的生产/验收项 |
|---|---|
| D01 / D03 / D10 | 完整发布 UI 视觉、降级确认放行规则、浏览器真实 ZIP 落盘、OS 断网及失败恢复；保留现有 fail-closed |
| D11–D19 正式运行时 | 作者 3D 交互/动画/环境字段、二维页面与数据共同运行的正式消费链；当前筛选事件→冻结 dataset→present 缺接线，不能以静态选项文字代替 |
| D20–D23 客户端工程化 | 场景 portable 与版本包绑定及现有更新恢复可复用；干净机安装/升级/卸载、签名及页面构建交接仍须分别验证 |
| D24–D28 项目后验收 | 三套达到原资产门槛的正式场景、开启/关闭性能对照、跨端几何/材质/阴影/后处理/文字阈值、完整多通道采样及统一交付长稳。当前 BIM/预热机 CPU/GPU 对照只覆盖部分，不代表整体验收通过 |

## 本轮已暴露并正在收口的组件缺陷

完整升级链虽通过，截图暴露 KPI/table/filter 空白。部署测量入口遗漏 value/table，fixture 遗漏 table 字体，table 语义文本遗漏 CSV/Excel tool roles。前两项和静态 tool 接线已修；导出动作、过滤、分页/排序互动仍保持 deferred。

用户指出标题/KPI发虚：实测系统 DPI 120（125%），客户区 1200×800、逻辑画布 960×540，1x 字形 atlas 被 linear 放大 1.25 倍。静态 producer 已改显式有界 2x 字形生产，保留原逻辑 quad/clip；动态轴文字由 Deep2D 同族修复。`dashboard-text-layout-density-20260918/evidence.json` 的 8 次真实 Native 字形生产证明多行中文/混排/显式换行/窄英文排版不随 1x/2x 改变，分数宽高下逻辑行指标误差 <0.001。

Web delivery 本轮新回归：55 文件通过、1 文件跳过，601 passed / 1 skipped；Web 与验收脚本 typecheck 通过。

完整表格真实候选暴露服务端 180 秒超时：权威二次编译重复执行逐段 Native 字形生产。现增加部署局部 64 MiB / 128 项 LRU，完整请求、真实字体字节 hash 与 EXE 身份入 key；只缓存真实 producer 像素/行信息的深拷贝，语义编译、测量、预算和 receipt 复验仍执行。13 项缓存/host 反例通过，生产 180 秒门限未改。1x 候选实测 126567 ms；2x 从部署到 artifact 约 126 秒，均返回 201。

两份正式候选位于 `test-output/dashboard-text-density-{1x,2x}-cached-20260918/`。KPI/table 已非 blocked，filter 仍 blocked；所有对象仍诚实保留 runtime.interactions deferred。1x 包 380855 字节、prepared atlas 235244 字节；2x 包 1246771 字节、prepared atlas 884660 字节。

`test-output/dashboard-text-density-matrix-20260918-r2/evidence.json` 已完成 16 个真实窗口：两份图集密度 × 两轮 × 有效渲染倍率 100/125/150/200%。系统 DPI 固定 120（125%），不是四个系统 DPI 环境。固定 EXE SHA `342b06e50bfe45ff288389bae49e97c70e2e670bb4ac0ad62f7dac5055bf6adb`，每格记录包/字体/atlas SHA、字节、quad 和精确客户区。原像素裁剪显示 125% 的 2x 标题/KPI/单位较 1x 清楚，两轮一致，四行表格及静态工具栏可见。没有对截图 resize 来制造改善。动态轴同用本次 EXE，后续亚像素精度与品牌图标改动仅补相关两轮窗口。

## 接下来最小收口顺序

同日 v7：作者单方向光、线性辐照度/强度、Web 曝光和阴影开关进入 Native；发现并修复 material flags 插值导致阴影接收失效。真实发布与离线品牌 EXE 六窗像素一致、严格 GPU 光照差分通过，见 [方向光报告](scene-authored-directional-light-2026-09-18.md)。多灯/GI 等完整目标继续保留。

同日后续：Scene 正式独立 EXE 已复用发布冻结 nativeCompiled 接通，没有第二候选状态机。新发布的 Deep Native artifact 选择 EXE，旧 archive 记录继续 ZIP 重试。实际新候选 12 帧→HTTP 发布→默认/品牌 EXE 下载→停 API→无参数各两轮，证据 `test-output/scene-standalone-executable-20260918/`；四张实际 Box 客户区原始 RGBA SHA 相同，图标/标题差异来自包级 PE 品牌。权限、读取预算、取消、冻结对象/EXE SHA 和打包末尾发布身份复核均有反例。此项只关闭最小 Scene 独立 EXE 正式链，不关闭安装升级卸载或所有渲染字段；详情 `scene-client-branding-delivery-2026-09-18.md`。

1. 静态文字/表格两轮实窗矩阵已完成；动态图精度/品牌图标合并构建后补相关两轮窗口。
2. 复用既有 `verify-native-publication-http.mts` 复跑当前 scene HTTP → ZIP → 停 API 同包正常窗口，不另建交付链。
3. 从已实现模块里选最小 Native 作者字段消费接线，先核对源字段→冻结资源→包合同→实际消费者与负例，再实施。其余未知/未支持继续 blocked。

这里不提供虚假的统一百分比；每个关口按上述范围及证据单独判定。
