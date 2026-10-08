# Studio 三阶段收尾核对（2026-10-07 17:36）

依据用户最新优先级核对原 `studio-handoff-20261007-1336.md` 的十二项任务。它是历史交接；本页列当前切片证据与仍需完成的门。README 不改，Android 按最新要求移出本次交付。

## 现状核查

1. 已检索流程/本体源码、未跟踪文件、导出与 Pages 脚本；自由画布、完整端口、连接/改接、关系表单均已有正式消费。
2. 已核对 contracts/data 的位置、连接、节点诊断及 OntologyRelationType 的方向/映射/证据合同；不新增一套图存储。
3. React Flow/Dagre、Vitest、JSZip、Node 及视频编码依赖均已在用。
4. DataPipelineStudio→现有 DAG validator/save/preview、OntologyGraphCanvas→现有关系草稿/版本检查/save、SceneViewerRoot→冻结 manifest 是当前消费者。
5. 已读第一阶段真实双主题/断点截图和保存/重载/60→51运行证据，以及本轮各渲染/交付规格、聚焦测试和视频来源。
6. 已校准原交接、quality-continuation、恢复台账与本次发布/视频规格；GPU 由主线程验，当前审计不启动浏览器。

**已有（不重建）**：两张编辑画布、DAG 执行、关系版本编辑、冻结查看器、SDK/发布脚本和两部视频素材链。

**真实缺口**：当前集合的最终 GPU/生产性能与发行运行检查；用户指南缺少图谱阅读布局与流程持久保存的区分。现有新指南/发布说明尚未跟踪，最终提交必须显式纳入。

## 第一优先级终态

| 检查 | 最新结果 | 证据 |
| --- | --- | --- |
| 流程/图谱 Web 聚焦 | 7 文件、69 tests，exit 0 | `test-output/studio-graph-quality/final-web-focused.log` |
| 本体图查询/路由 API | 2 文件、36 tests，exit 0 | `test-output/studio-graph-quality/final-api-focused.log` |
| 节点调试、本体工作区、静态查看器入口 | 3 文件、8 tests，exit 0 | `test-output/studio-graph-quality/final-debug-route.log` |
| Pages 字节/子路径与只读包配置 | Node 14 tests、0 fail | `test-output/studio-graph-quality/final-pages-identity.log` |
| 实际编辑与视觉 | 7 节点/6 边、拖拽/连线/改接/撤销、双主题五断点、保存重载、真实60→51输出 | `studio-quality-continuation-20261007.md` 第一阶段记录与 `test-output/studio-graph-quality/` |

原“94 tests”是14:50时的计数。本轮前两组已增长为105项；不把额外8项或Node14项混入同一历史口径。第一优先级可关闭，后续共享代码修改仍需保留回归。

## 原交接逐项映射与剩余任务

| 原项 / 最新顺序 | 已有完成证据 | 仍须关闭 |
| --- | --- | --- |
| 2 图谱 / ① | 上述105项及实际两轮；流程自由编辑、关系拖线配置均已实现 | 本轮无独立遗留 |
| 3 Deep视觉 / ② | 实际Deep贴图、UV/方向/曝光/雾修复；作者颜色36组两轮GPU检查 | 最终源码带雾/网格的无Composer作者场景同相机对照；完整三后端色彩一致性 |
| 6 Native MegaLights / ② | Vulkan真实GBuffer/TLAS、1080p183.91MiB、DX12能力缺失回退、模块体量通过 | 连续帧性能与特殊材质/雾等边界按支持范围记录；GPU探针耗时不是产品帧时 |
| 7 cluster-LOD / ② | 生产PBR/分节间接draw、近景0像素差、远景1600→256三角形、普通draw回退 | 最终异步packet/上传改动后的复杂编辑器真实复验 |
| 8 发布贴图 / ② | Runtime/Native/WASM冻结源字节与SHA；实际8,285,478-byte ZIP/13资源、离线棋盘载入实录 | 最终编译器/查看器/Native来源一致的包及重开 |
| 9 React / ② | 相同项目快照轮询去重；真实115输入基线/临时采样hook | 同115输入、同持续时间的生产Deep/Three App/主线程/帧与输入延迟对照 |
| 10 滑条 / ② | 本地反馈、实时预览、尾沿提交、键盘/数字/Esc/身份取消聚焦检查及两轮视觉 | 纳入上一行最终生产交互验收 |
| 11 RT二反弹 / ② | 独立128² GPU第二命中/CPU参照；生产30/30双dispatch且0诊断 | 干净1920×1080生产帧对照；旧受干扰p95不计终态 |
| 1+12 切换/性能 / ③ | 活跃画布保留、首帧验证、冷/暖生命周期、静止0draw；用户78e与复杂场景真实证据 | 最终冷/热互切及复杂scene响应；三后端同相机差异与正式性能口径 |
| 4 发布全链 / ③ | root/受影响包聚焦门、生产构建与产物门有分项结果 | 当前源集合的11步release、10步GPU链终态/身份；独立GPU门不能代替整链 |
| 5 离线/Windows / ③ | 冻结贴图SHA、只读裁剪/资源继承修复；Native0.2静态CRT EXE/ZIP与CLI通过 | 当前Studio/只读Windows包安装启动和断网重开；最终SDK消费者、Docker应用启动/恢复、Pages部署 |

图谱、本轮视频与局部GPU检查均不代表“整个产品无bug”或“所有场景性能达标”。Build Settings完整工作台没有本轮新实现要求；低adapter/特殊材质的明确拒绝或回退继续保留。Android取消；Deep2D Web接入与许可证阻塞检查沿用此前取消决定。

## 文档和发布身份

- `docs/video.html` 为已跟踪入口；新增 `docs/guides/online-browser.md`、`docs/guides/data-center-editing.md`、`docs/releases/0.2.0.md`、`docs/sdk-release.md`、`docs/docker-application.md` 必须进入本次提交。README保持原样。
- 文档版本0.2.0、SDK归档示例版本与正式包名一致；WebGPU类型/fflate和Unity bridge保持自身协议/依赖版本。默认Three与显式Deep/WASM选择符合当前源码。
- 在线指南标明0.2部署后入口，发布说明保留草稿状态；当前旧Pages不能视作新版已上线。离线影片是冻结包实录，未冒充最终EXE安装验收。
- 两部完整成片已通过整片解码，时长/大小/SHA见 `studio-pages-video-020-20261007.md`。资产清单 `D:/Documents/bim/deliverables/studio-020-20261007/video-assets.json`。
- Pages需最后专用 `--base=/DeepMonkey-Studio/browse/` 构建→冻结三自产几何stage→现有封包器→所有文件SHA。当前Node门确认子路径、模型边界和字节校验；最终静态ZIP与线上工具使用仍须实际验。
- 用户已明确授权最终push和v0.2.0发布；原交接的默认禁push不覆盖这次明确授权，主线程统一提交/发布并记录最终commit/构建身份。
