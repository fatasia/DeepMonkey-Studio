import { useEffect, useMemo, useRef, useState } from "react";
import { assessBatteryDataContract, batteryContractFailureMessage, type AiDataBinding, type BatteryModelCatalogEntry, type DataDatasetRecord } from "@bim-studio/contracts";
import { api, type BatteryReleaseGateSnapshot } from "../api";
import { BATTERY_EXAMPLES, batteryExampleById } from "../ai/batterySample";
import { batterySuggestionDraft, type OperationalSuggestionDraft } from "../ai/operationalSuggestionDraft";
import { BatteryEvidencePanel } from "./BatteryEvidencePanel";
import { BatteryIntelligenceRunPanel } from "./BatteryIntelligenceRunPanel";
import { BatteryScenarioWorkbench } from "./BatteryScenarioWorkbench";
import { BatteryTechnologyRail } from "./BatteryTechnologyRail";
import { parseBatteryCsv, type ParsedBatteryCsv } from "./batteryCsv";
import {
  BATTERY_RUN_POLICIES, BATTERY_TASKS, COMBINED_BATTERY_MODELS, batteryDatasetFields,
  exampleSupportsBatteryTask, isAbortError, positiveOrUndefined,
  type BatteryChemistry, type BatterySourceMode, type BatteryTask,
} from "./batteryIntelligenceConfig";
import { executeCombinedBatteryPrediction, executeSingleBatteryPrediction } from "./batteryPredictionExecution";

export function BatteryIntelligencePanel({ projectId }: { projectId: string }) {
  const [task, setTask] = useState<BatteryTask>("soh");
  const [chemistry, setChemistry] = useState<BatteryChemistry>("lfp");
  const [nominalCapacity, setNominalCapacity] = useState("100");
  const [targetRetention, setTargetRetention] = useState("80");
  const [source, setSource] = useState<{ file: File; parsed: ParsedBatteryCsv }>();
  const [sourceMode, setSourceMode] = useState<BatterySourceMode>("example");
  const [exampleId, setExampleId] = useState("lfp-engineering");
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [bindings, setBindings] = useState<AiDataBinding[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runPolicy, setRunPolicy] = useState(BATTERY_RUN_POLICIES.soh);
  const [catalog, setCatalog] = useState<BatteryModelCatalogEntry[]>([]);
  const [release, setRelease] = useState<BatteryReleaseGateSnapshot>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sampleRun, setSampleRun] = useState<string>();
  const [evidence, setEvidence] = useState<{ draft: OperationalSuggestionDraft; payload: unknown }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const selectedTask = BATTERY_TASKS.find((item) => item.id === task)!;
  const selectedExample = batteryExampleById(exampleId);
  const selectedModel = catalog.find((item) => item.family === selectedTask.model && item.role === "primary-model");
  const selectedDataset = datasets.find((item) => item.id === datasetId);
  const nominalCapacityProvided = Number.isFinite(Number(nominalCapacity)) && Number(nominalCapacity) > 0;
  const relevantModels = useMemo(
    () => task === "combined" ? COMBINED_BATTERY_MODELS : [{ task, model: selectedTask.model, label: selectedTask.label }],
    [task, selectedTask],
  );
  const datasetAssessments = useMemo(() => new Map(datasets.map((dataset) => {
    const fields = batteryDatasetFields(dataset);
    return [dataset.id, relevantModels.map(({ model }) => assessBatteryDataContract(model, fields, { nominalCapacityProvided }))];
  })), [datasets, nominalCapacityProvided, relevantModels]);
  const contractAssessments = useMemo(() => {
    if (sourceMode === "dataset") return datasetId ? datasetAssessments.get(datasetId) : undefined;
    if (sourceMode === "example") return relevantModels.map(({ model }) => assessBatteryDataContract(model, selectedExample.headers.map((key) => ({ key })), { nominalCapacityProvided: true }));
    return source ? relevantModels.map(({ model }) => assessBatteryDataContract(model, source.parsed.headers.map((key) => ({ key })), { nominalCapacityProvided })) : undefined;
  }, [datasetAssessments, datasetId, nominalCapacityProvided, relevantModels, selectedExample, source, sourceMode]);
  const dataContract = contractAssessments?.find((item) => !item.compatible) ?? contractAssessments?.[0];
  const activeBinding = task === "combined" ? undefined : bindings.find((item) =>
    item.capabilityId === "battery.model.predict" && item.datasetId === datasetId && item.parameters?.model === selectedTask.model
  );

  useEffect(() => {
    let cancelled = false;
    setDatasets([]); setBindings([]); setDatasetId(""); setSource(undefined); setResult(undefined); setEvidence(undefined);
    void Promise.all([api.listBatteryModelCatalog(), api.getBatteryReleaseGate(), api.listDatasets(projectId), api.listAiDataBindings(projectId)])
      .then(([catalogResult, releaseResult, datasetResult, bindingResult]) => {
        if (cancelled) return;
        setCatalog(catalogResult.models); setRelease(releaseResult); setDatasets(datasetResult);
        const recommended = datasetResult.find((dataset) => assessBatteryDataContract("bmsformer", batteryDatasetFields(dataset)).compatible);
        setDatasetId((current) => current || recommended?.id || datasetResult[0]?.id || "");
        setBindings(bindingResult);
      })
      .catch(reason => { if (!cancelled) showError(reason); });
    return () => { cancelled = true; fileRead.current += 1; activeRequest.current?.abort(); activeRequest.current = undefined; };
  }, [projectId]);

  useEffect(() => {
    activeRequest.current?.abort(); activeRequest.current = undefined;
    setBusy(false); setResult(undefined); setEvidence(undefined); setError(""); setSampleRun(undefined);
  }, [projectId, task, sourceMode, source, datasetId, exampleId, chemistry, nominalCapacity, targetRetention]);

  useEffect(() => {
    const binding = bindings.find((item) => item.capabilityId === "battery.model.predict" && item.datasetId === datasetId && item.parameters?.model === selectedTask.model);
    if (!binding) { setRunPolicy(BATTERY_RUN_POLICIES[task]); return; }
    setRunPolicy({
      mode: binding.trigger.type === "interval" ? "interval" : "manual",
      intervalSeconds: binding.trigger.type === "interval" ? binding.trigger.seconds : BATTERY_RUN_POLICIES[task].intervalSeconds,
      windowRows: binding.window.rows ?? BATTERY_RUN_POLICIES[task].windowRows,
      minimumSamples: binding.quality.minimumSamples, maxAgeSeconds: binding.quality.maxAgeSeconds,
      maximumMissingRate: binding.quality.maximumMissingRate, entityField: binding.entity?.keyField ?? "",
      timeField: binding.time?.field ?? "",
    });
  }, [bindings, datasetId, selectedTask.model, task]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    const current = ++fileRead.current;
    const pendingRequest = activeRequest.current;
    activeRequest.current = undefined; pendingRequest?.abort();
    setBusy(true); setError(""); setResult(undefined);
    try {
      const parsed = await parseBatteryCsv(file);
      if (fileRead.current === current) setSource({ file, parsed });
    } catch (reason) {
      if (fileRead.current === current) { showError(reason); setSource(undefined); }
    } finally {
      if (fileRead.current === current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function runPrediction() {
    if (activeRequest.current) return;
    if (sourceMode === "dataset" && !datasetId) return setError("请先在数据中心建立并选择电池数据集");
    if (sourceMode === "file" && !source) return setError("请先上传单电芯或单工况 CSV");
    if (!dataContract?.compatible) return setError(dataContract ? batteryContractFailureMessage(dataContract) : "请先选择可用的电池数据");
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true); setError(""); setResult(undefined);
    try {
      setSampleRun(sourceMode === "example" ? selectedExample.id : undefined);
      if (task === "combined") await runCombined(controller); else await runSingle(controller);
    } catch (reason) {
      if (activeRequest.current === controller && !isAbortError(reason)) showError(reason);
    } finally {
      // 旧请求被新请求替换时，不得清空新请求的 busy 状态。
      if (activeRequest.current === controller) { activeRequest.current = undefined; setBusy(false); }
    }
  }

  async function runSingle(controller: AbortController) {
    const { response, bindingCreated } = await executeSingleBatteryPrediction({
      projectId, sourceMode, selectedExample, sourceFile: source?.file, datasetId, nominalCapacity, chemistry,
      targetRetention, dynamicRouting: release?.deployment.twinRuntime === "rust-ort", selectedTask,
      selectedDataset, bindings, runPolicy, dataContract: dataContract!, signal: controller.signal,
    });
    if (activeRequest.current !== controller || controller.signal.aborted) return;
    if (bindingCreated) {
      const refreshedBindings = await api.listAiDataBindings(projectId);
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      setBindings(refreshedBindings);
    }
    setResult(response.output);
    const sourceLabel = currentSourceLabel();
    const draft = batterySuggestionDraft({ projectId, task, result: response.output, source: suggestionSource(), reference: response.requestId, sourceLabel });
    setEvidence({ draft, payload: { source: draft.source, sourceLabel, response } });
  }

  async function runCombined(controller: AbortController) {
    const { combined, requestId } = await executeCombinedBatteryPrediction({
      projectId, sourceMode, selectedExample, sourceFile: source?.file, datasetId, nominalCapacity, chemistry,
      targetRetention, dynamicRouting: release?.deployment.twinRuntime === "rust-ort", signal: controller.signal,
    });
    if (activeRequest.current !== controller || controller.signal.aborted) return;
    setResult(combined);
    const sourceLabel = currentSourceLabel();
    const mergedOutput: Record<string, unknown> = Object.assign({}, combined.soc, combined.soh, combined.rul);
    const summaries = COMBINED_BATTERY_MODELS.flatMap(({ task: itemTask, label }) => {
      const output = combined[itemTask] as Record<string, unknown> | undefined;
      return typeof output?.summary === "string" ? [`${label}：${output.summary}`] : [];
    });
    if (summaries.length) mergedOutput.summary = summaries.join("\n");
    const draft = batterySuggestionDraft({ projectId, task: "SOC·SOH·RUL", result: mergedOutput, source: suggestionSource(), reference: requestId || "combined", sourceLabel });
    setEvidence({ draft, payload: { source: draft.source, sourceLabel, response: combined } });
  }

  async function setBindingStatus(status: AiDataBinding["status"]) {
    if (!activeBinding) return;
    setBusy(true); setError("");
    try { await api.saveAiDataBinding(projectId, { id: activeBinding.id, status }); setBindings(await api.listAiDataBindings(projectId)); }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  async function removeBinding() {
    if (!activeBinding || !window.confirm(`删除周期任务“${activeBinding.name}”？历史运行证据会保留。`)) return;
    setBusy(true); setError("");
    try { await api.deleteAiDataBinding(projectId, activeBinding.id); setBindings(await api.listAiDataBindings(projectId)); }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }

  function chooseTask(nextTask: BatteryTask) {
    const pendingRequest = activeRequest.current;
    activeRequest.current = undefined; pendingRequest?.abort(); setBusy(false); setTask(nextTask);
    if (sourceMode === "example" && !exampleSupportsBatteryTask(selectedExample, nextTask)) {
      const replacement = BATTERY_EXAMPLES.find((example) => exampleSupportsBatteryTask(example, nextTask));
      if (replacement) applyExample(replacement.id, nextTask);
    }
    setResult(undefined); setError("");
  }

  function applyExample(nextExampleId: string, currentTask = task) {
    const example = batteryExampleById(nextExampleId);
    setExampleId(example.id); setChemistry(example.chemistry); setNominalCapacity(String(example.nominalCapacityAh));
    if (!exampleSupportsBatteryTask(example, currentTask)) setTask(example.defaultTask);
  }

  function showError(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(/^(fetch failed|Failed to fetch)$/i.test(message) ? "无法连接电池预测服务。请在服务健康中检查预测服务地址与运行状态，然后重新运行。" : message);
  }

  function currentSourceLabel() {
    return sourceMode === "example" ? `内置样例 · ${selectedExample.name}` : sourceMode === "dataset" ? `项目数据集 · ${selectedDataset?.name ?? datasetId}` : `上传文件 · ${source?.file.name ?? "CSV"}`;
  }

  function suggestionSource() {
    return sourceMode === "example" ? "local-sample" as const : sourceMode === "dataset" ? "project-data" as const : "uploaded-file" as const;
  }

  function changeSourceMode(mode: BatterySourceMode) {
    setSourceMode(mode);
    if (mode === "example") applyExample(exampleId);
  }

  return (
    <div className="battery-workspace">
      <BatteryTechnologyRail nativeRuntime={release?.deployment.twinRuntime === "rust-ort"} />
      <BatteryIntelligenceRunPanel
        projectId={projectId} task={task} chemistry={chemistry} nominalCapacity={nominalCapacity}
        targetRetention={targetRetention} source={source} sourceMode={sourceMode} selectedExample={selectedExample}
        datasets={datasets} datasetId={datasetId} datasetAssessments={datasetAssessments}
        contractAssessments={contractAssessments} dataContract={dataContract} activeBinding={activeBinding}
        runPolicy={runPolicy} selectedTask={selectedTask} selectedModel={selectedModel} release={release}
        result={result} busy={busy} error={error} sampleRun={sampleRun} evidence={evidence} fileInput={fileInput}
        onChooseTask={chooseTask} onSourceModeChange={changeSourceMode} onExampleChange={applyExample}
        onDatasetChange={setDatasetId} onPolicyChange={setRunPolicy} onFileChange={selectFile}
        onChemistryChange={setChemistry} onNominalCapacityChange={setNominalCapacity}
        onTargetRetentionChange={setTargetRetention} onBindingStatusChange={setBindingStatus}
        onRemoveBinding={removeBinding} onRun={runPrediction}
      />
      {sourceMode === "dataset" && result && <BatteryEvidencePanel catalog={catalog} release={release} selectedModel={selectedModel} projectId={projectId} bindingId={activeBinding?.id} />}
      <BatteryScenarioWorkbench projectId={projectId} chemistry={chemistry} nominalCapacityAh={positiveOrUndefined(nominalCapacity)} nativeRuntime={release?.deployment.twinRuntime === "rust-ort"} />
    </div>
  );
}
