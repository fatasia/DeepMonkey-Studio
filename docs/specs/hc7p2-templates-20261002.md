# H-C7-P2 交付报告:8 个空项目可运行 3D 模板、版本化 references、一份 Skill 生成双客户端分发

日期:2026-10-02。任务行:`docs/specs/remaining-tasks-estimates-20260930.md` 行 165
(8–16h,中信心);权威规格:`ai-first-framework-and-agent-integration-20260930.md` §五项交付-1/§4/落地顺序-2。

## 1. 现状核查(六步,详见 test-output/hc7p2-templates-20261002/progress-01.json)

**已有(复用,不重建)**:`@bim-studio/deep-engine` 0.1.0 独立导出面(. / app / webgpu 等 26 子路径);独立 Web SDK 消费门全套基建(`scripts/lib/sdkConsumer*.mjs`、`gate:deep-engine-consumer`,2026-09-22 报告 passed);消费者 fixture 形态(node.ts 无头 DeepApp + browser.ts readback 像素证据 + 取消/幂等释放);`@webgpu/types` 0.1.72 精确锚。

**真实缺口**:8 个领域 3D 模板、版本化 references、canonical Skill 与双客户端分发物、逐模板运行门——本批全部补齐。任务简报所称"黄金样例 01-15"经全仓核查为 plant-lite 仿真黄金样例与 2D 看板模板库(域均不符),3D 侧从已验消费 fixture 与 `examples/standalone-pbr-app.ts` 形态提炼,未虚构样例源。

## 2. 8 模板清单与运行门结果(全绿)

| # | id | 领域 | 核心展示 | Node 门 | 浏览器门(像素证据) |
|---|---|---|---|---|---|
| 1 | 01-starter | 通用 | 最小场景+浮动动画+环绕相机 | 6f ✓ | 57,585 ✓ |
| 2 | 02-factory-floor | 工厂车间 | 设备阵列实例化、安全标线、雾效 | 6f ✓ | 150,784 ✓ |
| 3 | 03-equipment-monitor | 设备监控 | unlit 屏幕、三色状态灯、告警呼吸、选中光环 | 24f ✓ | 139,386 ✓ |
| 4 | 04-robot-cell | 机器人 | 层级 mat4 变换链、关节动画、围栏 | 10f ✓ | 125,686 ✓ |
| 5 | 05-pipeline | 管线 | BLEND 观察段、路径参数化流动、泵站 | 10f ✓ | 147,617 ✓ |
| 6 | 06-logistics | 物流 | 双 AGV、三层货架、辊道实例化 | 12f ✓ | 109,279 ✓ |
| 7 | 07-energy | 能源 | 储罐球封头、信标脉冲、围堰 | 24f ✓ | 132,448 ✓ |
| 8 | 08-structure | 结构 | 梁柱板、BLEND 幕墙、高亮、升降台 | 12f ✓ | 71,725 ✓ |

形态:每模板自包含目录 `scene.ts`(纯场景构造,双端共用)+`node.ts`(无头 DeepApp 动画/结构断言)+`browser.ts`(WebGPU 渲染门)+`index.html`+双 tsconfig;共享 `sceneTypes/harness/nodeHarness` 为 copySet。只用真实导出(DeepApp/PbrRendererPlugin/RenderPacket/InstanceUpdate/FrameCaptureSession/RenderView/PbrRendererFeatureOptions)。

**运行门**(`pnpm gate:hc7p2-templates` → `templates/deep-engine-3d/scripts/gate-templates.mjs`):pnpm pack+tar 校验 → 仓外空项目离线安装(精确 pin,断言安装版本==pin)→ 每模板 tsc×2(NodeNext emit / Bundler noEmit)→ Node 门 → esbuild 自包含 bundler(禁 react/three/src,须含 SDK dist)→ Chrome WebGPU readback 像素证据(>30,000)→ 渲染态+协议双截图。报告 `report.json` status=passed。

**视觉闭环 3 轮**(≥2 达标):r1 修复 05 主管 BLEND 段误竖放、4 模板地面过曝、07/08 相机裁切;r2 08 改低角侧视;r3 终轮 8/8 构图可读、语义色/发光/雾/渐变背景达标、无纯黑裸背景。证据:每模板 `*-rendered.png`。

## 3. 版本化 references

`references/sdk-versions.json` 唯一 pin 源(exact:`@bim-studio/deep-engine` 0.1.0、`@webgpu/types` 0.1.72),含 provenance 与 onDrift 升级动作。检测网四层:① `version-pin.test.mjs` 对 packages/deep-engine 清单漂移即红灯;② 运行门消费者清单由 pin 生成并断言安装版本==pin;③ SKILL.md 安装示例内嵌 pin;④ 已装客户端 Skill 与 canonical 同步检查。升级流程:改 pin → 重跑门取新像素证据 → 重分发。

## 4. 一份 Skill → 双客户端分发(已验证)

canonical `skill/canonical/SKILL.md`(短正文:选模板→起步→运行观察→局部修改→释放)+ references(api-surface / material-parameters / run-commands + 分发时并入 sdk-versions/templates)。`distribute-skill.mjs` 生成 **Codex `.agents/skills/deep-engine-3d/` 与 Claude Code `.claude/skills/deep-engine-3d/` 字节相同两份**(规格 §4 明文的双客户端;纯文件形态,web/desktop 宿主均按各自客户端目录消费);冲突拒写需 `--force`,客户端目录内无关文件与 MCP 配置一律不碰。`verify-distribution.mjs`:双端 SHA-256 一致 + frontmatter + 引用文件/命令存在 + **发布门核对示例 import 的 14 个导出名在 dist d.ts 真实声明**(防照文档调用不存在的函数)。双端已安装并通过校验(证据 `distribution.json`/`skill-verify.json`)。

测试:`node --test scripts/*.test.mjs` 8 pass / 0 fail(全部在临时目录,含冲突/--force/幂等/漂移检测)。

## 5. 过程发现(SDK 侧遗留,已绕行,交 SDK 线路)

1. `RenderInstance.outline` 位仅 render-packet 层打包,WebGPU 运行面材质账本与作者侧 surfaceFlags(bit256)不一致,初始化即报 "Material effect ledger mismatch"——模板改用已验证的自发光高亮方案。
2. `DeepApp.advance(timeMs)` 为绝对时间戳语义,重复同值调用冻结动画(deltaMs=0)。
3. 共享 lib `deepEngineConsumerPackages` 断言 `@webgpu/types` 在 dependencies,而现 manifest 在 devDependencies——旧 `gate:deep-engine-consumer` 重跑会红;模板门自带打包,不依赖该 lib。

## 6. 范围与剩余

- 改动足迹:新增 `templates/deep-engine-3d/**`、`.agents/`、`.claude/`;`package.json` +1 行门脚本。未触碰 apps/web 受保护域、jc-i-continuation;无 cargo;无 commit/push/reset/clean/stash。
- H-C7-P2 行剩余:P1 的 MCP 客户端真实视觉循环衔接(模板产物可直接作为其输入)、P3 原生作者 API 落地后的模板扩容(创建/删除/批量事务示例、GLB/工业格式资产导入类模板)、P4 迁移基准复用本套件作对照样例。
