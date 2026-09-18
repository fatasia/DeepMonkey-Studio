# 工业 S0–S6：继承成果与验收差额

2026-09-18。按 [权威计划](industrial-3d-format-work-plan-2026-09-16.md) 校准。此表继承 GLM 与既有 Codex 成果；旧盘点的缺项不能覆盖后续实测，也不把阶段数量折算为工程完成百分比。

| 阶段 | 已完成：继承成果及本次新增 | 本轮待办：真实验收差额 |
| --- | --- | --- |
| S0 | GLM 已有 JT、3DM、X_T、RVT、LAS/LAZ 五方向工件/RSS/耗时记录，见 `test-output/industrial-s0-rss-20260917/SUMMARY.md`；本次增加 SW 5 真实样本/13 运行、离线 CLI/vendor/逐文件清单，以及 Tiles 离线重装构建/实际遍历/5 b3dm/6 负例。本轮收口三项：① E57 构建与格式负例完成——自造 5 例+上游 5 例均给出可读错误/拒绝行为，上游崩溃样本 `MultipleScansHomogeneousError` 以非零退出拒绝并如实标注，见 `test-output/industrial-e57-negative-20260918/evidence.txt`；② 依赖许可闭包盘点完成四组（worker Rust 250 crate、gltf-pipeline 54 包、Tiles 9 包、SW cadmpeg 87 包+vendor 146 crate），缺口如实列出，见 [许可闭包](industrial-s0-license-closure-2026-09-18.md)；③ 本机分发物体积/冷启动/无网静态审计完成——13 项分发物合计 104,841,562 B 对照 pack 初始预算均未超（pack 未组装，不判达标），10 工件各 3 次无参冷启动 wall-time 5.3–212.6 ms，PE 导入表+22 个网络指标串全镜像扫描 0 真实命中（OS 级断网未做），见 [安装体积与冷启动](industrial-s0-install-size-coldstart-2026-09-18.md) | 干净断网 Windows 的完整安装、临时磁盘、首交互与 OS 级断网验证（本机暖缓存冷启动与静态无网证据不能替代）；notice 汇编（THIRD-PARTY-NOTICES）与逐文件许可例外审查；pack 组装物出现后才可冻结预算。七方向已有基础实验记录不等于七方向完整几何 |
| S1 | 原有任务服务/插件/审计复用；本次上传/API/MCP 同一任务、SourceBundle/质量档、既有 MetadataStore 持久化、幂等、attempt 路径与实物哈希审计、原子发布、重启显式失败与旧 ready 保留；JT OS 子进程及 Windows Job 整树回收、提交内存/累计 CPU 限额、父进程死亡回收，退出后终态及释放槽 | 多实例一致性与租约（现有 Postgres 整文档写入需先解决 CAS）；其他解析器进程接线、受限令牌及文件/网络权限；依赖闭包、完整重试/缓存清理矩阵 |
| S2 | JT 9.5/10.x 已有实际装配、材质继承、稳定 occurrence、GLB 与上传选择/属性回归；3DM 已有 openNURBS 固定构建、保存网格/块/UUID/材质/UV、CAD IR 与平面/球/柱/锥研究重建；本次新增 8 条精确 Bézier chain 单侧共边证明 | JT 版本/LOD/外部引用保留集；3DM 复杂 trim、双侧共边与非共形边、贴图缺依赖；两端实际查看/测量/绑定及质量档产品接线。单侧证明不计跨面缝合完成 |
| S3 | 既有点云语料与 laz-perf 实读/RSS；Tiles 本次完成上游实际离线解析实验，确认样本载荷是 GLB 1；上游魔数/版本/声明长度只 console.assert 的行为已登记 | 四输入点云完整合同、CRS/扫描姿态、分块驻留/回收、配准保存恢复与 Native point primitive；Tiles 严格预检、GLB 1 转换、依赖闭包、坐标/LOD/feature 元数据、Web/Native 空间运行时 |
| S4 | 保留既有 V24.1 旋转件 profile；研究链 109/109 X_T 实体读尽与有效 GLB，源 BODY/FACE 归属及 source map 已核验；多壳/孤立极点/交线修复已存在，逐面审计进展不可重置 | 已有逐面证据仍含 5 mismatch、181 unresolved；继续处理重建曲面/交线及未覆盖见证、单位/闭合性/误差。独立保留集、原生几何桥及正式产品接线未全验收 |
| S5 | RVT 固定开源构建、容器/分区/源身份与跨版本拒绝已存在；SW 本次完成真实 framed v4/sw_version16000 容器 inspect，负例分级、离线构建和来源清单 | RVT 两独立建筑含结构/机电/链接的真实构件几何与关系；SW 三来源 20 零件/8 完整装配、配置/抑制/外部引用/几何/外观与身份。当前 SW 五零件同一来源，未获得装配几何资格 |
| S6 | 已有 GLB 审计、源映射、格式级回归及通用发布/回滚基础；本次扩大任务故障、不可变发布、旧版本保留证据 | 七方向已声明 profile 的独立版本保留集、混合场景 Native/Web 交互与正式发布、断网安装、升级/回滚、安全及视觉终验；不能由 S0 inspect 推导通过 |

## JT 子进程本次验证

- 复用 `jtInspection.ts` 与 `jtGlbConverter.ts`，父进程保留 source hash、输出审计、manifest、对象写入及事务发布；未增加存储拓扑或第二任务总线。
- 专项 4 文件 33 测试通过：真实 CPU 忙循环取消/超时杀 PID、崩溃/坏协议、退出前不释放槽、cancel/crash 后旧 ready 及重新打开存储不变、两份真实 JT 上传回归。
- API 全量 202 文件、1287 通过/4 跳过；API typecheck 与生产 TypeScript 编译通过。
- 生产 `.js` fork 实跑 JT 10.3 ExampleBlock：9 段/11 节点、1 网格/1 实例/12 三角，GLB 4900 B，SHA-256 `d16c470eb9c84de2b59d51c272a797f731806a592deb7f8e9df706c8306fef43`。实际 NodeIO 重读成功，产物在 `test-output/industrial-jt-worker-production-20260918/`。
- Windows JT 已复用 Native Job 完成提交内存、累计 CPU、整树及父进程退出治理，41 项专项与生产 JS 实测通过，详见 [Job 验证](industrial-jt-windows-job-2026-09-18.md)。V8 堆限制独立；Job 不等于受限令牌/文件网络权限沙箱，非 Windows 仍仅提供可终止进程隔离。

## 证据入口

- [S1 attempt 与发布](industrial-s1-attempt-closure-2026-09-18.md)
- [SW 样本、构建、许可与运行](industrial-solidworks-s0-2026-09-18.md)
- [Tiles 构建与解析](industrial-tiles-source-qualification-2026-09-18.md)
- [X_T 交线误差修复](../reports/industrial-x-t-projected-intersection-2026-09-17.md)

明确排除：商业转换回退、代理几何冒充正式模型、源 CAD 软件运行依赖。项目级后验收：任意客户模型兼容与未声明 profile，不从固定语料推广保证。
