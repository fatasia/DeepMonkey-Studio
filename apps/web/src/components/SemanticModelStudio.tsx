import { useEffect } from "react";
import { Boxes, Plus, RefreshCw } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { SemanticModelEditor } from "./SemanticModelEditor";
import { SemanticModelList } from "./SemanticModelList";
import { useSemanticModelStudio } from "./useSemanticModelStudio";
import { newSemanticModel } from "./semanticModelEditorLogic";
import "./SemanticModelStudio.css";

export default function SemanticModelStudio({
  projectId,
  locale,
  onDirtyChange,
}: {
  projectId: string;
  locale: AppLocale;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const state = useSemanticModelStudio(projectId, locale);
  useEffect(() => {
    onDirtyChange?.(state.dirty);
  }, [state.dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  return (
    <section
      className="semantic-studio"
      aria-label={tr(locale, "语义模型", "Semantic models")}
    >
      {state.notice && (
        <p className="semantic-notice" role="status">
          {state.notice}
        </p>
      )}
      {state.dirty && (
        <p className="semantic-dirty" role="status">
          {tr(locale, "有未保存修改", "Unsaved changes")}
        </p>
      )}
      {state.draft ? (
        <SemanticModelEditor
          key={state.draft.id}
          value={state.draft}
          datasets={state.datasets}
          pipelines={state.pipelines}
          projectId={projectId}
          locale={locale}
          busy={state.busy}
          errors={state.errors}
          onChange={state.changeDraft}
          onSave={state.save}
          onClose={state.leave}
        />
      ) : (
        <>
          <header className="semantic-studio-header">
            <div>
              <h2>{tr(locale, "语义模型", "Semantic models")}</h2>
              <p>
                {tr(
                  locale,
                  "把字段组织为可复用的指标、维度和参数",
                  "Organize fields into reusable metrics, dimensions and parameters",
                )}
              </p>
            </div>
            <div>
              <button
                type="button"
                disabled={state.busy || state.status === "loading"}
                onClick={() => void state.load()}
                aria-label={tr(
                  locale,
                  "刷新语义模型",
                  "Refresh semantic models",
                )}
              >
                <RefreshCw size={15} />
              </button>
              <button
                className="primary"
                type="button"
                disabled={state.busy || state.status !== "ready"}
                onClick={() => state.open(newSemanticModel("dataset"))}
              >
                <Plus size={15} />
                {tr(locale, "新建模型", "New model")}
              </button>
            </div>
          </header>
          {state.errors.length > 0 && (
            <div className="semantic-error" role="alert">
              <ul>
                {state.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
              <button type="button" onClick={() => void state.load()}>
                {tr(locale, "重新读取", "Reload")}
              </button>
            </div>
          )}
          {state.status === "loading" ? (
            <p role="status">
              {tr(locale, "正在读取语义模型…", "Loading semantic models…")}
            </p>
          ) : state.status === "ready" && !state.models.length ? (
            <div className="semantic-empty">
              <Boxes size={32} />
              <h3>
                {tr(
                  locale,
                  "先定义一份业务口径",
                  "Start with a shared business definition",
                )}
              </h3>
              <p>
                {tr(
                  locale,
                  "集中维护计算、分类层级和筛选参数，减少各页面重复配置。",
                  "Centralize calculations, category hierarchies and filters instead of repeating page configuration.",
                )}
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => state.open(newSemanticModel("dataset"))}
                >
                  {tr(locale, "从数据集创建", "Create from dataset")}
                </button>
                <button
                  type="button"
                  onClick={() => state.open(newSemanticModel("pipeline"))}
                >
                  {tr(locale, "从管道创建", "Create from pipeline")}
                </button>
              </div>
            </div>
          ) : (
            state.status === "ready" && (
              <SemanticModelList
                locale={locale}
                models={state.models}
                datasets={state.datasets}
                pipelines={state.pipelines}
                busy={state.busy}
                onOpen={state.open}
                onRename={state.renameModel}
                onDelete={state.deleteModel}
              />
            )
          )}
        </>
      )}
    </section>
  );
}
