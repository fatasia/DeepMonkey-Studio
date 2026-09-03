import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Play,
  Save,
  WandSparkles,
  X,
} from "lucide-react";
import type {
  DataConnectionRecord,
  DataDatasetRecord,
  ModelRecord,
  ParametricCadDefinition,
} from "@bim-studio/contracts";
import {
  cloneParametricDefinition,
  listParametricBindingSources,
  PARAMETRIC_CAD_TEMPLATES,
  validateParametricCadDefinition,
} from "@bim-studio/parametric-modeling-plugin";
import { api } from "../api";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { buildParametricCad } from "./parametricCadRuntime";
import type { ParametricCadBuildResult } from "./parametricCadTypes";
import { createParametricGeneration } from "./parametricGeneration";
import { ParametricAiDraftPanel } from "./ParametricAiDraftPanel";
import { ParametricBindingEditor } from "./ParametricBindingEditor";
import { ParametricModelPreview } from "./ParametricModelPreview";
import "./ParametricModelWorkbench.css";

interface ParametricModelWorkbenchProps {
  projectId: string;
  locale: AppLocale;
  sourceModel?: ModelRecord;
  dataConnections?: DataConnectionRecord[];
  datasets?: DataDatasetRecord[];
  onClose: () => void;
  onSaved: (model: ModelRecord) => void | Promise<void>;
}

interface ParametricDraftOutput {
  definition: ParametricCadDefinition;
  model: string;
  providerId: string;
}

export default function ParametricModelWorkbench({
  projectId,
  locale,
  sourceModel,
  dataConnections = [],
  datasets = [],
  onClose,
  onSaved,
}: ParametricModelWorkbenchProps) {
  const sourceGeneration =
    sourceModel?.generation?.kind === "parametric"
      ? sourceModel.generation
      : undefined;
  const [templateId, setTemplateId] = useState(
    sourceGeneration ? "existing-version" : PARAMETRIC_CAD_TEMPLATES[0]!.id,
  );
  const [definition, setDefinition] = useState(() =>
    cloneParametricDefinition(
      sourceGeneration?.definition ?? PARAMETRIC_CAD_TEMPLATES[0]!.definition,
    ),
  );
  const [result, setResult] = useState<ParametricCadBuildResult>();
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const validation = useMemo(
    () => validateParametricCadDefinition(definition),
    [definition],
  );
  const bindingSources = useMemo(
    () => listParametricBindingSources({ dataConnections, datasets }),
    [dataConnections, datasets],
  );

  function selectTemplate(id: string) {
    const template = PARAMETRIC_CAD_TEMPLATES.find((item) => item.id === id);
    if (!template) return;
    abortRef.current?.abort();
    setTemplateId(id);
    setDefinition(cloneParametricDefinition(template.definition));
    setResult(undefined);
    setError(undefined);
  }

  function updateParameter(index: number, value: number) {
    setDefinition((current) => {
      const next = cloneParametricDefinition(current);
      next.parameters[index]!.value = value;
      return next;
    });
    setResult(undefined);
    setError(undefined);
  }

  function updateRuntimeBinding(parameterId: string, sourceKey: string) {
    const selected = bindingSources.find((source) => source.key === sourceKey);
    setDefinition((current) => {
      const next = cloneParametricDefinition(current);
      const bindings = [...(next.semanticBindings ?? [])];
      const index = bindings.findIndex(
        (binding) => binding.parameterId === parameterId,
      );
      const existing = index >= 0 ? bindings[index] : undefined;
      if (!selected) {
        if (existing?.targetId) {
          const { target: _target, ...semanticOnly } = existing;
          bindings[index] = semanticOnly;
        } else if (index >= 0) bindings.splice(index, 1);
      } else {
        const parameter = next.parameters.find(
          (item) => item.id === parameterId,
        )!;
        const binding = {
          parameterId,
          source: selected.connectionName,
          meaning: existing?.meaning || `${parameter.label}运行数据来源`,
          ...(existing?.targetId ? { targetId: existing.targetId } : {}),
          target: structuredClone(selected.target),
        };
        if (index >= 0) bindings[index] = binding;
        else bindings.push(binding);
      }
      next.semanticBindings = bindings;
      return next;
    });
    setError(undefined);
  }

  async function build() {
    if (!validation.valid) {
      setError(
        validation.issues
          .slice(0, 4)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("；"),
      );
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBuilding(true);
    setError(undefined);
    try {
      setResult(
        await buildParametricCad(definition, { signal: controller.signal }),
      );
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError"))
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setBuilding(false);
      }
    }
  }

  async function save() {
    if (!result || !validation.valid) return;
    setSaving(true);
    setError(undefined);
    try {
      const generation = createParametricGeneration(
        definition,
        result.summary,
        sourceModel,
      );
      const fileName = `${safeFileName(definition.name)}.step`;
      const model = await api.uploadModel(
        projectId,
        new File([result.step], fileName, { type: "model/step" }),
        "native-glb",
        "auto",
        generation,
      );
      await onSaved(model);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function createAiDraft() {
    const prompt = aiPrompt.trim();
    if (prompt.length < 3) {
      setError(
        tr(
          locale,
          "请描述需要的部件、关键尺寸和用途。",
          "Describe the part, key dimensions, and intended use.",
        ),
      );
      return;
    }
    setAiBusy(true);
    setError(undefined);
    try {
      const response = await api.invokeCapability<ParametricDraftOutput>(
        projectId,
        "modeling.parametric.draft",
        { prompt },
      );
      if (response.status !== "completed" || !response.output)
        throw new Error(
          response.error?.message ||
            response.warnings[0] ||
            tr(locale, "AI 草案生成失败", "AI draft failed"),
        );
      // 服务端已执行同一受限 DSL 校验；前端仍深拷贝，避免表单原地修改响应对象。
      setDefinition(cloneParametricDefinition(response.output.definition));
      setTemplateId("ai-draft");
      setResult(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAiBusy(false);
    }
  }

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  return (
    <div className="parametric-backdrop" onMouseDown={() => !saving && close()}>
      <section
        className="parametric-workbench"
        role="dialog"
        aria-modal="true"
        aria-labelledby="parametric-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="parametric-brand">
            <span>
              <WandSparkles size={19} />
            </span>
            <div>
              <small>PARAMETRIC ASSET</small>
              <h2 id="parametric-title">
                {tr(locale, "参数化轻量建模", "Parametric asset builder")}
              </h2>
            </div>
          </div>
          <p>
            {sourceGeneration
              ? tr(
                  locale,
                  `基于 v${sourceGeneration.revision} 创建不可变的新版本，不覆盖正在使用的资源。`,
                  `Create an immutable revision from v${sourceGeneration.revision} without overwriting the asset in use.`,
                )
              : tr(
                  locale,
                  "为设备附件与简化部件生成可追溯 STEP，不替代专业 CAD。",
                  "Generate traceable STEP assets for equipment parts without replacing professional CAD.",
                )}
          </p>
          <button
            className="parametric-close"
            aria-label={tr(locale, "关闭", "Close")}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="parametric-body">
          <aside className="parametric-templates">
            <span>{tr(locale, "工程模板", "Templates")}</span>
            {PARAMETRIC_CAD_TEMPLATES.map((template) => (
              <button
                key={template.id}
                className={templateId === template.id ? "active" : ""}
                onClick={() => selectTemplate(template.id)}
              >
                <strong>{template.label}</strong>
                <small>{template.description}</small>
              </button>
            ))}
            <ParametricAiDraftPanel
              locale={locale}
              prompt={aiPrompt}
              busy={aiBusy}
              disabled={aiBusy || building || saving}
              onPromptChange={setAiPrompt}
              onGenerate={() => void createAiDraft()}
            />
          </aside>
          <section className="parametric-parameters" aria-label={tr(locale, "参数配置", "Parameter configuration")}>
            <label className="parametric-name">
              <span>{tr(locale, "资源名称", "Asset name")}</span>
              <input
                value={definition.name}
                maxLength={120}
                onChange={(event) => {
                  setDefinition((current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                  setResult(undefined);
                }}
              />
            </label>
            <div className="parametric-section-title">
              <span>{tr(locale, "尺寸参数", "Dimensions")}</span>
              <small>
                {definition.parameters.length} PARAMS ·{" "}
                {definition.features.length} FEATURES
              </small>
            </div>
            <div className="parametric-parameter-list">
              {definition.parameters.map((parameter, index) => (
                <label key={parameter.id}>
                  <span>
                    <strong>{parameter.label}</strong>
                    <small>{parameter.semantic ?? parameter.id}</small>
                  </span>
                  <input
                    type="number"
                    min={parameter.min}
                    max={parameter.max}
                    step={parameter.step}
                    value={parameter.value}
                    onChange={(event) =>
                      updateParameter(index, Number(event.target.value))
                    }
                  />
                  <em>{parameter.unit}</em>
                </label>
              ))}
            </div>
            <div className="parametric-validation">
              {validation.valid ? (
                <>
                  <CheckCircle2 size={15} />
                  <span>
                    {tr(
                      locale,
                      "Schema、表达式与参数范围已通过校验",
                      "Schema, expressions and ranges are valid",
                    )}
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle size={15} />
                  <span>{validation.issues[0]?.message}</span>
                </>
              )}
            </div>
            <ParametricBindingEditor
              locale={locale}
              definition={definition}
              sources={bindingSources}
              onChange={updateRuntimeBinding}
            />
          </section>
          <aside className="parametric-output">
            <ParametricModelPreview result={result} />
            {result ? (
              <div className="parametric-stats">
                <span>
                  <small>{tr(locale, "体积", "Volume")}</small>
                  <strong>{formatNumber(result.summary.volumeMm3)} mm³</strong>
                </span>
                <span>
                  <small>{tr(locale, "三角面", "Triangles")}</small>
                  <strong>{formatNumber(result.summary.triangleCount)}</strong>
                </span>
                <span>
                  <small>{tr(locale, "构建耗时", "Build time")}</small>
                  <strong>{result.summary.durationMs} ms</strong>
                </span>
              </div>
            ) : (
              <p>
                {tr(
                  locale,
                  "OpenCascade 仅在点击生成后加载，主页面与普通三维浏览不承担其包体和内存成本。",
                  "OpenCascade loads only on demand and adds no cost to normal viewing.",
                )}
              </p>
            )}
            {error && (
              <div className="parametric-error">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}
          </aside>
        </div>
        <footer>
          <span>
            {sourceGeneration
              ? tr(
                  locale,
                  `将保存为 v${sourceGeneration.revision + 1}，原版本保持可复现`,
                  `Saves as v${sourceGeneration.revision + 1}; the original remains reproducible`,
                )
              : tr(
                  locale,
                  "修改参数会创建新的不可变资源版本",
                  "Parameter changes create a new immutable asset version",
                )}
          </span>
          <div>
            <button
              disabled={saving}
              onClick={() => (building ? abortRef.current?.abort() : close())}
            >
              {building
                ? tr(locale, "取消构建", "Cancel build")
                : tr(locale, "取消", "Cancel")}
            </button>
            <button
              className="parametric-build"
              disabled={!validation.valid || building || saving}
              onClick={() => void build()}
            >
              {building ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Play size={15} />
              )}
              {building
                ? tr(locale, "正在构建…", "Building…")
                : tr(locale, "生成预览", "Build preview")}
            </button>
            <button
              className="parametric-save"
              disabled={!result || building || saving}
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Save size={15} />
              )}
              {saving
                ? tr(locale, "保存中…", "Saving…")
                : tr(locale, "保存为 STEP 资源", "Save STEP asset")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function safeFileName(value: string): string {
  return (value.trim() || "参数化模型")
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 80);
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(
    value,
  );
}
