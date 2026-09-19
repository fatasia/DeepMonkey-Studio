import { useEffect, useRef, useState } from "react";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as THREE from "three";
import { ViewerEngine } from "../viewer/ViewerEngine";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { ModelDiffReviewPanel } from "../components/ModelDiffReviewPanel";
import "./modelDiffVisualQa.css";

// P1 模型版本对比评审·视觉验收页（?__visualQa=model-diff）。
// 用真实 ViewerEngine 加载两份运行时生成的 GLB 版本（仅内存 blob，不落盘），
// 通过真实面板交互验证：快照捕获 → diff → 三色高亮 → 构件定位。

interface QaState {
  ready: boolean;
  error?: string;
  loaded?: Array<{ id: string; name: string; components: number }>;
  focusName?: string;
  highlightApplied?: boolean;
}

declare global {
  interface Window {
    __modelDiffQa?: QaState;
    /** 仅验收脚本使用的引擎句柄；生产入口不创建视觉验收页。 */
    __modelDiffQaEngine?: ViewerEngine;
  }
}

interface VersionPart {
  elementId: string;
  name: string;
  color: string;
  x: number;
  fireRating?: string;
}

const VERSION_A: VersionPart[] = [
  { elementId: "wall-01", name: "保留外墙", color: "#9aa7ad", x: -3, fireRating: "1h" },
  { elementId: "wall-02", name: "待拆除隔墙", color: "#b0876a", x: 0 },
];
const VERSION_B: VersionPart[] = [
  { elementId: "wall-01", name: "保留外墙", color: "#9aa7ad", x: -3, fireRating: "2h" },
  { elementId: "wall-03", name: "新增设备墙", color: "#6f9f8a", x: 3 },
];

export default function ModelDiffVisualQa() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ViewerEngine | undefined>(undefined);
  const [state, setState] = useState<QaState>({ ready: false });
  const [models, setModels] = useState<LoadedSceneModel[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    void (async () => {
      try {
        const engine = await ViewerEngine.create(host, "webgl");
        if (disposed) { engine.dispose(); return; }
        engineRef.current = engine;
        engine.setSceneEnvironment({ gridVisible: true, backgroundColor: "#11191d", skybox: "none" });
        const loaded: LoadedSceneModel[] = [];
        for (const [index, parts] of [VERSION_A, VERSION_B].entries()) {
          const manifest = {
            schemaVersion: 1 as const,
            modelId: `qa-version-${index === 0 ? "a" : "b"}`,
            sourceName: index === 0 ? "厂房 v1.glb" : "厂房 v2.glb",
            sourceFormat: "glb" as const,
            viewerKind: "gltf" as const,
            geometryUrl: await versionBlobUrl(parts),
            createdAt: new Date().toISOString(),
          };
          loaded.push(await engine.loadManifest(manifest));
        }
        if (disposed) return;
        window.__modelDiffQaEngine = engine;
        setModels(loaded);
        const published: QaState = {
          ready: true,
          loaded: loaded.map((model) => ({ id: model.id, name: model.name, components: engine.getComponentCount() })),
        };
        window.__modelDiffQa = published;
        setState(published);
      } catch (reason) {
        const failed: QaState = { ready: false, error: reason instanceof Error ? reason.message : String(reason) };
        window.__modelDiffQa = failed;
        setState(failed);
      }
    })();
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = undefined;
      delete window.__modelDiffQa;
    };
  }, []);

  return <main className="model-diff-qa" data-qa-ready={state.ready} data-qa-error={state.error ?? ""}>
    <div className="model-diff-qa-canvas" ref={hostRef} />
    <header>
      <span><small>PRODUCT BROWSER QA</small><strong>模型版本对比评审</strong></span>
      <output data-qa-metrics>{JSON.stringify(state)}</output>
    </header>
    <ModelDiffReviewPanel
      locale="zh-CN"
      engine={engineRef.current}
      models={models}
      onLocate={(record) => {
        engineRef.current?.focusComponent(record);
        setState((current) => ({ ...current, focusName: record.name }));
        window.__modelDiffQa = { ...(window.__modelDiffQa ?? { ready: true, loaded: [] }), focusName: record.name };
      }}
      onClose={() => undefined}
    />
  </main>;
}

/** 生成单一版本的 GLB 内存地址；userData 携带 ElementId 使跨版本构件身份稳定。 */
async function versionBlobUrl(parts: VersionPart[]): Promise<string> {
  const group = new THREE.Group();
  group.name = "厂房";
  for (const part of parts) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 3, 1),
      new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.65, metalness: 0.05 }),
    );
    mesh.name = part.name;
    mesh.position.set(part.x, 1.5, 0);
    mesh.userData = {
      NodeType: "Element",
      ElementId: part.elementId,
      Name: part.name,
      ...(part.fireRating ? { FireRating: part.fireRating } : {}),
    };
    group.add(mesh);
  }
  const result = await new GLTFExporter().parseAsync(group, { binary: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("QA 夹具导出失败");
  return URL.createObjectURL(new Blob([result], { type: "model/gltf-binary" }));
}
