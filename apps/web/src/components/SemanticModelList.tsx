import { useState } from "react";
import { Boxes, Pencil, Search, Trash2 } from "lucide-react";
import type {
  DataDatasetRecord,
  DataPipelineDefinition,
  SemanticModelRecord,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function SemanticModelList({
  models,
  datasets,
  pipelines,
  locale,
  busy,
  onOpen,
  onRename,
  onDelete,
}: {
  models: SemanticModelRecord[];
  datasets: DataDatasetRecord[];
  pipelines: DataPipelineDefinition[];
  locale: AppLocale;
  busy: boolean;
  onOpen: (model: SemanticModelRecord) => void;
  onRename: (model: SemanticModelRecord, name: string) => Promise<boolean>;
  onDelete: (model: SemanticModelRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = models
    .filter((model) =>
      `${model.name} ${model.description ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      <label className="semantic-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr(
            locale,
            "搜索模型名称或说明",
            "Search name or description",
          )}
          aria-label={tr(locale, "搜索语义模型", "Search semantic models")}
        />
        <span>{visible.length}</span>
      </label>
      <div className="semantic-model-list">
        {visible.map((model) => (
          <SemanticModelRow
            key={model.id}
            model={model}
            sourceName={
              (model.source.kind === "dataset" ? datasets : pipelines).find(
                (item) => item.id === model.source.id,
              )?.name ?? tr(locale, "来源已失效", "Source unavailable")
            }
            locale={locale}
            busy={busy}
            onOpen={onOpen}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
        {!visible.length && (
          <p>{tr(locale, "没有匹配的模型", "No matching models")}</p>
        )}
      </div>
    </>
  );
}

function SemanticModelRow({
  model,
  sourceName,
  locale,
  busy,
  onOpen,
  onRename,
  onDelete,
}: {
  model: SemanticModelRecord;
  sourceName: string;
  locale: AppLocale;
  busy: boolean;
  onOpen: (model: SemanticModelRecord) => void;
  onRename: (model: SemanticModelRecord, name: string) => Promise<boolean>;
  onDelete: (model: SemanticModelRecord) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(model.name);
  return (
    <article className="semantic-model-row">
      <button
        type="button"
        className="semantic-model-open"
        disabled={busy}
        onClick={() => onOpen(model)}
      >
        <Boxes size={20} />
        <span>
          <strong>{model.name}</strong>
          <small>
            {sourceName} ·{" "}
            {tr(
              locale,
              `${model.metrics.length} 指标 / ${model.dimensions.length} 维度 / ${model.parameters.length} 参数`,
              `${model.metrics.length} metrics / ${model.dimensions.length} dimensions / ${model.parameters.length} parameters`,
            )}
          </small>
        </span>
      </button>
      <span className="semantic-model-version">
        r{model.revision}
        <small>
          {new Intl.DateTimeFormat(locale, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(model.updatedAt))}
        </small>
      </span>
      <div className="semantic-row-actions">
        <button
          type="button"
          disabled={busy}
          aria-label={tr(
            locale,
            `重命名 ${model.name}`,
            `Rename ${model.name}`,
          )}
          onClick={() => {
            setName(model.name);
            setRenaming(true);
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label={tr(locale, `删除 ${model.name}`, `Delete ${model.name}`)}
          onClick={() => onDelete(model)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {renaming && (
        <form
          className="semantic-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(model, name).then((saved) => {
              if (saved) setRenaming(false);
            });
          }}
        >
          <input
            autoFocus
            aria-label={tr(locale, "新模型名称", "New model name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {tr(locale, "确认重命名", "Confirm rename")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRenaming(false)}
          >
            {tr(locale, "取消", "Cancel")}
          </button>
        </form>
      )}
    </article>
  );
}
