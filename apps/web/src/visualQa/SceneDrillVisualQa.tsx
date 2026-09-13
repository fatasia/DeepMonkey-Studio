import { useState } from "react";
import type { SceneInteractionScriptState } from "@bim-studio/contracts";
import { SceneDrillWizard } from "../components/SceneDrillWizard";

export default function SceneDrillVisualQa() {
  const [open, setOpen] = useState(true);
  const [interactions, setInteractions] = useState<SceneInteractionScriptState[]>([]);
  const [preview, setPreview] = useState("");
  return <main className="app-shell">
    <button type="button" onClick={() => setOpen(true)}>打开钻取向导</button>
    <p role="status">{preview}</p>
    {open && <SceneDrillWizard locale="zh-CN" sceneId="qa-campus" sceneName="智造园区 · 钻取验收"
      sources={[
        { label: "一号生产楼", target: { kind: "object", modelId: "building-1" } },
        { label: "一层装配车间", target: { kind: "object", modelId: "floor-1" } },
        { label: "二层检测车间", target: { kind: "object", modelId: "floor-2" } },
        { label: "机器人 A", target: { kind: "object", modelId: "robot-a" } },
      ]}
      scenes={[{ id: "building", name: "一号生产楼" }, { id: "floor", name: "一层装配车间" }]}
      cameras={[{ id: "floor-two-camera", name: "二层检测车间" }]}
      interactions={interactions} onChange={setInteractions} onPreview={(item) => setPreview(`动作验收：${item.actions?.[0]?.type}`)} onClose={() => setOpen(false)} />}
  </main>;
}
