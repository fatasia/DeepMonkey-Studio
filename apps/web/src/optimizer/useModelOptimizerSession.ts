import { useEffect, useRef, useState } from "react";
import type { ModelProcessingRecord, ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { api } from "../api";
import { downloadBlob } from "../browserDownload";
import { optimizationSizeMessage, optimizerErrorMessage } from "../components/ModelOptimizerFields";
import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";
import { convertProjectModelToGlb, isDirectOptimizerInput, optimizedAssetFile, uploadAndConvertForOptimizer, waitForOptimizerModel } from "./modelOptimizerAssets";
import { useOptimizerTask, type OptimizerTask } from "./useOptimizerTask";
import { modelOptimizationCredit } from "./modelOptimizationCredit";
import type { OptimizerLayer,OptimizerLayerEdit } from "./optimizerLayers";
import { createProcessingRecord, modelInputHash, modelParentId, readProcessingRecipe, type OptimizationPresetId } from "./modelEngineering";

interface Source { file: File; baseFile:File; layers:OptimizerLayer[]; url: string; statistics: ModelFileStatistics; converted: boolean; model?: ModelRecord; draftEdits?: OptimizerLayerEdit[] }
interface Result extends ModelOptimizationResult { url: string; fingerprint: string; savedModelId?: string; processing?: ModelProcessingRecord }
interface SaveReceipt { result: Result; upload: Promise<ModelRecord> }

/** 导入成功才替换源文件；结果、参数指纹和保存回执始终归属同一份输入。 */
export function useModelOptimizerSession(locale: AppLocale, project: ProjectRecord | undefined, options: ModelOptimizationOptions, onProjectChange?: (project: ProjectRecord) => void, requestedModelId?: string, preset: OptimizationPresetId = "balanced", onRestoreOptions?: (options: ModelOptimizationOptions, preset: OptimizationPresetId) => void) {
  const task = useOptimizerTask();
  const [source, setSource] = useState<Source>();
  const [robotSource, setRobotSource] = useState<ModelRecord>();
  const [result, setResult] = useState<Result>();
  const [showOptimized, setShowOptimized] = useState(false);
  const [message, setMessage] = useState("导入模型开始编辑与优化");
  const [layerHistory,setLayerHistory]=useState<OptimizerLayerEdit[][]>([[]]);
  const [layerCursor,setLayerCursor]=useState(0);
  const [continuousLayers, setContinuousLayers] = useState(false);
  const [error, setError] = useState<string>();
  const saveReceipt = useRef<SaveReceipt | undefined>(undefined);
  const serverWork = useRef(false);
  const fingerprint = JSON.stringify(options);
  const resultOutdated = Boolean(result && result.fingerprint !== fingerprint);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source?.url]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result?.url]);
  useEffect(() => { if (resultOutdated) setShowOptimized(false); }, [resultOutdated]);
  useEffect(() => {
    if (!project || !requestedModelId) return;
    const model = project.models.find(item => item.id === requestedModelId);
    if (!model || model.status !== "ready" || !model.manifest?.geometryUrl) {
      setError("指定的项目模型不存在或尚未就绪，请从项目素材重新选择");
      return;
    }
    void importProjectModel(model);
    // StrictMode 会撤销首轮异步任务并重放 effect；由路由身份驱动，不能用 ref 抑制重放。
    // 项目资源刷新也不应覆盖用户已在优化器内做出的图层编辑。
  }, [project?.id, requestedModelId]);

  const progress = (current: OptimizerTask) => (text: string) => { current.assertCurrent(); setMessage(text); };
  function failed(label: string) {
    return (reason: unknown) => { setError(optimizerErrorMessage(reason, locale)); setMessage(label); };
  }
  async function loadPreparedFile(file: File, current: OptimizerTask, model?: ModelRecord, converted = false) {
    current.assertCurrent(); setMessage("正在分析模型");
    const prepared = await current.worker().layers(file,[]);
    current.assertCurrent();
    const workingFile=new File([prepared.binary],file.name.replace(/\.[^.]+$/,".glb"),{type:"model/gltf-binary"});
    setSource({ file:workingFile,baseFile:file,layers:prepared.layers,statistics:prepared.statistics,converted,url:URL.createObjectURL(workingFile),...(model?{model}:{}) });
    setLayerHistory([[]]);setLayerCursor(0);
    setRobotSource(undefined);
    setResult(undefined); saveReceipt.current = undefined; setShowOptimized(false);
    setMessage("模型已载入，可调整参数后开始优化");
  }
  function loadRobotSource(model: ModelRecord) {
    setRobotSource(model); setSource(undefined); setResult(undefined); saveReceipt.current = undefined; setShowOptimized(false);
    setMessage("机器人已载入");
  }
  async function importFile(file?: File, robotEntryPath?: string) {
    if (!file) return;
    await task.run("import", async current => {
      setError(undefined); setMessage("正在准备模型"); serverWork.current = false;
      if (/\.(urdf|zip)$/i.test(file.name)) {
        if (!project) throw new Error("请先选择项目");
        serverWork.current = true;
        const uploaded = await api.uploadModel(project.id, file, undefined, undefined, undefined, robotEntryPath);
        current.assertCurrent();
        const updated = await waitForOptimizerModel(project.id, uploaded.id, progress(current), current.signal);
        current.assertCurrent(); onProjectChange?.(updated);
        const model = updated.models.find(item => item.id === uploaded.id);
        if (!model?.manifest?.robot) throw new Error("机器人资源缺少关节描述");
        loadRobotSource(model);
      }
      else if (isDirectOptimizerInput(file)) await loadPreparedFile(file, current, undefined, false);
      else {
        if (!project) throw new Error("请先选择项目，其他格式需要通过项目转换服务处理");
        serverWork.current = true;
        const converted = await uploadAndConvertForOptimizer(project.id, file, progress(current), current.signal);
        current.assertCurrent(); onProjectChange?.(converted.project);
        await loadPreparedFile(converted.file, current, converted.sourceModel, true);
      }
    }, failed("模型导入或转换失败，已载入模型保持不变"), true);
  }
  async function importProjectModel(model: ModelRecord) {
    await task.run("import", async current => {
      setError(undefined); serverWork.current = false;
      if (model.manifest?.robot) { loadRobotSource(model); return; }
      const file = await convertProjectModelToGlb(model, progress(current), current.signal);
      // glb 项目模型直接读原始字节，未发生格式转换；其余格式经 viewer 重导出才算转换。
      await loadPreparedFile(file, current, model, model.format !== "glb");
    }, failed("项目模型转换失败，已载入模型保持不变"), true);
  }
  async function runOptimization() {
    if (!source) return;
    await task.run("optimize", async current => {
      setError(undefined); serverWork.current = false;
      const working = source.draftEdits ? new File([(await current.worker().materializeLayers(source.baseFile, source.draftEdits)).binary], source.file.name, { type: "model/gltf-binary" }) : source.file;
      const optimized = await current.worker().optimize(working, options, progress(current), modelOptimizationCredit(source.model));
      const processing = await createProcessingRecord(source.baseFile, options, layerHistory[layerCursor] ?? [], optimized.before, optimized.after, "optimize", preset);
      current.assertCurrent();
      setResult({ ...optimized, processing, fingerprint, url: URL.createObjectURL(new Blob([optimized.binary], { type: "model/gltf-binary" })) });
      saveReceipt.current = undefined; setShowOptimized(true);
      setMessage(optimized.lightmap
        ? `优化完成，已生成 ${optimized.lightmap.resolution}×${optimized.lightmap.resolution} 光照贴图，覆盖 ${optimized.lightmap.coveredTexels.toLocaleString()} 像素`
        : optimizationSizeMessage(optimized.before.bytes, optimized.after.bytes));
    }, failed("优化失败，原始文件未修改"));
  }
  async function applyLayerHistory(history:OptimizerLayerEdit[][],cursor:number,continuous = continuousLayers){
    if(!source)return;
    await task.run("optimize",async current=>{
      setError(undefined);setMessage("正在更新模型图层");serverWork.current=false;
      if (continuous) {
        const edits = history[cursor] ?? [];
        const draft = await current.worker().layerDraft(source.baseFile, edits);
        current.assertCurrent();
        setSource({ ...source, draftEdits: edits, layers: draft.layers, statistics: { ...draft.statistics, bytes: source.statistics.bytes },
          ...(draft.previewBinary ? { url: URL.createObjectURL(new Blob([draft.previewBinary], { type: "model/gltf-binary" })) } : {}) });
        setLayerHistory(history); setLayerCursor(cursor);
        setResult(undefined); saveReceipt.current = undefined; setShowOptimized(false);
        setMessage("图层已更新，下载或保存时生成文件");
        return;
      }
      const edited=await current.worker().layers(source.baseFile,history[cursor]??[]);
      const processing = await createProcessingRecord(source.baseFile, options, history[cursor] ?? [], source.statistics, edited.statistics, "layers", preset);
      current.assertCurrent();
      const file=new File([edited.binary],source.file.name,{type:"model/gltf-binary"});
      const { draftEdits: _draft, ...original } = source;
      setSource({...original,file,layers:edited.layers,statistics:edited.statistics,url:URL.createObjectURL(file)});
      setContinuousLayers(false);
      setLayerHistory(history);setLayerCursor(cursor);
      setResult({binary:edited.binary,before:source.statistics,after:edited.statistics,processing,fingerprint,url:URL.createObjectURL(file)});
      saveReceipt.current=undefined;setShowOptimized(false);
      setMessage("图层已更新，可直接下载或继续优化");
    },failed("图层修改失败，模型保持不变"),false,continuous);
  }
  function changeContinuousLayers(enabled: boolean) {
    if (!enabled && source?.draftEdits) void applyLayerHistory(layerHistory, layerCursor, false);
    else { task.cancel(); setContinuousLayers(enabled); }
  }
  function editLayer(edit:OptimizerLayerEdit){
    const history=[...layerHistory.slice(0,layerCursor+1),[...(layerHistory[layerCursor]??[]),edit]];
    void applyLayerHistory(history,history.length-1);
  }
  function cancelProcessing() {
    const submitted = serverWork.current;
    task.cancel(); setError(undefined);
    setMessage(submitted ? (task.kind === "save" ? "已停止等待；再次保存将继续等待同一任务" : "已停止等待；转换任务仍保留在项目素材中") : "处理已取消，原始文件未修改");
  }
  async function replayProcessing(model: ModelRecord) {
    await task.run("optimize", async current => {
      setError(undefined); serverWork.current = false;
      const record = model.processing;
      const parent = project?.models.find(item => item.id === modelParentId(model));
      if (!record || !parent || parent.status !== "ready") throw new Error("原始输入或处理记录已不可用，请重新选择源模型");
      const recipe = readProcessingRecipe(record, options);
      const file = await convertProjectModelToGlb(parent, progress(current), current.signal);
      if (await modelInputHash(file) !== record.inputSha256) throw new Error("源文件内容已变化，无法按旧配方重建；当前模型保持不变");
      current.assertCurrent();
      const prepared = await current.worker().layers(file, recipe.edits);
      const working = new File([prepared.binary], file.name, { type: "model/gltf-binary" });
      const rebuilt = record.operation === "optimize"
        ? await current.worker().optimize(working, recipe.options, progress(current), modelOptimizationCredit(parent))
        : { binary: prepared.binary, before: record.before, after: prepared.statistics };
      current.assertCurrent();
      const restoredPreset = record.preset === "custom" ? "balanced" : record.preset;
      onRestoreOptions?.(recipe.options, restoredPreset);
      setSource({ file: working, baseFile: file, layers: prepared.layers, statistics: prepared.statistics, converted: parent.format !== "glb", model: parent, url: URL.createObjectURL(working) });
      setRobotSource(undefined); setLayerHistory([[], recipe.edits]); setLayerCursor(1);
      const processing = { ...record, before: rebuilt.before, after: rebuilt.after };
      delete processing.outputSha256;
      setResult({ ...rebuilt, processing, fingerprint: JSON.stringify(recipe.options), url: URL.createObjectURL(new Blob([rebuilt.binary], { type: "model/gltf-binary" })) });
      saveReceipt.current = undefined; setShowOptimized(true);
      setMessage("已按处理配方重建，可保存为新的独立产物");
    }, failed("配方重建失败，当前模型保持不变"));
  }
  async function currentOutput(current: OptimizerTask): Promise<Result> {
    if (result) return result;
    if (!source?.draftEdits) throw new Error("请先编辑图层或运行优化");
    setMessage("正在生成模型文件");
    const edited = await current.worker().materializeLayers(source.baseFile, source.draftEdits);
    const processing = await createProcessingRecord(source.baseFile, options, source.draftEdits, source.statistics, edited.statistics, "layers", preset);
    current.assertCurrent();
    const next = { binary: edited.binary, before: source.statistics, after: edited.statistics, processing, fingerprint, url: URL.createObjectURL(new Blob([edited.binary], { type: "model/gltf-binary" })) };
    setResult(next); saveReceipt.current = undefined;
    return next;
  }
  async function exportGlb() {
    if (!source || (!result && !source.draftEdits) || resultOutdated || task.busy) return;
    await task.run("save", async current => {
      setError(undefined); serverWork.current = false;
      const output = await currentOutput(current);
      current.assertCurrent();
      const file = optimizedAssetFile(source.file.name, output.binary);
      downloadBlob(file, file.name);
      setMessage("模型文件已生成");
    }, failed("文件生成失败，图层编辑保持不变"), false, continuousLayers);
  }
  async function saveToProjectAssets() {
    if (result?.savedModelId && !resultOutdated) return result.savedModelId;
    if (!source || (!result && !source.draftEdits) || !project || resultOutdated) return;
    let savedId: string | undefined;
    await task.run("save", async current => {
      setError(undefined); serverWork.current = false;
      const output = await currentOutput(current);
      setMessage("正在保存优化结果到项目素材库"); serverWork.current = true;
      // 停止等待不等于撤销服务器上传；重试复用同一回执，避免生成重复素材。
      if (saveReceipt.current?.result !== output) {
        const receipt: SaveReceipt = { result: output, upload: api.uploadOptimizedModel(project.id, optimizedAssetFile(source.file.name, output.binary), source.model?.id, output.processing) };
        saveReceipt.current = receipt;
        void receipt.upload.catch(() => { if (saveReceipt.current === receipt) saveReceipt.current = undefined; });
      }
      const uploaded = await saveReceipt.current.upload;
      current.assertCurrent();
      const updated = await waitForOptimizerModel(project.id, uploaded.id, progress(current), current.signal);
      current.assertCurrent(); onProjectChange?.(updated);
      setResult({ ...output, savedModelId: uploaded.id });
      savedId = uploaded.id;
      setMessage("优化模型已保存到项目素材库，可直接用于场景");
    }, failed("保存或转换尚未完成，可重试继续等待"), false, continuousLayers);
    return savedId;
  }
  return {
    file: source?.file, sourceModel: source?.model, sourceUrl: source?.url, optimizedUrl: result?.url,
    before: source?.statistics, after: result?.after, lightmapResult: result?.lightmap, output: result?.binary,
    hasOutput: Boolean(result || source?.draftEdits), continuousLayers, changeContinuousLayers,
    previewLayers: source?.draftEdits && !showOptimized ? source.layers : undefined,
    hasConverted: source?.converted ?? false,
    selectedProjectModelId: robotSource?.id ?? source?.model?.id ?? "", savedModelId: result?.savedModelId,
    robotSource,
    layers:source?.layers??[],editLayer,canUndoLayer:layerCursor>0,canRedoLayer:layerCursor<layerHistory.length-1,
    undoLayer:()=>void applyLayerHistory(layerHistory,layerCursor-1),redoLayer:()=>void applyLayerHistory(layerHistory,layerCursor+1),
    showOptimized, setShowOptimized, busy: task.busy, message, error, resultOutdated,
    previewUrl: showOptimized && !resultOutdated ? result?.url ?? source?.url : source?.url,
    comparisonMode: Boolean(result && !resultOutdated),
    importFile, importProjectModel, runOptimization, cancelProcessing, exportGlb, saveToProjectAssets, replayProcessing,
  };
}
