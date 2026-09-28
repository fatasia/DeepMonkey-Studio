import { useEffect, useRef, useState } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { AppViewBindings } from "../views/appViewBindings";
import type { SceneEditTransaction } from "./useSceneHistoryState";
import { captureSceneModelState } from "../viewer/captureSceneModelState";
import { modelInstanceError } from "../viewer/modelInstanceError";
import { assertDeepAssetPackageReference } from "../viewer/modelReplacementCompatibility";

/** 只改场景实例，不上传/删除资源；异步完成必须仍属于同一编辑场景。 */
export function useSceneModelInstances(bindings: AppViewBindings) {
  const latest = useRef(bindings);
  const mounted = useRef(true);
  latest.current = bindings;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pending = useRef(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const current = () => {
    const value = latest.current;
    const { route, project, activeScene, engine, busy } = value.state;
    return route.view === "studio" && project && activeScene && engine && !busy ? value : undefined;
  };
  const begin = () => {
    const owner = current();
    if (!owner || pending.current) return;
    // 离散命令前先收束连续编辑，完成后立即记账，不能被下一次 220ms 防抖吞掉。
    owner.sceneHistory.flush();
    pending.current = true; setWorking(true); setError(""); owner.state.setBusy(true);
    return owner;
  };
  const stillOwned = (owner: AppViewBindings) => {
    const state = latest.current.state;
    return state.route.view === "studio" && state.project?.id === owner.state.project?.id
      && state.activeScene?.id === owner.state.activeScene?.id && state.engine === owner.state.engine;
  };
  const finish = (owner: AppViewBindings) => {
    pending.current = false; setWorking(false);
    if (stillOwned(owner)) owner.state.setBusy(false);
  };
  const changed = (owner: AppViewBindings, id: string, message: string) => {
    owner.state.engine?.select(id);
    owner.state.setSceneOrganizationSelection(new Set([id]));
    owner.state.setRevision(value => value + 1);
    owner.sceneHistory.flush(message);
    owner.state.setMessage(message);
    setSelectedId(undefined);
  };
  /** T27：失败回滚=整体恢复到事务前快照（与撤销同路径），回滚失败也要如实上报。 */
  const rollback = async (owner: AppViewBindings, transaction: SceneEditTransaction) => {
    const before = transaction.rollback();
    if (!before || !stillOwned(owner) || !owner.state.project) return;
    try { await owner.scenePersistence.applyScene(before, false, owner.state.project, false); }
    catch (reason) { owner.state.showError(reason); }
  };
  async function duplicate(instanceId: string) {
    const owner = begin();
    if (!owner) return;
    const transaction = owner.sceneHistory.flush.beginTransaction("新增场景实例");
    try {
      const engine = owner.state.engine!;
      const original = engine.listModels().find(item => item.id === instanceId && item.kind === "model");
      const asset = owner.state.project!.models.find(item => item.id === (original?.assetModelId ?? original?.id));
      if (!original || !asset?.manifest || asset.status !== "ready") throw new Error("源素材尚未就绪或已移除");
      assertDeepAssetPackageReference(asset.manifest);
      const snapshot = captureSceneModelState(engine, original, asset);
      if (!snapshot) throw new Error("无法读取原实例状态");
      const id = crypto.randomUUID();
      const loaded = await engine.loadManifest(asset.manifest, id);
      if (!stillOwned(owner)) { transaction.rollback(); return; }
      const names = new Set(engine.listModels().map(item => item.name));
      let name = `${original.name} 副本`; let suffix = 2;
      while (names.has(name)) name = `${original.name} 副本 ${suffix++}`;
      engine.applyModelState(loaded.id, { ...snapshot, locked: false });
      engine.rename(loaded.id, name);
      const message = `已新增副本“${name}”`;
      transaction.commit(message);
      changed(owner, id, message);
    } catch (reason) {
      await rollback(owner, transaction);
      if (stillOwned(owner)) setError(modelInstanceError(reason));
    }
    finally { finish(owner); }
  }
  async function replace(instanceId: string, asset: ModelRecord) {
    const owner = begin();
    if (!owner) return;
    const transaction = owner.sceneHistory.flush.beginTransaction("替换素材");
    try {
      const authoritative = owner.state.project!.models.find(item => item.id === asset.id);
      if (!authoritative?.manifest || authoritative.status !== "ready") throw new Error("请选择当前项目已就绪的素材");
      assertDeepAssetPackageReference(authoritative.manifest);
      await owner.state.engine!.replaceModelManifest(instanceId, authoritative.manifest,
        () => mounted.current && stillOwned(owner));
      if (stillOwned(owner)) {
        const message = "已替换素材，原有绑定与配置保留，可撤销";
        transaction.commit(message);
        changed(owner, instanceId, message);
      } else transaction.rollback();
    } catch (reason) {
      await rollback(owner, transaction);
      if (stillOwned(owner)) setError(modelInstanceError(reason));
    }
    finally { finish(owner); }
  }
  function remove(instanceId: string) {
    const owner = current();
    const engine = owner?.state.engine;
    if (!owner || !engine || pending.current || engine.isModelLocked(instanceId)) return;
    if (!engine.listModels().some(item => item.id === instanceId && item.kind === "model")) return;
    const transaction = owner.sceneHistory.flush.beginTransaction("移除场景实例");
    engine.removeModel(instanceId);
    owner.state.setSceneOrganizationSelection(currentIds => new Set([...currentIds].filter(id => id !== instanceId)));
    owner.state.setRevision(value => value + 1);
    transaction.commit("移除场景实例（保留素材）");
    owner.state.setMessage("已移除实例，素材保留");
  }
  return {
    selectedId, working, error, duplicate, replace, remove,
    open: (id: string) => { if (current() && !pending.current) { setError(""); setSelectedId(id); } },
    close: () => { if (!pending.current) setSelectedId(undefined); },
  };
}
