# Codex → GLM-5.3 继续开发交接（2026-09-04）

## 1. 接手边界

- 产品仓库：`D:\Documents\bim\bim-studio`
- 分支：`dev-studio`
- 本轮提交：执行 `git log -1 --oneline` 获取，提交说明为 `feat: connect simulation and model asset pipelines`
- 只允许本地提交；用户明确要求 **不要 push**。
- 外层 `D:\Documents\bim` 是无远端的工作区快照，不是产品开发仓库；不要在外层提交产品代码，也不要改写其 Git 历史。
- `D:\Documents\bim\minio` 保持外层兄弟目录，不能迁入产品 Git。`oracle` 仅为可选 Oracle Thick/Node-RED 连接，`installers` 仅为安装介质，均不是普通 Web 启动依赖。
- 不要 reset、checkout 或 clean 用户工作树。

## 2. 固定运行约定

- 登录名/密码固定为 `admin / admin`，用户要求后续不得再修改。
- 全局 Web 开发启动：`pnpm studio start web --no-open`；重启：`pnpm studio restart web --no-open`。
- `.env` 的权威存储拓扑是 `METADATA_STORE=postgres`、`OBJECT_STORE=minio`。本轮修复了启动器：无参数启动/重启会优先读取当前 `.env`，不会复用旧运行状态中的 `json/local` 后端。
- 2026-09-04 实测 PostgreSQL 中项目“智造综合案例验证”有 14 个场景；页面显示 14/14。此前出现 0 场景只是错误连到 `data/database.json`，数据没有删除，也没有执行备份回滚。
- 结束开发前保持 Web、API、PostgreSQL、MinIO 全部运行；不要启动 client 模式。

## 3. 本轮已完成

### SIM-001：仿真进入 3D 编辑器

- “仿真与开发”工具坞注册四个面板：物流仿真、工位与机器人、虚拟调试、What-if。
- `SceneSimulationPanel` 是编辑器内右侧插件宿主，复用现有 `OperationsCenter`、Plant Lite、虚拟调试和 Study 数据，不复制算法。
- 编辑器上下文（场景、选中对象）传入工位/机器人与虚拟调试；虚拟调试可直接进入控制验证阶段。
- 同一运行产生的正式结果继续写入统一 Study；独立 `/operations` 保留为证据、历史与批量分析工作台。
- 添加了稳定的 Visual QA 入口 `?__visualQa=scene-simulation&panel=logistics|workcell|commissioning|whatif`。已逐个目测四个面板；窄视口仍保留可见 3D 区域。
- 设计与状态权威边界见 `docs/specs/SIM-001-simulation-in-editor-design.md`。

当前是 SIM-0（可用的工作台结合）完成，不要误报为全部仿真产品化完成。后续顺序：

1. SIM-1a：路径、源汇、队列等仿真实体进入 SceneSnapshot/场景树；覆盖层呈现 AGV 轨迹和队列热力。
2. SIM-1b：3D 表面拾取路径教学、碰撞对与回放。
3. SIM-1c：信号映射、时序轨道与编辑器统一播放控制。
4. SIM-1d：What-if 参数扫描与 Study 对比。

继续守住边界：不自研新仿真算法、不改渲染引擎核心、不承诺 OLP、认证动力学或控制器兼容矩阵。

### 模型导入、转换、压缩与优化

- 保留原有完整优化能力：减面、Draco、WebP/JPEG 贴图压缩、贴图尺寸、去冗余/焊点、原点、顶点色或光照贴图烘焙、AO、软阴影、间接采样、降噪、前后预览和统计。
- 页面定位从“本地 GLB 工具”恢复为四阶段素材管线：**导入 → 转换 → 压缩与优化 → 项目素材**。
- 文件选择接受平台 `supportedExtensions` 的全部格式。GLB/内嵌 glTF 直接在浏览器处理；其余格式先上传项目转换服务，再通过已有 Viewer 加载器统一导出 GLB 工作格式。
- 可直接从当前项目素材库选择 ready 模型继续优化。
- 优化结果既可下载 GLB，也可上传回当前项目，等待服务端处理完成后刷新项目素材状态。
- 项目资源工具栏新增“导入与优化”入口，形成素材库双向链路。

重点文件：

- `apps/web/src/components/ModelOptimizer.tsx`
- `apps/web/src/components/ModelOptimizerPipeline.tsx`
- `apps/web/src/optimizer/modelOptimizerAssets.ts`
- `apps/web/src/components/ProjectAssetToolbar.tsx`

## 4. 两个开源项目价值判断

### SemaPLC

- 仓库：https://github.com/midea-ai/SemaPLC
- 本轮审阅提交：`1c41c1bcb69bb43c51d7d0faed30a2b1930d67fe`（2026-08-25）。
- 核心价值不是模型解析，而是“自然语言/Agent → IEC 61131-3 Structured Text → OpenPLC 编译部署 → 强制/读取/追踪变量 → 梯形图与过程仿真”的虚拟调试闭环。
- 对本项目最值得借鉴：PLC 工具协议边界、变量 force/read/trace、运行清理和互斥锁、版本/证据门禁、WebSocket 状态恢复。这些适合补强 SIM-1c 和统一 Study 证据链。
- 不建议把它作为三维模型导入器，也不应直接塞入 Viewer。更合理的是未来做 `PLC validation adapter`，通过现有虚拟调试面板接入。
- 许可：项目自有代码 MIT，但包含/调用 GPL、LGPL 组件并提供 THIRD_PARTY_NOTICES；若分发组合包，必须逐项复核进程隔离、源码/告知义务。当前阶段只借鉴架构与交互，不复制第三方二进制。

### Astral3D

- 仓库：https://github.com/mlt131220/Astral3D
- 本轮审阅提交：`093e8c164cadc687e5339797253cd8f87df00b85`（2026-08-12）。
- 它是本项目模型链路的直接产品对标：宣称覆盖 30+ 三维/BIM/CAD 格式，包含 RVT/IFC、DWG/DXF、STEP/IGES、场景包、动画、插件与资源中心。
- 最值得借鉴的是统一导入任务和优化 UX：Draco/Meshopt/Quantization、GPU instancing、flatten/join、材质合并/调色板纹理、prune/weld/simplify、WebP/AVIF 和最大纹理尺寸。本轮已落地统一四阶段管线；后续优先补 Meshopt/Quantization、实例化分析和材质合并，且每项必须提供兼容性与体积/面数证据。
- 不建议直接复制其源码。仓库 LICENSE 为 Apache-2.0，但 `LEGAL.md` 又附加“直接商用需书面授权、衍生品来源标注、竞业和商标限制”等条款，和标准 Apache 授权的预期存在冲突。商用引入依赖或源代码前必须得到权利方书面澄清；当前仅做独立实现和产品对标。

结论：Astral3D 影响“模型素材管线”，SemaPLC 影响“虚拟调试适配与证据链”；两者不应混为一个模型解析方案。

## 5. 接手验证

```powershell
Set-Location 'D:\Documents\bim\bim-studio'
git status --short --branch
git log -1 --oneline
git diff --check HEAD~1
pnpm typecheck
pnpm --filter @bim-studio/web test
pnpm --filter @bim-studio/web build
pnpm studio check
```

运行状态必须显示模式 `web`，API `4100`、Web `5173` 健康。登录后应看到项目“智造综合案例验证”和 14 个场景。若再次看到“示例项目 / 0 场景”，立即停止写操作并检查运行状态中的 storage 配置与 `.env`，不要导入备份覆盖现库。

## 6. 给 GLM-5.3 的直接任务

先阅读根 `AGENTS.md`、本文和 `docs/specs/SIM-001-simulation-in-editor-design.md`，以本轮提交为基线继续 SIM-1a。先做场景域合同与持久化测试，再接场景树实体，最后做引擎无关覆盖层；不得把仿真运行时瞬态或 Study 结果混写进 SceneSnapshot。每个阶段都要有聚焦测试和真实浏览器检查，只本地提交，不 push。
