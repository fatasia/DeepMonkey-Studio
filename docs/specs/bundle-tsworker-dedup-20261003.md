# Monaco TS worker 去重记录（2026-10-03）

## 现状核查

### 1. 全仓关键词与未跟踪文件

- 已查 `apps/*/src`、`packages/*/src` 中的 `MonacoEnvironment`、`getWorker`、`new Worker(`、`?worker`、`ts.worker`、`typescript.worker`、`monacoTypescript.worker`。
- 修改前真实 Monaco worker 入口：
  - `apps/web/src/components/professionalCodeServices.ts` 中 `MonacoEnvironment.getWorker` 按 `javascript/typescript` 返回 `../workers/monacoTypescript.worker.ts`，其它 label 返回 `../workers/monacoEditor.worker.ts`。
  - `apps/web/src/workers/monacoTypescript.worker.ts` 仅导入 `monaco-editor/esm/vs/language/typescript/ts.worker.js`。
  - `apps/web/src/workers/monacoEditor.worker.ts` 仅导入 `monaco-editor/esm/vs/editor/editor.worker.js`。
- 未跟踪文件很多（本次抽样为 476 个），包含与本任务相关但不是本次创建的：
  - `apps/web/scripts/hc6s1-monaco-normal-browser.mjs`
  - `docs/specs/optimization-phase-plan-20261003.md`
  - `docs/specs/jc-i-continuation-20261001.md`
- `apps/web/vite.config.ts` 与 `apps/web/src/workers/monacoTypescript.worker.ts` 在开工前已显示为 modified，但 `git diff` 无内容差异，仅有 CRLF/LF 警告；本次没有把这些行尾状态当作功能改动。

### 2. 契约层与类型

- `packages/contracts/src` 没有 Monaco worker / Vite worker 合同；`packages/docs-runtime/src/types.ts`、`packages/deep-engine/src/*/types.ts` 中的 `language` 字段与编辑器 bundle 去重无关。
- `apps/web/src/types/monaco-contribution.d.ts` 只声明了 `monaco-editor/language/typescript/monaco.contribution.js` 模块，说明现有代码已经围绕 TS/JS 贡献做过类型补洞。

### 3. 依赖

- `apps/web/package.json` 已有依赖：
  - `@monaco-editor/react@^4.7.0`
  - `monaco-editor@^0.57.0`
  - `vite@^8.1.0`（实际构建输出为 Vite 8.2.0）
- 未新增依赖。

### 4. 消费方

- `@monaco-editor/react` 的产品消费方集中在 `ProfessionalCodeEditor.tsx`。
- 实际编辑器语言：
  - `ProfessionalCodeEditor.tsx` 传入 `language="javascript"`。
  - `professionalCodeServices.ts` 注册 JS completion/hover，并配置 `javascriptDefaults`。
- `typescript` 字面量也出现在脚本元数据/测试中，但实际 Monaco editor model 使用 `javascript`；需要保留 TypeScript language service worker，因为 JS 智能提示/诊断由 Monaco TS worker 承担。
- 未发现产品实际需要 Monaco `css/html/json` language worker。

### 5. 测试与证据

- 已存在 Monaco 常态浏览器验收脚本 `apps/web/scripts/hc6s1-monaco-normal-browser.mjs`，账本记录其曾验证 `.monaco-editor`、诊断与保存链路。
- 相关单测/证据入口：
  - `apps/web/src/components/professionalCodeTypeCheck.test.ts`
  - `apps/web/src/components/professionalCodeIntelligence.test.ts`
  - `apps/web/src/components/ProfessionalCodeEditor.tsx`
- 本轮完整 post-change `vite build` 被并行/既存改动阻断，详见“验证记录”。

### 6. 规格文档

- `docs/specs/optimization-phase-plan-20261003.md` 记录：`monacoTypescript.worker` 6.6M 与 `ts.worker` 6.6M 字节完全相同；`toggleHighContrast` 1.14M 是 Monaco 公共贡献模块命名，不是功能异常。
- `docs/specs/jc-i-continuation-20261001.md` 追加一百零二记录：三方案已失败并回滚：
  1. 删除 alias：worker 上下文解析失败。
  2. 相对实体路径直引：构建通过但双份依旧。
  3. alias 指空 stub：不生效。
- 追加一百零二给出的根因：Monaco TS 贡献模块内部 `new URL('ts.worker.js', import.meta.url)` 会被 Vite worker 插件静态拆出 `ts.worker`；同时自定义 `MonacoEnvironment.getWorker` 又返回自定义 wrapper，导致内部 `ts.worker` 成为运行时死重。

### 已有（不重建）

- JS/TS 智能提示与诊断能力已经由 Monaco TS language service 提供，不需要新增 worker 或依赖。
- Vite alias 仍保留；不重复尝试追加一百零二已证明失败的删 alias、相对实体路径直引、stub 方案。

### 真实缺口

- 需要移除运行时 `MonacoEnvironment.getWorker` 对 TS worker 的自定义覆盖，让 Monaco TS 贡献模块内部唯一 `ts.worker` 成为实际 worker。
- 需要避免 `import("monaco-editor")` 全量入口拉入未使用的 css/html/json 语言 worker。

## 方案与改动

- `professionalCodeServices.ts`
  - 移除全局 `MonacoEnvironment.getWorker` 覆盖。
  - `loadMonacoEditor()` 从 `import("monaco-editor")` 改为 `import("monaco-editor/editor/editor.api.js")`。
  - 显式加载 Monaco editor 贡献集合与 JavaScript language definition：
    - `monaco-editor/internal/common/workers.js`
    - `monaco-editor/languages/definitions/javascript/register.js`
  - 保留 `monaco-editor/language/typescript/monaco.contribution.js`，并继续把 TS contribution 写回 `languages.typescript`，供现有 `javascriptDefaults` 配置和 JS worker 使用。
- 删除不再引用的 wrapper worker：
  - `apps/web/src/workers/monacoTypescript.worker.ts`
  - `apps/web/src/workers/monacoEditor.worker.ts`

## 基线体积（完整 apps/web，修改前 `pnpm exec vite build`）

| 项 | 字节 | 说明 |
|---|---:|---|
| `dist/assets` 总量 | 75,704,041 | 完整产物资产总量 |
| `monacoTypescript.worker-Bcg7VksD.js` | 6,916,617 | SHA-256 与 `ts.worker` 完全相同 |
| `ts.worker-Bcg7VksD.js` | 6,916,617 | SHA-256 `B4610B8CE1A9EA9CA67C17DB6C4F0242899D1B19C1012CCE66958313C56B82C2` |
| `toggleHighContrast--_b4BOO3.js` | 1,195,178 | Monaco 公共贡献 chunk |
| 首屏 JS | 309,558 / gzip 99,337 | 17 个静态 chunk，`check-bundle-budget.mjs` 显示 302.3 KiB / gzip 97.0 KiB |

基线 worker 附带观察：还存在未被产品编辑器使用的 `css.worker`、`html.worker`、`json.worker`，来自 `monaco-editor` 全量入口。

## 验证记录

### 已通过

- `pnpm exec tsc --noEmit`
  - 本次 Monaco 类型错误已清除。
  - 当前仍失败于既存无关错误：`src/delivery/assetRevisionUpdate.ts(31,37)` 的 `RequestInit.signal` 精确可选属性类型问题。
- 临时 Monaco Vite probe（会话目录，不提交）：
  - 构建入口只导入本次修改后的 `loadMonacoEditor` / `configureProfessionalCodeServices`。
  - 产物仅有一个 TS worker：`ts.worker-Bcg7VksD.js`，6,916,617 字节，SHA-256 `B4610B8CE1A9EA9CA67C17DB6C4F0242899D1B19C1012CCE66958313C56B82C2`。
  - probe manifest 中未出现 `monacoTypescript.worker`、`monacoEditor.worker`、`css.worker`、`html.worker`、`json.worker`。
  - probe 总资产 11,262,988 字节，其中 Monaco 非 worker 主要 chunk 为 `editor.api-BOfGYG68.js` 2,738,304 字节、`workers-DPYTXoqP.js` 1,196,554 字节。

### 未完成 / 被阻塞

- 修改后的完整 `cd apps/web; pnpm exec vite build` 未能完成，因此没有可信的完整优化后总量/首屏表。
- 阻塞原因不是本次 Monaco 改动：Vite worker import-meta-url 阶段报错：
  - `src/delivery/pathTraceAuthorPreview.ts` 导入 `DEFAULT_DISPLAY_CONTRACT`。
  - `src/viewer/postProcessingRuntime.ts` 导入 `DEFAULT_DISPLAY_CONTRACT`。
  - 但 `packages/contracts/dist/index.js` 未导出 `DEFAULT_DISPLAY_CONTRACT`。
- `packages/contracts/src/displayContract.ts` 当前是未跟踪文件，`packages/contracts/dist` 未同步；相关 `viewer` 文件属于本任务禁止修改范围，本次没有修复或绕过。
- 集成浏览器工具不可用（`openBrowserPage` 报 “No client was connected”），本地 Node 也无法解析 `playwright` 包，因此未完成真实浏览器执行 JS worker 诊断的验证。已保留构建级 worker 入口证据，但不能宣称浏览器智能提示已在本轮实跑通过。

## 风险

- `monaco-editor/internal/common/workers.js` 是 Monaco 包内 internal 子路径；当前通过包的 wildcard exports 可解析，并能复用官方编辑器贡献集合，但 Monaco 升级时需要复查。
- probe 构建出现 `editor.api.js` 动态导入被静态 side-effect import 提前合并的提示。由于 `ProfessionalCodeEditor` 本身仍是产品懒加载链路的一部分，理论上首屏不应因此加载 Monaco；但完整 post-change build 被 contracts/dist 阻塞，首屏不增大尚未在完整产物中复验。


## 实施结果（2026-10-03 主会话复核）

- 去重后只删 wrapper 不够：缺少 MonacoEnvironment 时 Monaco 内部 editor worker 的 blob 路径无法解析（`Failed to resolve module specifier ../../../base/common/worker/webWorkerBootstrap.js`）。新增 `components/monacoWorkerEnvironment.ts`，两类 worker 以字面量 `new URL(...)` 指向 Monaco 源文件，并在 `professionalCodeServices.ts` 首位导入。
- 结果：`ts.worker` 仅 1 份（6,916,617 B）；`editor.worker` 303,226 B；dist/assets 总量 75,704,041 → 66,106,866 B（−9.6 MB）；首屏 303.6 KiB / gzip 97.7 KiB，bundle-budget 全绿。
- 实测：`hc6s1-monaco-normal-browser.mjs` 全绿（常态加载、诊断实时、保存、console-errors 为 0）。
