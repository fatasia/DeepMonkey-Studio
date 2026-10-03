# H-C7-P2 行遗留两断言收口(SDK 线路)

日期:2026-10-02。上游:`docs/specs/hc7p2-templates-20261002.md` §5"过程发现(SDK 侧遗留)"第 1、3 条。
所有权线内:templates/、sdk-versions、hc7p2 gate 脚本(含其共享 lib);主线程域(behavior/ai/viewer/api/physics)与另一路(data-center/script-git/IndustrialAgentWorkspace)未触碰。

## 现状核查

- 两处不一致均为 `hc7p2-templates-20261002.md` 已登记的已知项,无他人正在修(git status 中 templates/、scripts/lib/、packages/deep-engine 无本会话外改动)。
- 断言代码唯一:`scripts/lib/deepEngineConsumerPackages.mjs:14`(组别断言);同机制排查 `gate-sdk-consumer.mjs`、`packages/deep-engine/scripts/standaloneConsumerExamples.mjs` 走 overrides/合并口径,无第二处。
- `packages/deep-engine/package.json:257-258`:`@webgpu/types: 0.1.72` 挂 **devDependencies**;`references/sdk-versions.json` provenance 却写 `#dependencies.@webgpu/types`(陈旧标签)。

## 断言②:共享 lib devDependencies 断言(已修,全门验证)

**根因**:旧 SDK 消费门(`pnpm gate:deep-engine-consumer` → `scripts/gate-deep-engine-consumer.mjs` → 共享 lib `scripts/lib/deepEngineConsumerPackages.mjs`)断言

```
engine.manifest.dependencies?.["@webgpu/types"] === "0.1.72"
```

而引擎 manifest 现把 `@webgpu/types` 挂在 devDependencies(types-only 包)。现行的两个检测器早已定调另一合同:`templates/deep-engine-3d/scripts/version-pin.test.mjs` 用 `{...dependencies, ...devDependencies}` 合并口径,`templates/deep-engine-3d/scripts/gate-templates.mjs:53` 注释明说"组别校验由 pin 检查承担"且模板门自带打包、刻意不走共享 lib。即:**包形态(devDependencies)是现行合同,lib 里的组别断言是漂移遗留**。外部消费者的类型解析本就不依赖该组——lib 自己单独 pack `@webgpu/types` 并以 consumer 直接依赖 + pnpm override 安装,tsc `--listFilesOnly` 断言 `/@webgpu/types/dist/index.d.ts` 从隔离安装包解析。

**处置**(修断言,不动包形态;理由:①现行两检测器+模板门注释已定调;②devDependencies 是 types-only 包常规形态;③`packages/deep-engine/package.json` 不在线内):
- `scripts/lib/deepEngineConsumerPackages.mjs`:断言改为合并声明口径取 `@webgpu/types === "0.1.72"`(exact 不变),注释写明类型解析由单独 pack + override 保证。
- `templates/deep-engine-3d/references/sdk-versions.json`:provenance `webgpuTypesManifest` 纠偏为 `packages/deep-engine/package.json#devDependencies.@webgpu/types`(自身产物的事实纠偏)。
- 连带修复(同门第一次重跑暴露的第二层):win32 + Git Bash 下 GNU tar 把 `C:\...` 当远程主机(`tar: Cannot connect to C: resolve failed`,exit 128)。机制级单点修复:共享 lib `scripts/lib/sdkConsumerPackages.mjs` 模块加载时前置 System32 优先用 bsdtar——与 `gate-templates.mjs:22-27` 既有守卫同一机制,惠及 `runLogged` 的全部 tar 调用方(`gate-sdk-consumer`、`gate-deep-engine-consumer`、`standaloneConsumerExamples`)。

**验证**(`pnpm gate:deep-engine-consumer`,2026-10-02,status=passed,14 步全绿):
pack/contents/manifest(deep-engine + webgpu-types)→ install-offline → runtime-resolution → types-node-next/types-browser-bundler/type-resolution → emit-node-consumer → runtime-node;esbuild 自包含 bundle 2,285,589 B;Chrome 154.0.8037.95 WebGPU rendererId=deep-webgpu,像素证据 distinctFromCorner=138,463,issues=[],截图 `test-output/deep-engine-consumer-20260922/deep-engine-consumer-browser.png`。报告:`test-output/deep-engine-consumer-20260922/report.json`。

## 断言①:RenderInstance.outline 位不一致(根因已钉死,引擎域,登记不越线)

**机制**(全部位于 `packages/deep-engine`,非模板域):
1. 打包侧 `src/renderPacketBatches.ts:66`:`if (instance.outline === true) staging[offset + 31]! += 256;`——对象级 outline 位写入实例记录的 surfaceFlags 字(`renderPacketTypes.ts:118-119` 契约注释"encoded in instance flags bit 256")。
2. 账本作者侧 `src/webgpu/materialEffectLedger.ts:80-84`:`authorValues` 的 surfaceFlags 只折叠材质位(1 double/2 mask/4+2 blend/16 阴影 off/32 fog off/64 unlit/128 premultiplied)+ 阴影实参,**函数根本不接收 instance**,无法知道 outline。
3. 账本消费侧 `materialEffectLedger.ts:102`:`data[offset + 31]! % 1024` 保留 256 → `assertValues` 对比 authored(无 256)vs consumed(有 256)→ 抛 `Material effect ledger mismatch for {id}: surfaceFlags`。调用点在 `webgpu/packetBuffers.ts:100/166/216`,即 DeepApp 初始化/上传即炸。
4. WGSL 侧零 outline 实现(全 `src/**/*.wgsl` 无 outline 消费)——即便对齐账本,渲染效果也不存在,是**引擎未落地的能力且两半自相矛盾**。两者同源于提交 `4f944ce2`,非时间漂移;`renderPacket.test.ts` 只测 render-packet 层所以绿灯。

**可执行复现**(纯 TS,仓外临时目录 `%TEMP%/outline-ledger-repro/`,deep-engine 自带 esbuild 打包后 Node 运行;未向仓库新增任何文件):脚本构造 `renderPacket.test.ts` 同形最小场景,对 `prepareRenderPacket(...).batches` 直接调 `compileMaterialEffectLedger`:
- 控制组(无 outline):账本编译通过,entries=1。
- 实验组(`outline: true`):pack 侧实例记录 word31 & 256 = 256;账本抛 `Material effect ledger mismatch for outlined: surfaceFlags.`

**处置**:模板侧无锚点可修——8 模板全部使用已验证的自发光高亮方案,不引用 outline;我线内也不存在检查 outline 的检测基准。根因落在 `packages/deep-engine`(renderPacketBatches 与 materialEffectLedger 的合同分裂 + WGSL 未实现),按边界条款**停下登记,不越线修引擎**。修复建议(供引擎线路,任一即可闭合):让 `authorValues` 接收 instance 并折叠 `outline===true?256:0`,或在消费侧对比时屏蔽位 256;落地渲染还需 WGSL outline pass。注意 `apps/web/src/delivery/compileSceneRenderPacket.ts:152`、`compileLinearPrefabRenderPacket.ts:56` 会把 `effects.outline` 编译进 render packet,主线程 WebGPU 线路踩中同一雷,建议引擎线路收口时一并回归。

## 门禁输出汇总

| 门 | 结果 | 关键证据 |
|---|---|---|
| `node --test templates/deep-engine-3d/scripts/version-pin.test.mjs` | 4 pass / 0 fail | pin 与 manifest 一致 |
| `distribute-skill.mjs --force` + `verify-distribution.mjs` | passed,identical=true,exit 0 | 双端 sdk-versions.json SHA-256 一致:`84ed98b8…c29a`;14 导出名核对 |
| `pnpm gate:deep-engine-consumer` | passed(修复后首跑) | 14 步 + Chrome WebGPU 像素 138,463 |
| `pnpm gate:hc7p2-templates` | 见下节 | 8 模板全门 + 双端分发字节一致 |

## 模板全门(无回归确认)

`pnpm gate:hc7p2-templates` 于 2026-10-02 修复后重跑,**passed(exit 0),8/8 模板全绿**,逐模板像素与交付基线逐值一致(01:57,585 / 02:150,784 / 03:139,386 / 04:125,686 / 05:147,617 / 06:109,279 / 07:132,448 / 08:71,725,全部 >30,000);每模板 Chrome 双截图(`NN-id-browser.png` 渲染态 + `NN-id-rendered.png` 协议截图,证据目录 `test-output/hc7p2-templates-20261002/`),pins 与 sdk-versions 一致(0.1.0 / 0.1.72),`distribution.json` identical=true(双端 `.agents`/`.claude` 字节一致)。报告:`test-output/hc7p2-templates-20261002/report.json`。本批两处修改(共享 lib 断言、sdk-versions provenance)不改变模板门路径,结果与交付基线相同。

## 改动足迹与边界声明

- 改动(3 文件,均线内):
  1. `scripts/lib/deepEngineConsumerPackages.mjs` —— 组别断言改合并口径(+注释)。
  2. `scripts/lib/sdkConsumerPackages.mjs` —— win32 tar 守卫(同族机制单点)。
  3. `templates/deep-engine-3d/references/sdk-versions.json` —— provenance 路径纠偏;并重分发双端。
- 未触碰:packages/deep-engine 源码与 manifest、apps/web 主线程域、另一路会话域;无 cargo;无 commit/push/reset/clean/stash。
- 断言① 为登记不修:根因与复现证据如上,修复属引擎线路。
