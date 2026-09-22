# 工业 S1–S6 收口报告

日期：2026-09-18。范围按 [工业三维格式工作计划](../specs/industrial-3d-format-work-plan-2026-09-16.md)；机器状态见 [验收矩阵](../specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json)。本报告只收口已有实现和真实证据，不把固定夹具扩大成任意客户模型承诺。

## 结论

S1–S5 均为 `partial`，S6 为 `project_post_acceptance`。七个格式 profile 没有新增 `productionReady` 声明：E57/LAS/LAZ/COPC 保持 `inspect`，其余本轮研究/受限子集保持 `preview`。Parasolid 用户可见名称统一为 `X_T`，扩展名为 `.x_t`；没有商业 SDK、商业转换器或在线服务回退。

## 复验结果

矩阵校验器现在额外要求：`partial`/`blocked`/`project_post_acceptance` 阶段必须列出非空 `openGates`，`complete` 阶段不得残留 open gate；新增失败路径测试通过。这保证阶段状态不能脱离剩余门槛单独升级。

| 范围 | 命令/证据 | 结果 |
| --- | --- | --- |
| API/Worker 构建 | `pnpm --filter @bim-studio/api build` | 通过；生成 `industrial-worker-host.exe`（621,056 B，SHA-256 `97fa90c3947b35e79a6767776a7493fe5fdc0e00ff34c6e299643505dcfc56ac`） |
| S1 任务、租约、CAS、Job、E57、SW | API Vitest 14 文件 | 114/114 通过 |
| S3 Tiles + S4 X_T 纯审计 | B3DM/Properties/RTC、source-map/identity/geometry 测试 | 45/45 通过 |
| S5 RVT source profiles | `node --test scripts/rvt-source-profiles.test.mjs` | 4/4 通过 |
| S5 RVT planar family | `node --test scripts/rvt-planar-family.test.mjs` | 2/2 通过，26 solids/312 triangles |
| S5 RVT group placement | `node --test scripts/rvt-group-geometry.test.mjs` | 3/3 通过，11 instances/132 triangles |
| S5 RVT holed family | `node --test scripts/rvt-holed-prism.test.mjs` | 3/3 通过，42 solids/5208 triangles |
| 矩阵合同 | `node scripts/fixtures/industrial-stage-matrix.mjs` | 通过，S1–S6 六阶段、七 profile |

首次 API 聚焦运行因 `apps/api/dist/industrial-worker/industrial-worker-host.exe` 尚未生成而出现 ENOENT；按现有构建链生成宿主后完整复跑通过。该事实已记录，不能把缺失构建物误判为格式解析失败。

## 23:24 收口复验与共享 Worker 边界修复

本轮修复了一个真实的 S1 执行边界缺口：外部受控转换器的子进程此前没有登记资源退出 Promise，取消/超时可能在子进程尚未收到 `close` 事件时提前进入任务终态。现在 `runCommand` 将子进程 `close` 注册到共享 `registerResourceExit`，与 JT、E57 和 SolidWorks Worker 使用相同的“资源退出后才可收口”合同；没有改变商业依赖策略或发布语义。

修复后的证据：

- API 全量：`pnpm --filter @bim-studio/api exec vitest run --maxWorkers=4`，212 文件、1,387 通过、4 跳过（总 1,391）。
- 共享 Worker/多实例聚焦：6 文件、52 项通过，覆盖外部转换器资源退出、JT/Windows Job 取消/超时/崩溃、租约 fencing，以及真实隔离 PostgreSQL 的双实例竞争、接管和远程取消。
- API 类型检查：`pnpm --filter @bim-studio/api typecheck`，通过。
- API 构建：`pnpm --filter @bim-studio/api build`，通过；当前 Windows Job host 621,056 B，SHA-256 `97fa90c3947b35e79a6767776a7493fe5fdc0e00ff34c6e299643505dcfc56ac`。
- JT 生产样本仍为 `test-output/industrial-jt-worker-production-20260918/` 与 `test-output/industrial-jt-job-production-20260918/`；10.3 ExampleBlock 9 segments/11 nodes/1 mesh/1 instance/12 triangles，GLB SHA-256 `d16c470eb9c84de2b59d51c272a797f731806a592deb7f8e9df706c8306fef43`。
- OS/多实例边界：Windows Job 真实进程树、CPU/内存/墙钟、父进程退出回收和双实例 PostgreSQL fencing 均在上述聚焦组内通过；受限令牌、文件/网络权限沙箱和完整安装包权限矩阵仍未宣称完成。

## 仍未关闭的门槛

- S1：停旧写入实例后的迁移窗口、新旧二进制混跑拒绝、全部 Worker 的共享宿主接线、安装权限沙箱和完整恢复/清理矩阵。
- S2：JT 独立版本/LOD/外部引用保留集，3DM 复杂 trim、跨面缝合、贴图依赖和两端产品测量/绑定。
- S3：点云正式上传/渲染/驻留回收/配准恢复，Tiles 依赖闭包和 Web/Native 空间运行时。
- S4：X_T 独立保留集、单位/闭合性/误差报告、原生几何桥；未知 schema 和未认证 profile 不得升级。
- S5：RVT 两栋独立建筑的结构/机电/链接关系；SolidWorks 三来源 20 零件/8 装配与配置、抑制、外部引用证据。
- S6：干净 Windows OS 级断网安装、混合场景交互、升级/回滚、安全矩阵及双主题/双分辨率视觉终验。

## 复现约束

RVT 命令需要使用报告中固定的 `test-output` 夹具环境变量；这些目录是本机证据，不进入发布包。X_T、RVT、E57、Tiles 和 SolidWorks 的研究产物不能在没有对应 source hash、质量报告和 profile 声明时转为 `ready`。
