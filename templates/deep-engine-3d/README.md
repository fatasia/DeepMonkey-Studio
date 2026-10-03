# H-C7-P2 模板套件（deep-engine-3d）

8 个空项目可运行 3D 模板 + 版本化 references + 一份 canonical Skill 生成双客户端分发。
权威规格:`docs/specs/ai-first-framework-and-agent-integration-20260930.md` §五项交付-1/§4;
估时: `docs/specs/remaining-tasks-estimates-20260930.md` 行 165(H-C7-P2, 8–16h)。

## 目录

```
templates/deep-engine-3d/
  references/     版本化 references(sdk-versions.json 唯一 pin 源;templates.json 模板目录)
  skill/canonical/  一份 canonical SKILL.md + references(Skill 单源)
  scripts/        运行门 / 版本漂移检测 / Skill 分发与校验(含 node --test)
  templates/      8 个自包含模板(01-starter … 08-structure)
  sceneTypes.ts harness.ts nodeHarness.ts  共享 copySet(复制单模板时必须携带)
```

## 常用命令

| 目的 | 命令 |
|---|---|
| 8 模板一键验收门 | `pnpm gate:hc7p2-templates` |
| 套件测试(pin 漂移 + 分发机制) | `node --test templates/deep-engine-3d/scripts/*.test.mjs` |
| Skill 双客户端分发 | `node templates/deep-engine-3d/scripts/distribute-skill.mjs` |
| Skill 分发校验 | `node templates/deep-engine-3d/scripts/verify-distribution.mjs` |

## 模板

| id | 领域 | showcase |
|---|---|---|
| 01-starter | 通用 | 最小场景、bob 动画、环绕相机 |
| 02-factory-floor | 工厂车间 | 设备阵列实例化、安全标线、雾效 |
| 03-equipment-monitor | 设备监控 | unlit 屏幕、状态三色灯、告警呼吸、选中光环 |
| 04-robot-cell | 机器人 | 层级 mat4 变换链、关节动画、围栏 |
| 05-pipeline | 管线 | BLEND 观察段、路径参数化介质流动、泵站 |
| 06-logistics | 物流 | 双 AGV、三层货架、辊道实例化 |
| 07-energy | 能源 | 储罐+球封头、警示信标脉冲、围堰 |
| 08-structure | 结构 | 梁柱板、BLEND 幕墙、构件高亮、升降平台 |

每模板目录:`scene.ts`(纯场景构造,Node/浏览器共用)+`node.ts`(无头 DeepApp 断言门)+`browser.ts`(WebGPU 渲染门)+`index.html`+双 tsconfig。

## 验收证据

`test-output/hc7p2-templates-20261002/`:`report.json`(8/8 passed)、每模板 `*-rendered.png`(渲染态)/`*-browser.png`(协议收尾)、`kit-tests.log`、`distribution.json`、`skill-verify.json`、`progress-01..04.json`。

## 版本升级流程

deep-engine 升版 → 改 `references/sdk-versions.json`(唯一改动点)→ `pnpm gate:hc7p2-templates` 取新像素证据 → `distribute-skill.mjs` 重分发。`version-pin.test.mjs` 在漏改任一处时红灯并给出该流程提示。
