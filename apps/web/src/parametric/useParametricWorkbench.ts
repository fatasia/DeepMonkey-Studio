import { useEffect, useMemo, useRef, useState } from "react";
import type { DataConnectionRecord, DataDatasetRecord, ModelRecord, ParametricCadDefinition } from "@bim-studio/contracts";
import { cloneParametricDefinition, listParametricBindingSources, PARAMETRIC_CAD_TEMPLATES, validateParametricCadDefinition } from "@bim-studio/parametric-modeling-plugin";
import { api } from "../api";
import { buildParametricCad } from "./parametricCadRuntime";
import type { ParametricCadBuildResult } from "./parametricCadTypes";
import { createParametricGeneration } from "./parametricGeneration";
import { createParametricGlb, downloadParametricGlb, safeParametricName } from "./parametricGlb";
import { ParametricOperationGate, parametricGeometryKey } from "./parametricWorkbenchState";

export interface ParametricWorkbenchOptions {
  projectId: string;
  sourceModel?: ModelRecord;
  dataConnections?: DataConnectionRecord[];
  datasets?: DataDatasetRecord[];
  onClose: () => void;
  onSaved: (model: ModelRecord) => void | Promise<void>;
}

export function useParametricWorkbench(options: ParametricWorkbenchOptions) {
  const source = options.sourceModel?.generation?.kind === "parametric" ? options.sourceModel.generation : undefined;
  const [definition, setDefinition] = useState(() => cloneParametricDefinition(source?.definition ?? PARAMETRIC_CAD_TEMPLATES[0]!.definition));
  const [templateId, setTemplateId] = useState(source ? "existing-version" : PARAMETRIC_CAD_TEMPLATES[0]!.id);
  const [output, setOutput] = useState<{ result: ParametricCadBuildResult; key: string }>();
  const [phase, setPhase] = useState<"idle" | "drafting" | "building" | "saving" | "downloading">("idle");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const gate = useRef(new ParametricOperationGate());
  const abort = useRef<AbortController | undefined>(undefined);
  const currentDefinition = useRef(definition);
  const savedModel = useRef<ModelRecord | undefined>(undefined);
  currentDefinition.current = definition;
  const validation = useMemo(() => validateParametricCadDefinition(definition), [definition]);
  const bindingSources = useMemo(() => listParametricBindingSources({ dataConnections: options.dataConnections ?? [], datasets: options.datasets ?? [] }), [options.dataConnections, options.datasets]);
  const current = !!output && output.key === parametricGeometryKey(definition);

  useEffect(() => () => { gate.current.cancel(); abort.current?.abort(); }, []);

  function cancel() {
    if (phase === "saving") return;
    gate.current.cancel();
    abort.current?.abort();
    abort.current = undefined;
    setPhase("idle");
    setNotice("已取消");
  }

  function change(next: ParametricCadDefinition) {
    if (phase !== "idle") return;
    currentDefinition.current = next;
    setDefinition(next);
    savedModel.current = undefined;
    setError(undefined);
    setNotice(undefined);
  }

  async function runBuild(next: ParametricCadDefinition, ticket: number) {
    const controller = new AbortController();
    abort.current = controller;
    setPhase("building");
    const result = await buildParametricCad(next, { signal: controller.signal });
    if (!gate.current.current(ticket)) return;
    setOutput({ result, key: parametricGeometryKey(next) });
    savedModel.current = undefined;
    setNotice("预览已生成");
  }

  async function generate(kind: "template" | "ai", template?: typeof PARAMETRIC_CAD_TEMPLATES[number]) {
    const next = template ? cloneParametricDefinition(template.definition) : cloneParametricDefinition(currentDefinition.current);
    if (kind === "template" && !validateParametricCadDefinition(next).valid) return;
    if (kind === "ai" && prompt.trim().length < 3) return;
    const ticket = gate.current.begin();
    if (ticket === undefined) return;
    setError(undefined);
    setNotice(undefined);
    try {
      if (template) { setDefinition(next); currentDefinition.current = next; setTemplateId(template.id); }
      if (kind === "ai") {
        setPhase("drafting");
        const controller = new AbortController();
        abort.current = controller;
        const response = await api.invokeCapability<{ definition: ParametricCadDefinition }>(options.projectId, "modeling.parametric.draft", { prompt: prompt.trim() }, "web-user", controller.signal);
        if (!gate.current.current(ticket)) return;
        if (response.status !== "completed" || !response.output) throw new Error(response.error?.message || response.warnings[0] || "AI 草案生成失败，请检查 AI 服务后重试，或使用下方样例。");
        const draft = cloneParametricDefinition(response.output.definition);
        const checked = validateParametricCadDefinition(draft);
        if (!checked.valid) throw new Error(checked.issues.map((issue) => issue.message).join("；"));
        setDefinition(draft);
        currentDefinition.current = draft;
        setTemplateId("ai-draft");
        await runBuild(draft, ticket);
      } else await runBuild(next, ticket);
    } catch (reason) {
      if (gate.current.current(ticket) && !(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (gate.current.finish(ticket)) { abort.current = undefined; setPhase("idle"); }
    }
  }

  async function save() {
    const snapshot = cloneParametricDefinition(currentDefinition.current);
    if (!output || output.key !== parametricGeometryKey(snapshot) || !validateParametricCadDefinition(snapshot).valid) return;
    const ticket = gate.current.begin();
    if (ticket === undefined) return;
    setPhase("saving");
    setError(undefined);
    try {
      // 资源上传成功而列表刷新失败时，重试只执行回调，避免产生重复版本。
      let model = savedModel.current;
      if (!model) {
        const glb = await createParametricGlb(output.result, snapshot.name);
        if (!gate.current.current(ticket)) return;
        model = await api.uploadModel(options.projectId, new File([glb], `${safeParametricName(snapshot.name)}.glb`, { type: "model/gltf-binary" }), "native-glb", "auto", createParametricGeneration(snapshot, output.result.summary, options.sourceModel));
        savedModel.current = model;
      }
      if (!gate.current.current(ticket)) return;
      await options.onSaved(model);
      if (gate.current.current(ticket)) options.onClose();
    } catch (reason) {
      if (gate.current.current(ticket)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (gate.current.finish(ticket)) setPhase("idle"); }
  }

  async function downloadGlb() {
    const snapshot = cloneParametricDefinition(currentDefinition.current);
    if (!output || output.key !== parametricGeometryKey(snapshot) || !validateParametricCadDefinition(snapshot).valid) return;
    const ticket = gate.current.begin();
    if (ticket === undefined) return;
    setPhase("downloading");
    setError(undefined);
    try {
      const glb = await createParametricGlb(output.result, snapshot.name);
      if (!gate.current.current(ticket)) return;
      downloadParametricGlb(glb, snapshot.name);
      setNotice("GLB 已开始下载");
    } catch (reason) {
      if (gate.current.current(ticket)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (gate.current.finish(ticket)) setPhase("idle");
    }
  }

  function updateBinding(parameterId: string, sourceKey: string) {
    const selected = bindingSources.find((item) => item.key === sourceKey);
    const next = cloneParametricDefinition(definition);
    const bindings = [...(next.semanticBindings ?? [])];
    const index = bindings.findIndex((item) => item.parameterId === parameterId);
    const existing = bindings[index];
    if (!selected) {
      if (existing?.targetId) { const { target: _target, ...rest } = existing; bindings[index] = rest; }
      else if (index >= 0) bindings.splice(index, 1);
    } else {
      const binding = { parameterId, source: selected.connectionName, meaning: existing?.meaning || next.parameters.find((item) => item.id === parameterId)!.label, ...(existing?.targetId ? { targetId: existing.targetId } : {}), target: structuredClone(selected.target) };
      if (index >= 0) bindings[index] = binding; else bindings.push(binding);
    }
    next.semanticBindings = bindings;
    change(next);
  }

  return { definition, templateId, result: output?.result, current, validation, phase, prompt, setPrompt, error, notice, change, generate, save, downloadGlb, cancel, bindingSources, updateBinding,
    close: () => { if (phase !== "saving") { cancel(); options.onClose(); } } };
}
