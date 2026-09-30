/**
 * G2-S2a 行为图节点属性表单(画布选中节点时的浮动检查器)。
 *
 * 体验纪律(用户指令:错误不弹窗):
 * - 表达式是文本输入,键入即经 restrictedEvaluator 编译校验;错误以输入框下内联
 *   红字 + 行/列 定位呈现(RestrictedExpressionSyntaxError.offset → 1 基行列),
 *   绝不使用 alert/confirm。
 * - 节点级参数错误显示 validateBehaviorGraph 的权威 issue(经投影透传,不转写);
 *   表达式类 issue 已由内联求值器错误承载,清单中去重避免同屏复读。
 * - JSON 字段(payload/params)用本地缓冲:非法 JSON 只标红不写草案,合法即提交,
 *   避免打字中途态破坏文档(文档键集是严格 hasKeys,任何多余键都不可落库)。
 * - 本组件零裁决:保存能否落库由 BehaviorGraphEditorSection 的门禁决定。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { BehaviorGraphIssue } from "../scripting/behaviorGraph";
import {
  ENGINE_COMMAND_OPTIONS,
  asDraftActionPatch,
  expressionIssueOf,
  formatExpressionMessage,
  type DraftNode,
} from "./behaviorGraphDraft";

export interface BehaviorGraphNodeFormProps {
  readonly locale: AppLocale;
  readonly node: DraftNode;
  /** 权威节点 issue(投影透传;展示口径)。 */
  readonly issues: readonly BehaviorGraphIssue[];
  readonly onPatch: (node: DraftNode) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

const KIND_LABELS: Record<string, readonly [string, string]> = {
  event: ["事件", "Event"],
  condition: ["条件", "Condition"],
  action: ["动作", "Action"],
  invalid: ["未知节点", "Unknown node"],
};

export function BehaviorGraphNodeForm({ locale, node, issues, onPatch, onDelete, onClose }: BehaviorGraphNodeFormProps) {
  const isEvent = node.kind === "event";
  const isCondition = node.kind === "condition";
  const isAction = node.kind === "action";
  const kindLabel = KIND_LABELS[node.kind] ?? KIND_LABELS.invalid!;

  /** 本节点全部表达式字段的即时求值器错误(行/列定位)。 */
  const expressionFields = collectExpressionFields(node);
  const expressionErrors = expressionFields
    .map((field) => ({ field, issue: expressionIssueOf(field.value) }))
    .filter((entry) => Boolean(entry.issue));
  // 表达式问题已由内联求值器错误承载(带行列),权威清单中去掉本节点的同类项避免同屏复读。
  const listedIssues = expressionErrors.length > 0
    ? issues.filter((issue) => !(issue.code === "invalid-expression" && issue.path.startsWith(`nodes[${node.id}]`)))
    : issues;

  return (
    <aside className="behavior-node-form" aria-label={tr(locale, "节点属性", "Node properties")} data-node-id={node.id}>
      <header>
        <i className={`is-${node.kind}`} />
        <strong>{kindLabel[0]}</strong>
        <code>{node.id}</code>
        <button
          type="button"
          className="behavior-node-form-close"
          title={tr(locale, "关闭", "Close")}
          aria-label={tr(locale, "关闭节点属性", "Close node properties")}
          onClick={onClose}
        >
          <X size={11} />
        </button>
      </header>
      <div className="behavior-node-form-body">
        {isEvent && <EventFields locale={locale} node={node} onPatch={onPatch} />}
        {isCondition && (
          <ExpressionInput
            locale={locale}
            label={tr(locale, "条件表达式", "Condition expression")}
            value={node.expression ?? ""}
            rows={3}
            onChange={(expression) => onPatch({ ...node, expression })}
          />
        )}
        {isAction && <ActionFields locale={locale} node={node} onPatch={onPatch} />}
        {!isEvent && !isCondition && !isAction && (
          <p className="behavior-node-form-note">
            {tr(locale, "该节点结构无法识别,请在源码 JSON 中修复。", "Unrecognized node structure — fix it in the JSON source.")}
          </p>
        )}
        {listedIssues.length > 0 && (
          <ul className="behavior-node-form-issues">
            {listedIssues.slice(0, 6).map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <code>{issue.code}</code>
                <span>{issue.message}</span>
              </li>
            ))}
            {listedIssues.length > 6 && (
              <li className="is-more">{tr(locale, `另有 ${listedIssues.length - 6} 个问题`, `${listedIssues.length - 6} more issues`)}</li>
            )}
          </ul>
        )}
      </div>
      <footer>
        {expressionErrors.length > 0 && (
          <span className="behavior-field-error">
            {tr(locale, `${expressionErrors.length} 处表达式待修正`, `${expressionErrors.length} expression(s) to fix`)}
          </span>
        )}
        <button type="button" className="behavior-node-form-delete" title={tr(locale, "删除节点(Del)", "Delete node (Del)")} onClick={onDelete}>
          <Trash2 size={11} />
          {tr(locale, "删除节点", "Delete")}
        </button>
      </footer>
    </aside>
  );
}

/* ------------------------------- 事件字段 ------------------------------- */

function EventFields({ locale, node, onPatch }: { locale: AppLocale; node: DraftNode; onPatch: (node: DraftNode) => void }) {
  const event = node.event ?? {};
  const patchEvent = (patch: Record<string, unknown>) => onPatch({ ...node, event: { ...event, ...patch } });
  if (event.kind === "tick") {
    const interval = typeof event.intervalMs === "number" ? event.intervalMs : 1_000;
    return (
      <label className="behavior-form-field">
        <span>{tr(locale, "间隔(毫秒,10–3600000)", "Interval (ms, 10–3600000)")}</span>
        <input
          type="number"
          min={10}
          max={3_600_000}
          step={10}
          value={String(interval)}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next) && e.target.value !== "") patchEvent({ intervalMs: next });
          }}
        />
      </label>
    );
  }
  if (event.kind === "data-change") {
    return (
      <label className="behavior-form-field">
        <span>{tr(locale, "数据键", "Data key")}</span>
        <input value={String(event.key ?? "")} onChange={(e) => patchEvent({ key: e.target.value })} placeholder="device.value" />
      </label>
    );
  }
  return (
    <label className="behavior-form-field">
      <span>{tr(locale, "场景事件名", "Scene event name")}</span>
      <input value={String(event.name ?? "")} onChange={(e) => patchEvent({ name: e.target.value })} placeholder="alarm" />
    </label>
  );
}

/* ------------------------------- 动作字段 ------------------------------- */

function ActionFields({ locale, node, onPatch }: { locale: AppLocale; node: DraftNode; onPatch: (node: DraftNode) => void }) {
  const action = node.action ?? {};
  const type = String(action.type ?? "");
  const patchAction = (patch: Record<string, unknown>) => onPatch({ ...node, action: asDraftActionPatch(action, patch) });
  const targetField = (required: boolean) => (
    <label className="behavior-form-field">
      <span>{required ? tr(locale, "目标对象(必填)", "Target (required)") : tr(locale, "目标对象(可选)", "Target (optional)")}</span>
      <input value={String(action.target ?? "")} onChange={(e) => patchAction({ target: e.target.value })} placeholder="model-id" />
    </label>
  );
  switch (type) {
    case "set-value":
      return (
        <>
          <label className="behavior-form-field">
            <span>{tr(locale, "数据键", "Data key")}</span>
            <input value={String(action.key ?? "")} onChange={(e) => patchAction({ key: e.target.value })} placeholder="level" />
          </label>
          <ExpressionInput
            locale={locale}
            label={tr(locale, "写入表达式", "Value expression")}
            value={String(action.expression ?? "")}
            rows={2}
            onChange={(expression) => patchAction({ expression })}
          />
        </>
      );
    case "emit-event":
      return (
        <>
          <label className="behavior-form-field">
            <span>{tr(locale, "事件名", "Event name")}</span>
            <input value={String(action.name ?? "")} onChange={(e) => patchAction({ name: e.target.value })} placeholder="alarm" />
          </label>
          <JsonValueField
            locale={locale}
            label={tr(locale, "payload(JSON,可选)", "Payload (JSON, optional)")}
            value={action.payload}
            rows={2}
            placeholder='{"level": 2}'
            onCommit={(payload) => patchAction({ payload })}
          />
        </>
      );
    case "animate":
      return (
        <>
          {targetField(false)}
          <label className="behavior-form-field">
            <span>{tr(locale, "命令", "Command")}</span>
            <select value={String(action.command ?? "play")} onChange={(e) => patchAction({ command: e.target.value })}>
              <option value="play">{tr(locale, "播放", "play")}</option>
              <option value="pause">{tr(locale, "暂停", "pause")}</option>
              <option value="stop">{tr(locale, "停止", "stop")}</option>
              <option value="toggle">{tr(locale, "切换", "toggle")}</option>
            </select>
          </label>
        </>
      );
    case "set-visibility":
      return (
        <>
          {targetField(true)}
          <label className="behavior-form-field">
            <span>{tr(locale, "模式", "Mode")}</span>
            <select value={String(action.mode ?? "toggle")} onChange={(e) => patchAction({ mode: e.target.value })}>
              <option value="show">{tr(locale, "显示", "show")}</option>
              <option value="hide">{tr(locale, "隐藏", "hide")}</option>
              <option value="toggle">{tr(locale, "切换", "toggle")}</option>
            </select>
          </label>
        </>
      );
    case "set-color":
      return (
        <>
          {targetField(true)}
          <label className="behavior-form-field">
            <span>{tr(locale, "颜色(#RRGGBB)", "Color (#RRGGBB)")}</span>
            <span className="behavior-form-color">
              <input
                type="color"
                aria-label={tr(locale, "取色器", "Color picker")}
                value={/^#[0-9a-fA-F]{6}$/.test(String(action.color ?? "")) ? String(action.color) : "#ff4057"}
                onChange={(e) => patchAction({ color: e.target.value })}
              />
              <input value={String(action.color ?? "")} onChange={(e) => patchAction({ color: e.target.value })} placeholder="#ff4057" />
            </span>
          </label>
        </>
      );
    case "set-opacity":
      return (
        <>
          {targetField(true)}
          <ExpressionInput
            locale={locale}
            label={tr(locale, "透明度表达式(0–1)", "Opacity expression (0–1)")}
            value={String(action.expression ?? "")}
            rows={2}
            onChange={(expression) => patchAction({ expression })}
          />
        </>
      );
    case "audio":
      return (
        <>
          {targetField(false)}
          <label className="behavior-form-field">
            <span>{tr(locale, "命令", "Command")}</span>
            <select value={String(action.command ?? "play")} onChange={(e) => patchAction({ command: e.target.value })}>
              <option value="play">{tr(locale, "播放", "play")}</option>
              <option value="pause">{tr(locale, "暂停", "pause")}</option>
              <option value="stop">{tr(locale, "停止", "stop")}</option>
            </select>
          </label>
        </>
      );
    case "trace":
      return (
        <>
          <label className="behavior-form-field">
            <span>{tr(locale, "消息", "Message")}</span>
            <input value={String(action.message ?? "")} maxLength={256} onChange={(e) => patchAction({ message: e.target.value })} />
          </label>
          <ExpressionInput
            locale={locale}
            label={tr(locale, "值表达式(可选)", "Value expression (optional)")}
            value={action.valueExpression === undefined ? "" : String(action.valueExpression)}
            rows={2}
            onChange={(expression) => patchAction({ valueExpression: expression === "" ? undefined : expression })}
          />
        </>
      );
    case "engine-command":
      return (
        <>
          <label className="behavior-form-field">
            <span>{tr(locale, "引擎命令", "Engine command")}</span>
            <select value={String(action.command ?? "camera.fly-to")} onChange={(e) => patchAction({ command: e.target.value })}>
              {ENGINE_COMMAND_OPTIONS.map((command) => (
                <option key={command} value={command}>{command}</option>
              ))}
            </select>
          </label>
          <JsonValueField
            locale={locale}
            label={tr(locale, "params(JSON)", "params (JSON)")}
            value={action.params}
            rows={3}
            placeholder="{}"
            onCommit={(params) => patchAction({ params })}
          />
        </>
      );
    default:
      return <p className="behavior-node-form-note">{tr(locale, "未知动作类型,请在源码 JSON 中修复。", "Unknown action type — fix it in the JSON source.")}</p>;
  }
}

/* --------------------------- 表达式输入(行/列定位) --------------------------- */

function ExpressionInput({ locale, label, value, rows, onChange }: {
  locale: AppLocale;
  label: string;
  value: string;
  rows: number;
  onChange: (value: string) => void;
}) {
  const issue = value.trim() ? expressionIssueOf(value) : undefined;
  return (
    <label className="behavior-form-field">
      <span>{label}</span>
      <textarea className={issue ? "is-invalid" : ""} rows={rows} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {issue && (
        <output className="behavior-field-error" role="status">
          {tr(locale, `第 ${issue.line} 行 第 ${issue.column} 列 · `, `Line ${issue.line}, column ${issue.column} · `)}
          {formatExpressionMessage(issue.message)}
        </output>
      )}
    </label>
  );
}

/* ------------------------------ JSON 值字段(本地缓冲) ------------------------------ */

/**
 * JSON 值字段:本地文本缓冲,非法 JSON 只内联标红、不写草案;合法即提交。
 * 外部值与本地最近提交分叉时(放弃更改/外部覆盖)自动回同步。
 */
function JsonValueField({ locale, label, value, rows, placeholder, onCommit }: {
  locale: AppLocale;
  label: string;
  value: unknown;
  rows: number;
  placeholder?: string;
  onCommit: (value: unknown) => void;
}) {
  const serialize = (input: unknown): string => (input === undefined ? "" : safeStringify(input));
  const [text, setText] = useState(() => serialize(value));
  const [error, setError] = useState<string | undefined>(undefined);
  const lastCommittedRef = useRef(serialize(value));
  useEffect(() => {
    const serialized = serialize(value);
    if (serialized !== lastCommittedRef.current) {
      lastCommittedRef.current = serialized;
      setText(serialized);
      setError(undefined);
    }
  }, [value]);
  const parsed = useMemo(() => parseLooseJson(text), [text]);
  return (
    <label className="behavior-form-field">
      <span>{label}</span>
      <textarea
        className={error || (!parsed.ok && text.trim()) ? "is-invalid" : ""}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (!next.trim()) {
            lastCommittedRef.current = "";
            setError(undefined);
            onCommit(undefined);
            return;
          }
          if (parsed.ok) {
            lastCommittedRef.current = next;
            setError(undefined);
            onCommit(parsed.value);
          } else {
            setError(parsed.message);
          }
        }}
      />
      {error && <output className="behavior-field-error" role="status">{error}</output>}
    </label>
  );
}

function parseLooseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "不是合法 JSON" };
  }
}

function collectExpressionFields(node: DraftNode): { key: string; value: string }[] {
  const fields: { key: string; value: string }[] = [];
  if (node.kind === "condition" && typeof node.expression === "string") fields.push({ key: `${node.id}:condition`, value: node.expression });
  const action = node.action;
  if (action) {
    if (typeof action.expression === "string") fields.push({ key: `${node.id}:action.expression`, value: action.expression });
    if (typeof action.valueExpression === "string") fields.push({ key: `${node.id}:action.valueExpression`, value: action.valueExpression });
  }
  return fields;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
