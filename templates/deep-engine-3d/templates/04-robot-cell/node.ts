import { createScene, pose } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "04-robot-cell", scene: createScene(),
  frames: 10, stepMs: 40,
  checks: log => {
    const grip = log.map(entry => entry.instanceTransforms["gripper"]!);
    const moved = grip.some(p => p.some((value, axis) => Math.abs(value - grip[0]![axis]!) > 1e-4));
    if (!moved) throw new Error("Gripper did not move across the joint animation");
    const shoulder0 = createScene().packet.instances.find(i => i.id === "shoulder-joint")!.transform;
    for (const value of Array.from(shoulder0)) if (!Number.isFinite(value)) throw new Error("Non-finite transform entry");
    const world = pose(120).shoulder;
    const radius = Math.hypot(world[0]!, world[1]!, world[2]!);
    if (Math.abs(radius - 1) > 1e-6) throw new Error(`Rotation matrix scale drift: ${radius}`);
  } });
console.log(JSON.stringify(result));
