# 工业 S0–S6：继承成果与验收差额

2026-09-18。按 [权威计划](industrial-3d-format-work-plan-2026-09-16.md) 校准。此表继承 GLM 与既有 Codex 成果；旧盘点的缺项不能覆盖后续实测，也不把阶段数量折算为工程完成百分比。机器可读状态以 [S1–S6 验收矩阵](industrial-s1-s6-acceptance-matrix-2026-09-18.json) 为准；本页不把 `inspect`/`preview` 研究证据提升为 `ready`。

| 阶段 | 已完成：继承成果及本次新增 | 本轮待办：真实验收差额 |
| --- | --- | --- |
| S0 | GLM 已有 JT、3DM、X_T、RVT、LAS/LAZ 五方向工件/RSS/耗时记录，见 `test-output/industrial-s0-rss-20260917/SUMMARY.md`；本次增加 SW 5 真实样本/13 运行、离线 CLI/vendor/逐文件清单，以及 Tiles 离线重装构建/实际遍历/5 b3dm/6 负例。本轮收口三项：① E57 构建与格式负例完成——自造 5 例+上游 5 例均给出可读错误/拒绝行为，上游崩溃样本 `MultipleScansHomogeneousError` 以非零退出拒绝并如实标注，见 `test-output/industrial-e57-negative-20260918/evidence.txt`；② 依赖许可闭包盘点完成四组（worker Rust 250 crate、gltf-pipeline 54 包、Tiles 9 包、SW cadmpeg 87 包+vendor 146 crate），缺口如实列出，见 [许可闭包](industrial-s0-license-closure-2026-09-18.md)；③ 本机分发物体积/冷启动/无网静态审计完成——13 项分发物合计 104,841,562 B 对照 pack 初始预算均未超（pack 未组装，不判达标），10 工件各 3 次无参冷启动 wall-time 5.3–212.6 ms，PE 导入表+22 个网络指标串全镜像扫描 0 真实命中（OS 级断网未做），见 [安装体积与冷启动](industrial-s0-install-size-coldstart-2026-09-18.md) | 干净断网 Windows 的完整安装、临时磁盘、首交互与 OS 级断网验证（本机暖缓存冷启动与静态无网证据不能替代）；notice 汇编（THIRD-PARTY-NOTICES）与逐文件许可例外审查；pack 组装物出现后才可冻结预算。七方向已有基础实验记录不等于七方向完整几何 |
| S1 | 统一任务、SourceBundle/QualityReport、幂等、attempt、原子发布、PostgreSQL CAS、租约与跨实例取消意图已通过真实隔离测试；JT/E57/SW 复用 Windows Job 宿主，迟到回执和旧 ready 保留受保护 | 仍需停旧写入实例后迁移，禁止新旧二进制混跑；其余解析器逐一接入共享宿主、受限令牌、完整重试/缓存清理和安装权限矩阵 |
| S2 | JT 9.5/10.x 实际装配、材质继承、稳定 occurrence、GLB 与上传选择/属性回归；3DM 固定 openNURBS 构建、保存网格/块/UUID/材质/UV、CAD IR 与平面/球/柱/锥研究重建；Float32 内部塌缩三角已清零 | JT 版本/LOD/外部引用独立保留集和双端测量/绑定仍待；3DM 仍有 44 条非共形边、复杂 trim/贴图缺依赖和产品质量档接线。单侧共边证明不计跨面缝合完成 |
| S3 | E57 已完成真实静态 Reader、颜色/强度/无效标记、扫描姿态/世界 double 坐标、有界点块和隔离 Job；Tiles 已完成本地严格预检、GLB 1/RTC 研究转换及属性审计 | E57/LAS/LAZ/COPC 尚无正式上传、点云 primitive、分块驻留/回收和配准恢复；Tiles 仍缺依赖闭包、坐标/LOD/feature 元数据及 Web/Native 空间运行时 |
| S4 | 保留既有 V24.1 旋转件 profile；109 件真实 `.x_t` 研究链完成结构读取和源 BODY/FACE/source map 审计，最新相邻支撑回归 19,344 面 witness-match、mismatch 0、unresolved 0 | 研究链仍有 Float32 零面积三角和重复 witness，且生产 profile 认证数为 0；独立保留集、单位/闭合性/误差报告、原生几何桥及正式产品接线未全验收 |
| S5 | RVT 固定开源构建、容器/分区/源身份与跨版本拒绝；真实 26 个 planar solids、42 个带孔 solids、11 个组 placement preview。SW 真实五件零件受限 display preview、负例与隔离产物审计 | RVT 两独立建筑含结构/机电/链接的真实构件几何与关系仍待；SW 三来源 20 零件/8 完整装配、配置/抑制/外部引用/几何/外观与身份尚未满足 |
| S6 | 已有 GLB 审计、源映射、格式级回归及通用发布/回滚基础；本次扩大任务故障、不可变发布、旧版本保留证据 | 七方向已声明 profile 的独立版本保留集、混合场景 Native/Web 交互与正式发布、断网安装、升级/回滚、安全及视觉终验；不能由 S0 inspect 推导通过 |

## JT 子进程本次验证

- 复用 `jtInspection.ts` 与 `jtGlbConverter.ts`，父进程保留 source hash、输出审计、manifest、对象写入及事务发布；未增加存储拓扑或第二任务总线。
- 专项 4 文件 33 测试通过：真实 CPU 忙循环取消/超时杀 PID、崩溃/坏协议、退出前不释放槽、cancel/crash 后旧 ready 及重新打开存储不变、两份真实 JT 上传回归。
- API 全量 202 文件、1287 通过/4 跳过；API typecheck 与生产 TypeScript 编译通过。
- 生产 `.js` fork 实跑 JT 10.3 ExampleBlock：9 段/11 节点、1 网格/1 实例/12 三角，GLB 4900 B，SHA-256 `d16c470eb9c84de2b59d51c272a797f731806a592deb7f8e9df706c8306fef43`。实际 NodeIO 重读成功，产物在 `test-output/industrial-jt-worker-production-20260918/`。
- Windows JT 已复用 Native Job 完成提交内存、累计 CPU、整树及父进程退出治理，41 项专项与生产 JS 实测通过，详见 [Job 验证](industrial-jt-windows-job-2026-09-18.md)。V8 堆限制独立；Job 不等于受限令牌/文件网络权限沙箱，非 Windows 仍仅提供可终止进程隔离。

## 证据入口

- [S1–S6 机器可读验收矩阵](industrial-s1-s6-acceptance-matrix-2026-09-18.json)（校验：`node scripts/fixtures/industrial-stage-matrix.mjs`）
- [S1 attempt 与发布](industrial-s1-attempt-closure-2026-09-18.md)
- [SW 样本、构建、许可与运行](industrial-solidworks-s0-2026-09-18.md)
- [Tiles 构建与解析](industrial-tiles-source-qualification-2026-09-18.md)
- [X_T 交线误差修复](../reports/industrial-x-t-projected-intersection-2026-09-17.md)

## 本轮最小复验快照

- API 生产构建（含 `industrial-worker-host.exe`）通过：`pnpm --filter @bim-studio/api build`。
- API 工业聚焦回归通过：14 个文件、114 项测试；先前未生成宿主导致的 ENOENT 已由构建步骤消除。
- Tiles/B3DM/RTC、X_T source-map/identity/geometry 纯审计通过：45 项测试。
- RVT 真实语料通过：source profiles 4 项、planar family 2 项、group placement 3 项、holed family 3 项；机器证据覆盖 26 个 planar solids、11 个 group instances、42 个 holed solids/5208 triangles。
- 这些复验只证明列出的 profile/夹具边界；矩阵中的 `partial` 和 `project_post_acceptance` 状态保持不变。

明确排除：商业转换回退、代理几何冒充正式模型、源 CAD 软件运行依赖。项目级后验收：任意客户模型兼容与未声明 profile，不从固定语料推广保证。
