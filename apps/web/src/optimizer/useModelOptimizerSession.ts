import { useEffect, useRef, useState } from "react";
import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { api } from "../api";
import { downloadBlob } from "../browserDownload";
import { optimizerErrorMessage, reduction } from "../components/ModelOptimizerFields";
import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";
import { convertProjectModelToGlb, isDirectOptimizerInput, optimizedAssetFile, uploadAndConvertForOptimizer, waitForOptimizerModel } from "./modelOptimizerAssets";
import { useOptimizerTask, type OptimizerTask } from "./useOptimizerTask";
import { modelOptimizationCredit } from "./modelOptimizationCredit";

interface Source { file: File; url: string; statistics: ModelFileStatistics; model?: ModelRecord }
interface Result extends ModelOptimizationResult { url: string; fingerprint: string; savedModelId?: string }
interface SaveReceipt { result: Result; upload: Promise<ModelRecord> }

/** 导入成功才替换源文件；结果、参数指纹和保存回执始终归属同一份输入。 */
export function useModelOptimizerSession(locale: AppLocale, project: ProjectRecord | undefined, options: ModelOptimizationOptions, onProjectChange?: (project: ProjectRecord) => void, requestedModelId?: string) {
  const task = useOptimizerTask();
  const [source, setSource] = useState<Source>();
  const [result, setResult] = useState<Result>();
  const [showOptimized, setShowOptimized] = useState(false);
  const [message, setMessage] = useState("导入 GLB 或内嵌资源的 glTF 开始优化");
  const [error, setError] = useState<string>();
  const saveReceipt = useRef<SaveReceipt | undefined>(undefined);
  const serverWork = useRef(false);
  const requested = useRef<string | undefined>(undefined);
  const fingerprint = JSON.stringify(options);
  const resultOutdated = Boolean(result && result.fingerprint !== fingerprint);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source?.url]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result?.url]);
  useEffect(() => { if (resultOutdated) setShowOptimized(false); }, [resultOutdated]);
  useEffect(() => {
    if (!project || !requestedModelId || requested.current === requestedModelId) return;
    requested.current = requestedModelId;
    const model = project.models.find(item => item.id === requestedModelId);
    if (!model || model.status !== "ready" || !model.manifest?.geometryUrl) {
      setError("指定的项目模型不存在或尚未就绪，请从项目素材重新选择");
      return;
    }
    void importProjectModel(model);
  }, [project, requestedModelId]);

  const progress = (current: OptimizerTask) => (text: string) => { current.assertCurrent(); setMessage(text); };
  function failed(label: string) {
    return (reason: unknown) => { setError(optimizerErrorMessage(reason, locale)); setMessage(label); };
  }
  async function loadPreparedFile(file: File, current: OptimizerTask, model?: ModelRecord) {
    current.assertCurrent(); setMessage("正在分析模型");
    const statistics = await current.worker().inspect(file);
    current.assertCurrent();
    setSource({ file, statistics, url: URL.createObjectURL(file), ...(model ? { model } : {}) });
    setResult(undefined); saveReceipt.current = undefined; setShowOptimized(false);
    setMessage("模型已载入，可调整参数后开始优化");
  }
  async function importFile(file?: File) {
    if (!file) return;
    await task.run("import", async current => {
      setError(undefined); setMessage("正在准备模型"); serverWork.current = false;
      if (isDirectOptimizerInput(file)) await loadPreparedFile(file, current);
      else {
        if (!project) throw new Error("请先选择项目，其他格式需要通过项目转换服务处理");
        serverWork.current = true;
        const converted = await uploadAndConvertForOptimizer(project.id, file, progress(current), current.signal);
        current.assertCurrent(); onProjectChange?.(converted.project);
        await loadPreparedFile(converted.file, current, converted.sourceModel);
      }
    }, failed("模型导入或转换失败，已载入模型保持不变"), true);
  }
  async function importProjectModel(model: ModelRecord) {
    await task.run("import", async current => {
      setError(undefined); serverWork.current = false;
      const file = await convertProjectModelToGlb(model, progress(current), current.signal);
      await loadPreparedFile(file, current, model);
    }, failed("项目模型转换失败，已载入模型保持不变"), true);
  }
  async function runOptimization() {
    if (!source) return;
    await task.run("optimize", async current => {
      setError(undefined); serverWork.current = false;
      const optimized = await current.worker().optimize(source.file, options, progress(current), modelOptimizationCredit(source.model));
      current.assertCurrent();
      setResult({ ...optimized, fingerprint, url: URL.createObjectURL(new Blob([optimized.binary], { type: "model/gltf-binary" })) });
      saveReceipt.current = undefined; setShowOptimized(true);
      setMessage(optimized.lightmap
        ? `优化完成，已生成 ${optimized.lightmap.resolution}×${optimized.lightmap.resolution} 光照贴图，覆盖 ${optimized.lightmap.coveredTexels.toLocaleString()} 像素`
        : `优化完成，体积减少 ${reduction(optimized.before.bytes, optimized.after.bytes)}%`);
    }, failed("优化失败，原始文件未修改"));
  }
  function cancelProcessing() {
    const submitted = serverWork.current;
    task.cancel(); setError(undefined);
    setMessage(submitted ? (task.kind === "save" ? "已停止等待；再次保存将继续等待同一任务" : "已停止等待；转换任务仍保留在项目素材中") : "处理已取消，原始文件未修改");
  }
  function exportGlb() {
    if (!source || !result || resultOutdated || task.busy) return;
    const file = optimizedAssetFile(source.file.name, result.binary);
    downloadBlob(file, file.name);
  }
  async function saveToProjectAssets() {
    if (!source || !result || !project || resultOutdated || result.savedModelId) return;
    await task.run("save", async current => {
      setError(undefined); setMessage("正在保存优化结果到项目素材库"); serverWork.current = true;
      // 停止等待不等于撤销服务器上传；重试复用同一回执，避免生成重复素材。
      if (saveReceipt.current?.result !== result) {
        const receipt: SaveReceipt = { result, upload: api.uploadOptimizedModel(project.id, optimizedAssetFile(source.file.name, result.binary), source.model?.id) };
        saveReceipt.current = receipt;
        void receipt.upload.catch(() => { if (saveReceipt.current === receipt) saveReceipt.current = undefined; });
      }
      const uploaded = await saveReceipt.current.upload;
      current.assertCurrent();
      const updated = await waitForOptimizerModel(project.id, uploaded.id, progress(current), current.signal);
      current.assertCurrent(); onProjectChange?.(updated);
      setResult({ ...result, savedModelId: uploaded.id });
      setMessage("优化模型已保存到项目素材库，可直接用于场景");
    }, failed("保存或转换尚未完成，可重试继续等待"));
  }
  return {
    file: source?.file, sourceModel: source?.model, sourceUrl: source?.url, optimizedUrl: result?.url,
    before: source?.statistics, after: result?.after, lightmapResult: result?.lightmap, output: result?.binary,
    selectedProjectModelId: source?.model?.id ?? "", savedModelId: result?.savedModelId,
    showOptimized, setShowOptimized, busy: task.busy, message, error, resultOutdated,
    previewUrl: showOptimized && !resultOutdated ? result?.url ?? source?.url : source?.url,
    comparisonMode: Boolean(result && !resultOutdated),
    importFile, importProjectModel, runOptimization, cancelProcessing, exportGlb, saveToProjectAssets,
  };
}
