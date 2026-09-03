import { useMemo, useState, type ReactNode } from "react";
import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import { AlertTriangle, Box, Code2, Database, LayoutPanelTop, Radio, Search, Sparkles } from "lucide-react";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { translate as tr, type AppLocale } from "../i18n";
import { applySceneScriptDeclarations, type SceneScriptAnalysis } from "../studio/sceneScriptAnalysis";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { capabilitySnippet, runtimeStatus, safeIdentifier, sceneScriptResourceSnippet } from "./sceneBehaviorPanelModel";

const lifecycleOptions: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
const permissionOptions: ApplicationScriptPermission[] = ["scene.read", "scene.write", "data.read", "data.write", "ai.invoke", "network.connect", "renderer.extend", "editor.extend"];
const capabilityOptions: SceneCapability[] = ["studio.object", "studio.component", "studio.unity", "studio.camera", "studio.animation", "studio.data", "studio.ai", "studio.runtime"];

interface Props {
  locale: AppLocale;
  draft: ScriptModule;
  analysis?: SceneScriptAnalysis;
  runtime?: SceneBehaviorManagerEntry;
  codeTargets: readonly SceneScriptTarget[];
  intelligence: SceneScriptIntelligenceContext;
  onDraftChange: (script: ScriptModule) => void;
  onInsertCode: (code: string) => void;
}

/** 高级声明、项目资源和运行诊断独立于主编辑器，便于按需显示与维护。 */
export function SceneBehaviorInspector(props: Props) {
  const [query, setQuery] = useState("");
  const [insertedTargets, setInsertedTargets] = useState<Set<string>>(new Set());
  const declarationGap = Boolean(
    props.analysis?.missingCapabilities.length
    || props.analysis?.missingPermissions.length
    || (props.analysis && props.analysis.lifecycle.some((item) => !props.draft.lifecycle.includes(item))),
  );
  const visibleTargets = useMemo(() => filterTargets(props.codeTargets, query), [props.codeTargets, query]);
  const visibleDataKeys = useMemo(() => filterStrings(props.intelligence.dataKeys, query, 40), [props.intelligence.dataKeys, query]);
  const visibleEvents = useMemo(() => filterStrings(props.intelligence.eventNames, query, 40), [props.intelligence.eventNames, query]);

  function insertTarget(target: SceneScriptTarget) {
    const variable = safeIdentifier(target.name, target.kind === "object" ? "object" : "component");
    props.onInsertCode(target.kind === "object"
      ? `const ${variable} = studio.object(${JSON.stringify(target.id)});\n${variable}?.focus();`
      : target.runtime === "unity"
        ? `const ${variable} = studio.unity(${JSON.stringify(target.id)});\n${variable}.setProperties({ lightIntensity: 1.5 });`
        : `const ${variable} = studio.component(${JSON.stringify(target.id)});\n${variable}?.update({});`);
    setInsertedTargets((current) => new Set(current).add(`${target.kind}:${target.id}`));
    const capability: SceneCapability = target.kind === "object" ? "studio.object" : target.runtime === "unity" ? "studio.unity" : "studio.component";
    if (!props.draft.capabilities.includes(capability)) props.onDraftChange({ ...props.draft, capabilities: [...props.draft.capabilities, capability] });
  }

  function insertData(key: string, mode: "data-read" | "data-write") {
    props.onInsertCode(sceneScriptResourceSnippet(mode, key));
    const permission: ApplicationScriptPermission = mode === "data-read" ? "data.read" : "data.write";
    props.onDraftChange({
      ...props.draft,
      capabilities: props.draft.capabilities.includes("studio.data") ? props.draft.capabilities : [...props.draft.capabilities, "studio.data"],
      permissions: props.draft.permissions.includes(permission) ? props.draft.permissions : [...props.draft.permissions, permission],
    });
  }

  function insertEvent(name: string, mode: "event-listen" | "event-emit") {
    const hasOnEvent = /\b(?:async\s+)?function\s+onEvent\s*\(|\b(?:const|let|var)\s+onEvent\s*=/.test(props.draft.code);
    props.onInsertCode(sceneScriptResourceSnippet(mode === "event-listen" && hasOnEvent ? "event-condition" : mode, name));
    props.onDraftChange({
      ...props.draft,
      lifecycle: mode === "event-listen" && !props.draft.lifecycle.includes("onEvent") ? [...props.draft.lifecycle, "onEvent"] : props.draft.lifecycle,
      capabilities: mode === "event-emit" && !props.draft.capabilities.includes("studio.runtime") ? [...props.draft.capabilities, "studio.runtime"] : props.draft.capabilities,
    });
  }

  function toggle<K extends "lifecycle" | "permissions" | "capabilities">(key: K, value: ScriptModule[K][number]) {
    const values = props.draft[key] as string[];
    props.onDraftChange({ ...props.draft, [key]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] });
  }

  function toggleCapability(capability: SceneCapability) {
    const enabling = !props.draft.capabilities.includes(capability);
    let next: ScriptModule = {
      ...props.draft,
      capabilities: enabling ? [...props.draft.capabilities, capability] : props.draft.capabilities.filter((item) => item !== capability),
    };
    if (enabling && capability === "studio.ai" && !next.permissions.includes("ai.invoke")) next = { ...next, permissions: [...next.permissions, "ai.invoke"] };
    props.onDraftChange(next);
    if (enabling) props.onInsertCode(capabilitySnippet(capability));
  }

  function togglePermission(permission: ApplicationScriptPermission) {
    const enabling = !props.draft.permissions.includes(permission);
    toggle("permissions", permission);
    if (enabling && permission === "network.connect") props.onInsertCode('const response = await studio.net.fetch("https://api.example.com/data", { credentialRef: "api-credential" });\nstudio.log("gateway response", response.value);');
  }

  return <aside className="behavior-inspector">
    <section className={`behavior-script-assistant ${props.analysis?.issues.some((issue) => issue.severity === "error") ? "has-error" : declarationGap ? "has-warning" : "ready"}`}>
      <header><span><Sparkles size={12} /><strong>{tr(props.locale, "脚本助手", "Script assistant")}</strong></span><small>{props.analysis?.issues.length ?? 0} {tr(props.locale, "项诊断", "diagnostics")}</small></header>
      {props.analysis && <><p>{props.analysis.lifecycle.length
        ? tr(props.locale, `已识别 ${props.analysis.lifecycle.length} 个生命周期，${props.analysis.capabilities.length} 类场景能力。`, `${props.analysis.lifecycle.length} lifecycle hooks and ${props.analysis.capabilities.length} SDK capabilities detected.`)
        : tr(props.locale, "请先添加 onStart、onUpdate 等生命周期函数。", "Add an onStart, onUpdate, or another lifecycle function.")}</p>
      {declarationGap
        ? <button type="button" onClick={() => props.onDraftChange(applySceneScriptDeclarations(props.draft, props.analysis!))}><Sparkles size={11} />{tr(props.locale, "一键补齐声明", "Complete declarations")}</button>
        : props.analysis.lifecycle.length > 0 && <small>{tr(props.locale, "代码与生命周期、能力、权限声明已对齐。", "Code and lifecycle, capability, and permission declarations are aligned.")}</small>}</>}
    </section>

    <section className="behavior-code-library">
      <header><strong>{tr(props.locale, "对象与组件", "Objects & components")}</strong><small>{tr(props.locale, "勾选即插入光标处", "Check to insert at cursor")}</small></header>
      <label className="behavior-library-search"><Search size={11} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(props.locale, "搜索名称或 ID", "Search name or ID")} /></label>
      <div className="behavior-target-list">
        {visibleTargets.map((target) => {
          const key = `${target.kind}:${target.id}`;
          return <label key={key} title={`${target.context} · ${target.id}`}><input type="checkbox" checked={insertedTargets.has(key)} onChange={() => insertTarget(target)} />{target.kind === "object" ? <Box size={11} /> : <LayoutPanelTop size={11} />}<span><b>{target.name}</b><small>{target.context}</small></span></label>;
        })}
        {!visibleTargets.length && <p>{tr(props.locale, "没有匹配的对象或组件", "No matching objects or components")}</p>}
      </div>
    </section>

    <section className="behavior-code-library behavior-project-resources">
      <header><strong>{tr(props.locale, "数据与事件", "Data & events")}</strong><small>{props.intelligence.dataKeys.length} + {props.intelligence.eventNames.length}</small></header>
      <ResourceGroup icon={<Database size={11} />} title={tr(props.locale, "项目数据键", "Project data keys")} empty={tr(props.locale, "没有匹配的数据键", "No matching data keys")} values={visibleDataKeys} firstLabel={tr(props.locale, "读取", "Read")} secondLabel={tr(props.locale, "写入", "Write")} onFirst={(key) => insertData(key, "data-read")} onSecond={(key) => insertData(key, "data-write")} />
      <ResourceGroup icon={<Radio size={11} />} title={tr(props.locale, "场景事件", "Scene events")} empty={tr(props.locale, "没有匹配的事件", "No matching events")} values={visibleEvents} firstLabel={tr(props.locale, "监听", "Listen")} secondLabel={tr(props.locale, "发出", "Emit")} onFirst={(name) => insertEvent(name, "event-listen")} onSecond={(name) => insertEvent(name, "event-emit")} />
    </section>

    <section><strong>{tr(props.locale, "生命周期", "Lifecycle")}</strong><div className="behavior-option-grid">{lifecycleOptions.map((item) => <label key={item}><input type="checkbox" checked={props.draft.lifecycle.includes(item)} onChange={() => toggle("lifecycle", item)} /><code>{item}</code></label>)}</div></section>
    <section><header className="behavior-section-heading"><strong>{tr(props.locale, "API 能力", "API capabilities")}</strong><small>{tr(props.locale, "启用并插入示例", "Enable and insert example")}</small></header><div className="behavior-option-grid compact">{capabilityOptions.map((item) => <label key={item}><input type="checkbox" checked={props.draft.capabilities.includes(item)} onChange={() => toggleCapability(item)} /><Code2 size={10} /><code>{item}</code></label>)}</div></section>
    <section><strong>{tr(props.locale, "权限", "Permissions")}</strong><div className="behavior-option-grid compact">{permissionOptions.map((item) => <label key={item}><input type="checkbox" checked={props.draft.permissions.includes(item)} onChange={() => togglePermission(item)} /><code>{item}</code></label>)}</div>{props.draft.permissions.includes("network.connect") && <p className="behavior-warning"><AlertTriangle size={12} />{tr(props.locale, "HTTP 经服务器代理并执行域名、端口、凭据与响应大小策略；WebSocket 数据通过 onData 接收。", "HTTP runs through the server gateway policy; receive WebSocket binding updates through onData.")}</p>}</section>
    <RuntimeSummary locale={props.locale} {...(props.runtime ? { runtime: props.runtime } : {})} />
  </aside>;
}

function ResourceGroup(props: { icon: ReactNode; title: string; empty: string; values: readonly string[]; firstLabel: string; secondLabel: string; onFirst: (value: string) => void; onSecond: (value: string) => void }) {
  return <div className="behavior-resource-group"><b>{props.icon}{props.title}</b><div>{props.values.map((value) => <div key={value} title={value}><code>{value}</code><span><button type="button" onClick={() => props.onFirst(value)}>{props.firstLabel}</button><button type="button" onClick={() => props.onSecond(value)}>{props.secondLabel}</button></span></div>)}</div>{!props.values.length && <small>{props.empty}</small>}</div>;
}

function RuntimeSummary({ locale, runtime }: { locale: AppLocale; runtime?: SceneBehaviorManagerEntry }) {
  return <section className="behavior-runtime-summary"><strong>{tr(locale, "运行诊断", "Runtime diagnostics")}</strong>{runtime ? <dl>
    <div><dt>{tr(locale, "状态", "Status")}</dt><dd>{runtimeStatus(runtime.diagnostics.status, locale)}</dd></div>
    <div><dt>{tr(locale, "待处理", "Pending")}</dt><dd>{runtime.diagnostics.pendingInvocations}</dd></div>
    <div><dt>{tr(locale, "平均耗时", "Average")}</dt><dd>{runtime.diagnostics.averageExecutionMs.toFixed(2)} ms</dd></div>
    <div><dt>{tr(locale, "丢弃调用", "Dropped")}</dt><dd>{runtime.diagnostics.droppedInvocations}</dd></div>
  </dl> : <small>{tr(locale, "点击“运行已启用”开始预览。", "Select Run enabled to start the preview.")}</small>}</section>;
}

function filterStrings(values: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLocaleLowerCase();
  return values.filter((value) => !needle || value.toLocaleLowerCase().includes(needle)).slice(0, limit);
}

function filterTargets(values: readonly SceneScriptTarget[], query: string): SceneScriptTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  return values.filter((target) => !needle || `${target.name} ${target.id} ${target.context}`.toLocaleLowerCase().includes(needle)).slice(0, 120);
}
