import { useEffect, useRef, useState } from "react";
import type {
  DataDatasetRecord,
  DataPipelineDefinition,
  SemanticModelRecord,
} from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { semanticSaveErrors } from "./semanticModelEditorLogic";

export function useSemanticModelStudio(projectId: string, locale: AppLocale) {
  const [models, setModels] = useState<SemanticModelRecord[]>([]);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<SemanticModelRecord>();
  const [busy, setBusy] = useState(false);
  const baseline = useRef("");
  const alive = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(false);
  const load = async () => {
    const request = ++epoch.current;
    setStatus("loading");
    setErrors([]);
    try {
      const [models, datasets, pipelines] = await Promise.all([
        api.listSemanticModels(projectId),
        api.listDatasets(projectId),
        api.listDataPipelines(projectId),
      ]);
      if (!alive.current || request !== epoch.current) return;
      setModels(models);
      setDatasets(datasets);
      setPipelines(pipelines);
      setStatus("ready");
    } catch (error) {
      if (alive.current && request === epoch.current) {
        setErrors(semanticSaveErrors(error));
        setStatus("error");
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      epoch.current += 1;
    };
  }, [projectId]);
  const leave = () => {
    if (pending.current) return false;
    if (
      draft &&
      JSON.stringify(draft) !== baseline.current &&
      !window.confirm(
        tr(
          locale,
          "有未保存修改，放弃修改并返回列表？",
          "Discard unsaved changes and return to the list?",
        ),
      )
    )
      return false;
    setDraft(undefined);
    setErrors([]);
    return true;
  };
  const open = (model: SemanticModelRecord) => {
    setDraft(structuredClone(model));
    baseline.current = JSON.stringify(model);
    setErrors([]);
    setNotice("");
  };
  const mutate = async (operation: () => Promise<void>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setErrors([]);
    try {
      await operation();
      return true;
    } catch (error) {
      if (alive.current) setErrors(semanticSaveErrors(error));
      return false;
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = () => {
    if (!draft) return;
    const snapshot = structuredClone(draft);
    void mutate(async () => {
      const saved = snapshot.revision
        ? await api.updateSemanticModel(projectId, snapshot)
        : await api.createSemanticModel(projectId, snapshot);
      if (!alive.current) return;
      setModels((current) => [
        ...current.filter((item) => item.id !== saved.id),
        saved,
      ]);
      setDraft(saved);
      baseline.current = JSON.stringify(saved);
      setNotice(
        tr(locale, `已保存 · r${saved.revision}`, `Saved · r${saved.revision}`),
      );
    });
  };

  const renameModel = (model: SemanticModelRecord, name: string) =>
    mutate(async () => {
      const saved = await api.updateSemanticModel(projectId, {
        ...model,
        name,
      });
      if (alive.current)
        setModels((current) =>
          current.map((item) => (item.id === saved.id ? saved : item)),
        );
    });
  const deleteModel = (model: SemanticModelRecord) => {
    if (
      window.confirm(
        tr(
          locale,
          `删除语义模型“${model.name}”？`,
          `Delete semantic model “${model.name}”?`,
        ),
      )
    ) {
      void mutate(async () => {
        await api.deleteSemanticModel(projectId, model.id);
        if (alive.current)
          setModels((current) =>
            current.filter((item) => item.id !== model.id),
          );
      });
    }
  };
  const changeDraft = (model: SemanticModelRecord) => {
    setDraft(model);
    setNotice("");
  };
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline.current);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  return {
    models,
    datasets,
    pipelines,
    status,
    errors,
    notice,
    draft,
    busy,
    dirty,
    load,
    leave,
    open,
    save,
    renameModel,
    deleteModel,
    changeDraft,
  };
}
