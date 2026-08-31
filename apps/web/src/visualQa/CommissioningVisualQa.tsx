import type { ModelTransform, SceneSnapshot } from "@bim-studio/contracts";
import { VirtualCommissioningWorkbench } from "../components/VirtualCommissioningWorkbench";
import "./commissioningVisualQa.css";

const createdAt = "2026-08-30T00:00:00.000Z";
const identity: ModelTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

const scene: SceneSnapshot = {
  schemaVersion: 1,
  id: "workcell-qa",
  projectId: "visual-qa",
  name: "电池模组装配工位",
  camera: { position: { x: 10, y: 8, z: 10 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" },
  models: [{
    modelId: "robot-a",
    name: "装配机器人 A",
    visible: true,
    opacity: 1,
    transform: identity,
    rig: {
      bones: [],
      ik: [],
      robot: {
        enabled: true,
        baseBonePath: "root",
        targetObjectIds: ["target-01"],
        joints: [
          { bonePath: "root/shoulder", name: "肩部", axis: "z", length: 1.2, minAngleDeg: -170, maxAngleDeg: 170 },
          { bonePath: "root/shoulder/elbow", name: "肘部", axis: "z", length: 1, minAngleDeg: -120, maxAngleDeg: 120 },
        ],
      },
    },
  }],
  primitives: [
    { modelId: "fixture-01", name: "模组夹具", kind: "box", color: "#537b83", visible: true, opacity: 1, transform: { ...identity, position: { x: 1.8, y: .45, z: 0 }, scale: { x: .7, y: .45, z: .9 } } },
    { modelId: "fence-01", name: "安全围栏", kind: "box", color: "#a77d3d", visible: true, opacity: .72, transform: { ...identity, position: { x: 2.8, y: 1, z: 0 }, scale: { x: .06, y: 1, z: 2.8 } } },
  ],
  annotations: [{ id: "target-01", name: "装配目标点", position: { x: 1.65, y: 1.1, z: 0 }, color: "#d4a84f", visible: true, locked: false }],
  measurements: [],
  createdAt,
  updatedAt: createdAt,
};

export default function CommissioningVisualQa() {
  return <main className="commissioning-visual-qa">
    <VirtualCommissioningWorkbench
      projectId="visual-qa"
      scenes={[scene]}
      onOpenTarget={() => undefined}
    />
  </main>;
}
