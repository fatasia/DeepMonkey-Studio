import { AlertTriangle, Check, ChevronDown, Download, FileJson2, LoaderCircle, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import type { PlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { downloadTextFile } from "../browserDownload";
import {
  PLANT_LITE_MODEL_IMPORT_MAX_BYTES,
  applyPlantLiteModelImport,
  createPlantLiteModelExchange,
  parsePlantLiteModelExchange,
  plantLiteModelExchangeFileName,
  serializePlantLiteModelExchange,
  type PlantLiteModelImportResult,
} from "./plantLiteModelExchangeCodec";

export type PlantLiteModelImportState =
  | { status: "reading"; fileName: string }
  | PlantLiteModelImportResult
  | null;

export function PlantLiteModelExchange({
  value,
  model,
  onChange,
}: {
  value: PlantLiteStudyRequest;
  model: PlantLiteModel;
  onChange: (value: PlantLiteStudyRequest) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const [importState, setImportState] = useState<PlantLiteModelImportState>(null);
  const [status, setStatus] = useState("");

  function chooseFile() {
    if (!inputRef.current) return;
    inputRef.current.value = "";
    inputRef.current.click();
  }

  async function readFile(file?: File) {
    if (!file) return;
    const version = ++readVersion.current;
    setStatus("");
    setImportState({ status: "reading", fileName: file.name });
    if (file.size > PLANT_LITE_MODEL_IMPORT_MAX_BYTES) {
      setImportState({ status: "invalid", fileName: file.name, issues: ["文件超过 2 MB 上限"] });
      return;
    }
    try {
      const text = await file.text();
      if (version !== readVersion.current) return;
      setImportState(parsePlantLiteModelExchange(text, file.name));
    } catch (error) {
      if (version !== readVersion.current) return;
      setImportState({
        status: "invalid",
        fileName: file.name,
        issues: [error instanceof Error ? `读取失败：${error.message}` : "文件读取失败"],
      });
    }
  }

  function cancelImport() {
    readVersion.current += 1;
    setImportState(null);
    setStatus("已取消导入，当前模型未改变");
  }

  function confirmImport() {
    if (importState?.status !== "ready") return;
    try {
      onChange(applyPlantLiteModelImport(value, importState.preview.model));
      setImportState(null);
      setStatus(`已替换为“${importState.preview.model.name}”；运行条件与验收目标未改变，尚未运行`);
    } catch (error) {
      setImportState({
        status: "invalid",
        fileName: importState.preview.fileName,
        issues: [error instanceof Error ? `替换失败：${error.message}` : "模型替换失败"],
      });
    }
  }

  function exportModel() {
    try {
      const exchange = createPlantLiteModelExchange(model);
      downloadTextFile(
        serializePlantLiteModelExchange(exchange),
        plantLiteModelExchangeFileName(model),
        "application/json;charset=utf-8",
      );
      setStatus("模型文件已下载；未包含 Study 运行条件、结果或凭据");
    } catch (error) {
      setStatus(error instanceof Error ? `导出失败：${error.message}` : "模型导出失败");
    }
  }

  return <details className="plant-model-exchange">
    <summary>
      <span><FileJson2 size={13} /><b>模型文件</b><small>导入、导出 · 按需展开</small></span>
      <ChevronDown size={13} />
    </summary>
    <div className="plant-model-exchange-body">
      <div className="plant-model-exchange-actions">
        <span>
          <strong>复用产线模型</strong>
          <small>仅交换节点、连接、资源及其工程参数；不会带入 Study 名称、运行条件、结果或凭据。</small>
        </span>
        <div>
          <button type="button" onClick={exportModel}><Download size={13} />导出模型</button>
          <button type="button" onClick={chooseFile}><Upload size={13} />选择 JSON</button>
        </div>
      </div>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".json,.plant-lite.json,application/json"
        onChange={(event) => void readFile(event.target.files?.[0])}
      />
      <PlantLiteModelImportReview
        state={importState}
        onCancel={cancelImport}
        onConfirm={confirmImport}
        onRetry={chooseFile}
      />
      <small className="plant-model-exchange-status" role="status" aria-live="polite">{status}</small>
    </div>
  </details>;
}

export function PlantLiteModelImportReview({
  state,
  onCancel,
  onConfirm,
  onRetry,
}: {
  state: PlantLiteModelImportState;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  if (!state) return null;
  if (state.status === "reading") return <div className="plant-model-import-review is-reading" role="status">
    <LoaderCircle size={14} /><span><strong>正在检查模型</strong><small>{state.fileName}</small></span>
    <button type="button" onClick={onCancel}><X size={12} />取消</button>
  </div>;
  if (state.status === "invalid") return <div className="plant-model-import-review is-invalid" role="alert">
    <AlertTriangle size={14} />
    <span><strong>不能导入 · {state.fileName}</strong>{state.issues.map((issue) => <small key={issue}>{issue}</small>)}</span>
    <div><button type="button" onClick={onRetry}>重新选择</button><button type="button" onClick={onCancel}>取消</button></div>
  </div>;
  const { preview } = state;
  return <div className="plant-model-import-review is-ready" role="status">
    <Check size={14} />
    <span>
      <strong>{preview.fileName}</strong>
      <small>“{preview.model.name}” · {preview.nodeCount} 个节点 · {preview.resourceCount} 项资源 / {preview.resourceUnitCount} 个资源单元</small>
      <small>来源：{preview.sourceApplication} · 校验通过，确认后只替换当前模型</small>
    </span>
    <div><button type="button" onClick={onCancel}>取消</button><button className="is-primary" type="button" onClick={onConfirm}>确认替换</button></div>
  </div>;
}
