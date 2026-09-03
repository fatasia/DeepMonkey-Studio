import { useMemo, useRef, useState } from "react";
import type { ApplicationScriptTarget } from "@bim-studio/contracts";
import { Box, ChevronDown, LayoutDashboard, Search, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneScriptTarget } from "../studio/sceneScriptContext";

interface SceneBehaviorTargetPickerProps {
  locale: AppLocale;
  value: ApplicationScriptTarget | undefined;
  targets: readonly SceneScriptTarget[];
  preferredTarget?: SceneScriptTarget;
  onChange: (target: ApplicationScriptTarget) => void;
}

/** Searchable, context-grouped target picker shared by the docked and floating script workspaces. */
export function SceneBehaviorTargetPicker(props: SceneBehaviorTargetPickerProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState("");
  const allTargets = useMemo(() => {
    const targets = [...props.targets];
    if (props.preferredTarget && !targets.some((target) => target.kind === props.preferredTarget?.kind && target.id === props.preferredTarget.id)) {
      targets.unshift(props.preferredTarget);
    }
    return targets.slice(0, 300);
  }, [props.preferredTarget, props.targets]);
  const selected = props.value?.kind === "scene"
    ? undefined
    : allTargets.find((target) => target.kind === props.value?.kind && target.id === props.value.id);
  const sceneSelected = !props.value || props.value.kind === "scene";
  const missingTargetId = props.value && props.value.kind !== "scene" && !selected ? props.value.id : undefined;
  const missingTarget = Boolean(missingTargetId);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const groups = useMemo(() => {
    const filtered = allTargets.filter((target) => !normalizedQuery || `${target.name} ${target.id} ${target.context}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    const byContext = new Map<string, SceneScriptTarget[]>();
    for (const target of filtered) byContext.set(target.context, [...(byContext.get(target.context) ?? []), target]);
    return [...byContext.entries()];
  }, [allTargets, normalizedQuery]);

  function choose(target: ApplicationScriptTarget) {
    props.onChange(target);
    setQuery("");
    detailsRef.current?.removeAttribute("open");
  }

  const selectedKind = selected?.kind === "object"
    ? tr(props.locale, "三维对象", "3D object")
    : selected?.runtime === "unity"
      ? "Unity"
      : tr(props.locale, "二维资源", "2D resource");

  return (
    <div className={`behavior-target-field ${missingTarget ? "invalid" : ""}`}>
      <span id="behavior-target-label">{tr(props.locale, "挂载到", "Attach to")}</span>
      <details ref={detailsRef} className="behavior-target-picker">
        <summary aria-labelledby="behavior-target-label behavior-target-current">
          <span id="behavior-target-current">
            <strong>{selected?.name ?? (sceneSelected ? tr(props.locale, "整个场景", "Whole scene") : missingTargetId)}</strong>
            <small>
              {selected
                ? `${selected.context} · ${selectedKind}`
                : sceneSelected
                  ? tr(props.locale, "场景生命周期", "Scene lifecycle")
                  : tr(props.locale, "目标已失效 · 请重新选择", "Missing target · choose another")}
            </small>
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </summary>
        <div className="behavior-target-popover">
          <label className="behavior-target-search" aria-label={tr(props.locale, "搜索脚本挂载目标", "Search script targets")} title={tr(props.locale, "搜索脚本挂载目标", "Search script targets")}>
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr(props.locale, "搜索页面、场景、对象或资源", "Search pages, scenes, objects or resources")}
              aria-label={tr(props.locale, "搜索脚本挂载目标", "Search script targets")}
            />
            {query && <button type="button" aria-label={tr(props.locale, "清空搜索", "Clear search")} onClick={() => setQuery("")}><X size={12} /></button>}
          </label>
          <div className="behavior-target-options" role="listbox" aria-label={tr(props.locale, "脚本挂载目标", "Script targets")}>
            <button type="button" role="option" aria-selected={sceneSelected} className={sceneSelected ? "selected" : ""} onClick={() => choose({ kind: "scene" })}>
              <LayoutDashboard size={14} aria-hidden="true" />
              <span><strong>{tr(props.locale, "整个场景", "Whole scene")}</strong><small>{tr(props.locale, "场景启动、更新与数据事件", "Scene lifecycle and data events")}</small></span>
            </button>
            {groups.map(([context, targets]) => (
              <section key={context} aria-label={context}>
                <header>{context}<small>{targets.length}</small></header>
                {targets.map((target) => {
                  const active = selected?.kind === target.kind && selected.id === target.id;
                  const kind = target.kind === "object" ? tr(props.locale, "三维对象", "3D object") : target.runtime === "unity" ? "Unity" : tr(props.locale, "二维资源", "2D resource");
                  return (
                    <button key={`${target.kind}:${target.id}`} type="button" role="option" aria-selected={active} className={active ? "selected" : ""} onClick={() => choose({ kind: target.kind, id: target.id })}>
                      <Box size={14} aria-hidden="true" />
                      <span><strong>{target.name}</strong><small>{kind} · {target.id}</small></span>
                    </button>
                  );
                })}
              </section>
            ))}
            {normalizedQuery && groups.length === 0 && <p>{tr(props.locale, "没有匹配目标", "No matching targets")}</p>}
          </div>
        </div>
      </details>
    </div>
  );
}
