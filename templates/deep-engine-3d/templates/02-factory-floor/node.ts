import { createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "02-factory-floor", scene: createScene(),
  checks: log => {
    const scene = createScene().packet;
    const machineIds = scene.instances.filter(instance => instance.id.startsWith("machine-"));
    if (machineIds.length !== 8) throw new Error(`Expected 8 machines, got ${machineIds.length}`);
    const shared = new Set(machineIds.map(instance => instance.geometry));
    if (shared.size !== 1) throw new Error("Machines must share one geometry resource (instancing)");
    if (!log.at(-1)!.eye.some((value, axis) => value !== log[0]!.eye[axis])) {
      throw new Error("Orbit inspection camera did not move");
    }
  } });
console.log(JSON.stringify(result));
