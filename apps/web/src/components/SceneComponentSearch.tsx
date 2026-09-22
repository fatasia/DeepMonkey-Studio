import { Search, X } from "lucide-react";
import { translate as tr } from "../i18n";
import type { SceneOutlinerPanelProps } from "./SceneOutlinerPanel";

export function ComponentSearch(props: SceneOutlinerPanelProps) {
  return (
    <section
      className="component-search"
      aria-label={tr(props.locale, "构件查询", "Component search")}
    >
      <div className="component-search-input">
        <Search size={15} />
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={tr(
            props.locale,
            "搜索名称、ID、属性",
            "Search name, ID or property",
          )}
          aria-label={tr(props.locale, "搜索构件", "Search components")}
        />
        {props.query && (
          <button
            title={tr(props.locale, "清空搜索", "Clear search")}
            onClick={() => props.onQueryChange("")}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {(props.facets.levels.length > 0 ||
        props.facets.categories.length > 0) && (
        <div className="component-filters">
          <select
            value={props.level}
            onChange={(event) => props.onLevelChange(event.target.value)}
            aria-label={tr(props.locale, "按楼层筛选", "Filter by floor")}
          >
            <option value="">
              {tr(props.locale, "全部楼层", "All floors")}
            </option>
            {props.facets.levels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={props.category}
            onChange={(event) => props.onCategoryChange(event.target.value)}
            aria-label={tr(props.locale, "按类别筛选", "Filter by category")}
          >
            <option value="">
              {tr(props.locale, "全部类别", "All categories")}
            </option>
            {props.facets.categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      )}
      {props.searchActive && (
        <div className="component-results">
          <div className="component-results-head">
            <span>
              {props.results.length} {tr(props.locale, "个结果", "results")}
            </span>
            <div>
              <button
                disabled={props.results.length === 0}
                onClick={props.onResultsIsolate}
              >
                {tr(props.locale, "隔离结果", "Isolate")}
              </button>
              {props.isolationActive && (
                <button onClick={props.onIsolationRestore}>
                  {tr(props.locale, "恢复", "Restore")}
                </button>
              )}
            </div>
          </div>
          <div className="component-result-list">
            {props.results.map((record) => (
              <button
                key={record.stableId}
                className={
                  props.selectedComponentId === record.stableId
                    ? "selected"
                    : ""
                }
                onClick={() => props.onResultFocus(record)}
              >
                <strong title={record.name}>{record.name}</strong>
                <small>
                  {[record.level, record.category, record.type]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </button>
            ))}
            {props.results.length === 0 && (
              <span className="component-no-result">
                {tr(props.locale, "没有匹配构件", "No matching components")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
