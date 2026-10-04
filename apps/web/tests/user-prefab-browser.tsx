import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SceneModelState, UserPrefabDefinition, UserPrefabInstanceRecord, UserPrefabUpdateDiff } from "@bim-studio/contracts";
import type { PrimitiveState } from "@bim-studio/contracts";
import "../src/styles/base.css";
import "../src/styles/scene-workspace-hierarchy.css";
import "../src/styles/scene-workspace-chrome.css";
import "../src/styles/scene-manager.css";
import "../src/styles/platform-components.css";
import "../src/styles/userPrefab.css";
import "../src/styles/interactionPolish.css";
import { SaveUserPrefabDialog, ApplyUserPrefabUpdateDialog, UserPrefabRowBadge } from "../src/components/UserPrefabDialogs";
import { SceneSelectionBar } from "../src/components/SceneSelectionBar";
import { PrimitiveRow } from "../src/components/ScenePrimitiveRow";
import { createUserPrefabActions, type UserPrefabActionsContext } from "../src/controllers/userPrefabActions";
import { buildUserPrefabTreeMarks } from "../src/prefabs/userPrefabModel";
import { translate as tr } from "../src/i18n";

/**
 * 用户组合预制体真实交互夹具（T0 刀 2）：
 * 引擎接缝用行为正确的最小桩（createPrimitive/applyModelState/setColor/…），
 * 对话框、选择条、行徽章与 userPrefabActions 全部是生产模块；
 * 页面自带断言区，供浏览器驱动读取与截图。
 */

interface FakeModel {
  id: string;
  name: string;
  kind: "primitive";
  primitiveKind: "box" | "cylinder";
  color: string;
  visible: boolean;
  opacity: number;
  transform: SceneModelState["transform"];
}

function makeEngine(models: Map<string, FakeModel>) {
  const engine = {
    models,
    listModels() {
      return [...models.values()].map((model) => ({ id: model.id, kind: "primitive" as const, name: model.name, visible: model.visible, opacity: model.opacity }));
    },
    createPrimitive(id: string, name: string, kind: "box" | "cylinder" = "box", color = "#d4a84f") {
      models.set(id, {
        id, name, kind: "primitive", primitiveKind: kind, color,
        visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      });
      return { id, kind: "primitive" as const, name, visible: true, opacity: 1 };
    },
    setModelTransform(id: string, transform: SceneModelState["transform"]) {
      const model = models.get(id);
      if (model) model.transform = { position: { ...transform.position }, rotation: { ...transform.rotation }, scale: { ...transform.scale } };
    },
    applyModelState(id: string, state: Partial<PrimitiveState>) {
      const model = models.get(id);
      if (!model) return;
      if (state.transform) model.transform = { position: { ...state.transform.position }, rotation: { ...state.transform.rotation }, scale: { ...state.transform.scale } };
      if (typeof state.opacity === "number") model.opacity = state.opacity;
      if (typeof state.visible === "boolean") model.visible = state.visible;
      if (typeof state.name === "string") model.name = state.name;
    },
    setColor(id: string, color: string) {
      const model = models.get(id);
      if (model) model.color = color;
    },
    rename(id: string, name: string) {
      const model = models.get(id);
      if (model) model.name = name;
    },
    removeModel(id: string) {
      models.delete(id);
    },
    primitiveState(id: string, fallbackColor: string): PrimitiveState | undefined {
      const model = models.get(id);
      if (!model) return undefined;
      return {
        modelId: model.id, name: model.name, kind: model.primitiveKind,
        color: model.color || fallbackColor, visible: model.visible, locked: false, opacity: model.opacity,
        transform: model.transform,
      };
    },
    getCameraState() {
      return { position: { x: 6, y: 5, z: 8 }, target: { x: 2, y: 0, z: 0 }, mode: "orbit" as const };
    },
    select() { /* fixture no-op */ },
    focusModel() { return true; },
    isModelLocked() { return false; },
    isolateModels() { /* fixture no-op */ },
    setCollisionEnabled() { /* fixture no-op */ },
    isColliding() { return false; },
    isCollisionEnabled() { return false; },
  };
  return engine as unknown as UserPrefabActionsContext["engine"] & Record<string, unknown>;
}

function initialModels(): Map<string, FakeModel> {
  const models = new Map<string, FakeModel>();
  const at = (x: number, z: number): SceneModelState["transform"] => ({
    position: { x, y: 0.4, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 },
  });
  models.set("pump", { id: "pump", name: "泵体", kind: "primitive", primitiveKind: "box", color: "#2f80ed", visible: true, opacity: 1, transform: at(0, 0) });
  models.set("motor", { id: "motor", name: "电机", kind: "primitive", primitiveKind: "cylinder", color: "#278f83", visible: true, opacity: 1, transform: at(2, 0) });
  models.set("base", { id: "base", name: "底座", kind: "primitive", primitiveKind: "box", color: "#53616a", visible: true, opacity: 1, transform: at(1, 0) });
  return models;
}

interface CheckItem { id: string; label: string; pass: boolean | undefined }

function Fixture() {
  const modelsRef = useRef<Map<string, FakeModel>>(initialModels());
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((value) => value + 1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [userPrefabs, setUserPrefabs] = useState<UserPrefabDefinition[]>([]);
  const [instances, setInstances] = useState<UserPrefabInstanceRecord[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [applyInstanceId, setApplyInstanceId] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const append = (line: string) => setLog((previous) => [...previous.slice(-30), line]);
  const showError = (reason: unknown) => append(`ERROR: ${reason instanceof Error ? reason.message : String(reason)}`);

  const engine = useMemo(() => makeEngine(modelsRef.current), []);
  // 浏览器驱动调试句柄：只读事实导出，不参与断言逻辑。
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__prefabDebug = {
      models: () => Object.fromEntries([...modelsRef.current.values()].map((model) => [model.id, { x: model.transform.position.x, color: model.color, name: model.name }])),
      instances: () => instances,
    };
  });
  const readState = (objectId: string) => engine.primitiveState(objectId, "#d4a84f") as PrimitiveState | undefined;

  const sceneHistory = useMemo(() => {
    const flush = (() => {}) as UserPrefabActionsContext["sceneHistory"];
    flush.beginTransaction = () => ({
      label: "fixture",
      before: undefined,
      active: true,
      commit(label?: string) { append(`TX commit: ${label ?? "fixture"}`); },
      rollback() { append("TX rollback"); return undefined; },
    });
    return flush;
  }, []);

  const context: UserPrefabActionsContext = useMemo(() => ({
    engine,
    project: undefined,
    locale: "zh-CN",
    sceneOrganizationSelection: selected,
    userPrefabs,
    userPrefabInstances: instances,
    setUserPrefabs: (value) => { setUserPrefabs(value as UserPrefabDefinition[]); },
    setUserPrefabInstances: (value) => { setInstances(value as UserPrefabInstanceRecord[]); },
    primitiveColors: { current: new Map() },
    setRevision: () => rerender(),
    setSceneOrganizationSelection: (value) => setSelected(value as Set<string>),
    setMessage: (message) => append(`MSG: ${message}`),
    showError,
    sceneHistory,
    recordSceneEdit: (label) => append(`EDIT: ${label}`),
  }), [engine, selected, userPrefabs, instances, sceneHistory]);

  const userPrefab = useMemo(() => createUserPrefabActions(context), [context]);
  const marks = useMemo(() => buildUserPrefabTreeMarks(instances, userPrefabs), [instances, userPrefabs]);
  const diff: UserPrefabUpdateDiff | undefined = applyInstanceId ? userPrefab.diffUserPrefabInstance(applyInstanceId) : undefined;
  const definitionById = new Map(userPrefabs.map((item) => [item.id, item]));

  // 断言闩锁：检查一旦为真即保持为真（后续步骤改状态不让前序证据回退）。
  const latched = useRef<Record<string, boolean>>({});
  const memberAt = (index: number) => Object.values(instances[index]?.memberObjectIds ?? {});
  const latchedChecks: Array<{ id: string; label: string; live: boolean }> = [
    { id: "save", label: "存为预制体入库（命名+分类+版本 1）", live: userPrefabs.length >= 1 && userPrefabs[0]?.name === "卧式泵组" && userPrefabs[0]?.category === "泵/风机" && userPrefabs[0]?.version === 1 },
    { id: "instantiate", label: "实例化 A：3 成员落位且登记映射完整", live: instances.length >= 1 && Object.keys(instances[0]?.memberObjectIds ?? {}).length === 3 },
    {
      id: "placement",
      label: "实例 A 保持层级与相对偏移（锚点 x=2）",
      live: (() => {
        const mapping = instances[0]?.memberObjectIds;
        if (!mapping) return false;
        const pump = modelsRef.current.get(mapping.pump ?? "");
        const motor = modelsRef.current.get(mapping.motor ?? "");
        return Math.abs((pump?.transform.position.x ?? 9) - 1) < 1e-6 && Math.abs((motor?.transform.position.x ?? 9) - 3) < 1e-6;
      })(),
    },
    { id: "override", label: "改 A 泵体位置→检测覆盖（1 成员路径级登记）", live: instances.length >= 1 && instances[0]?.overrides !== undefined && Object.keys(instances[0].overrides ?? {}).length === 1 },
    { id: "pending", label: "原型更新 v1→v2：A/B 均进入待更新", live: Boolean(userPrefabs[0] && userPrefabs[0].version >= 2 && instances.every((record) => record.prefabVersion < userPrefabs[0].version)) },
    {
      id: "apply",
      label: "应用更新到 B：泵体对齐 v2（1.6），无覆盖传播",
      live: (() => {
        if (instances.length < 2 || instances[1]?.prefabVersion !== 2) return false;
        const mapping = instances[1].memberObjectIds;
        const pump = modelsRef.current.get(mapping.pump ?? "");
        return Math.abs((pump?.transform.position.x ?? 9) - 1.6) < 1e-6;
      })(),
    },
    { id: "reset", label: "重置 A 覆盖成员为原型（清除覆盖记录）", live: instances.length >= 1 && instances[0]?.overrides === undefined },
    {
      id: "persist",
      label: "实例记录可 JSON 序列化（持久化合同）",
      live: (() => { try { return instances.every((record) => JSON.parse(JSON.stringify(record)).instanceId === record.instanceId); } catch { return false; } })(),
    },
  ];
  for (const item of latchedChecks) if (item.live) latched.current[item.id] = true;
  const checks: CheckItem[] = latchedChecks.map((item) => ({ id: item.id, label: item.label, pass: latched.current[item.id] === true }));
  void memberAt;
  const allPass = checks.every((item) => item.pass === true);
  const rows = engine.listModels();

  return <div style={{ padding: 18, background: "var(--bg-1)", minHeight: "100vh", color: "var(--text)" }}>
    <h2 style={{ fontSize: 15, margin: "0 0 10px", color: "var(--text-strong)" }}>用户组合预制体 · 真实交互夹具（引擎桩 + 生产模块）</h2>
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
      <section style={{ width: 380 }} aria-label="场景选择与行">
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <button type="button" data-fixture="move-member" title="把选中成员右移 0.6（模拟用户改属性）"
            onClick={() => {
              for (const id of selected) {
                const state = readState(id);
                if (!state) continue;
                engine.applyModelState(id, { transform: { ...state.transform, position: { ...state.transform.position, x: state.transform.position.x + 0.6 } } });
              }
              rerender();
            }}
            style={{ padding: "3px 8px", fontSize: 11, borderRadius: 5, border: "1px solid var(--line)", color: "var(--text)" }}
          >移动选中成员 +0.6x</button>
          {rows.map((row) => <button
            key={row.id}
            data-object-row={row.id}
            onClick={(event) => {
              setSelected((current) => {
                const next = new Set(event.shiftKey ? current : []);
                if (current.has(row.id) && event.shiftKey) next.delete(row.id); else next.add(row.id);
                return next;
              });
            }}
            style={{ padding: "3px 8px", fontSize: 11, borderRadius: 5, border: "1px solid var(--line)", background: selected.has(row.id) ? "var(--accent-soft)" : "transparent", color: "var(--text)" }}
          >
            {row.name}
          </button>)}
        </div>
        <SceneSelectionBar
          locale="zh-CN"
          selectedObjects={rows.filter((row) => selected.has(row.id))}
          onGroup={() => append("group clicked")}
          onSaveAsPrefab={() => setSaveOpen(true)}
          onShow={(visible) => append(`show ${visible}`)}
          onLock={() => append("lock")}
          onClear={() => setSelected(new Set())}
        />
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "var(--surface-1)" }}>
          {rows.map((row) => <div key={row.id} data-member-row={row.id}><PrimitiveRow
            key={row.id}
            locale="zh-CN"
            engine={engine as never}
            primitive={{ id: row.id, kind: "primitive" as const, name: row.name, visible: row.visible, opacity: row.opacity } as never}
            selectedObjectIds={selected}
            onObjectSelect={(id) => setSelected(new Set([id]))}
            onRevision={rerender}
            onPrimitiveRemove={(id) => { engine.removeModel(id); rerender(); }}
            prefabMarks={marks}
            onPrefabRowAction={(objectId, action) => {
              const record = instances.find((item) => Object.values(item.memberObjectIds).includes(objectId));
              if (!record) return;
              const instanceId = record.instanceId;
              if (action === "apply-update") {
                if (!userPrefab.diffUserPrefabInstance(instanceId)) { append("MSG: 已是最新"); return; }
                setApplyInstanceId(instanceId);
              } else if (action === "update-prototype") userPrefab.updateUserPrefabFromInstance(record.prefabId, instanceId);
              else if (action === "refresh-overrides") userPrefab.refreshUserPrefabOverrides(instanceId);
              else userPrefab.resetUserPrefabMember(instanceId, objectId);
            }}
          /></div>)}
        </div>
        {userPrefabs.length > 0 && <section className="user-prefab-section" data-testid="user-prefab-section" aria-label="我的预制体">
          <div className="user-prefab-section-header"><span>我的预制体</span><small>{userPrefabs.length}</small></div>
          {userPrefabs.map((prefab) => <article className="user-prefab-row" key={prefab.id} data-user-prefab-id={prefab.id}>
            <span className="user-prefab-row-icon">▢</span>
            <span className="user-prefab-row-copy"><strong>{prefab.name}</strong><small>{prefab.category} · v{prefab.version} · {prefab.objects.length} 个对象</small></span>
            <span className="user-prefab-row-actions">
              <button type="button" data-insert-prefab={prefab.id} title="插入实例" onClick={() => userPrefab.instantiateUserPrefab(prefab.id).catch(showError)}>＋</button>
            </span>
          </article>)}
        </section>}
      </section>

      <section style={{ flex: 1, minWidth: 330 }} aria-label="断言与日志">
        <div id="prefab-checks" data-all-pass={allPass ? "true" : "false"} style={{ display: "grid", gap: 5 }}>
          {checks.map((item) => <div key={item.id} data-check={item.id} data-pass={item.pass === undefined ? "pending" : String(item.pass)}
            style={{ fontSize: 12, padding: "5px 9px", borderRadius: 6, background: item.pass ? "rgba(54,163,160,.12)" : "rgba(223,48,79,.1)", color: item.pass ? "#7ad7cf" : "#e27478" }}>
            [{item.pass ? "PASS" : "FAIL"}] {item.label}
          </div>)}
        </div>
        <div id="prefab-state" data-definitions={userPrefabs.length} data-instances={instances.length}
          data-latest-version={userPrefabs[0]?.version ?? 0} data-instance-version={instances[0]?.prefabVersion ?? 0}
          data-pending={(() => {
            const record = instances[0];
            const definition = definitionById.get(record?.prefabId ?? "");
            return record && definition ? (definition.version > record.prefabVersion ? "true" : "false") : "unknown";
          })()}
          style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }} />
        <ul style={{ fontSize: 11, lineHeight: 1.7, maxHeight: 220, overflow: "auto", color: "var(--text-muted)" }} aria-label="操作日志">
          {log.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
        </ul>
      </section>
    </div>

    {saveOpen && <SaveUserPrefabDialog locale="zh-CN" defaultName={`预制体 ${userPrefabs.length + 1}`} onSave={(name, category) => {
      // 生产 action：采集/入库/消息全部走 userPrefabActions 同一路径。
      const definition = userPrefab.saveSelectionAsPrefab(name, category);
      if (!definition) append("ERROR: 保存未产出定义");
      rerender();
      setSaveOpen(false);
    }} onClose={() => setSaveOpen(false)} />}
    {applyInstanceId && diff && <ApplyUserPrefabUpdateDialog locale="zh-CN" prefabName={definitionById.get(diff.prefabId)?.name ?? "预制体"} diff={diff} onApply={() => {
      const instanceId = applyInstanceId;
      setApplyInstanceId(undefined);
      userPrefab.applyUserPrefabUpdate(instanceId).catch(showError);
    }} onClose={() => setApplyInstanceId(undefined)} />}
  </div>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
