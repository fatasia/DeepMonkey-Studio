import { createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "06-logistics", scene: createScene(),
  frames: 12, stepMs: 50,
  checks: log => {
    const x0 = log[0]!.instanceTransforms["agv-1"]![0]!;
    const xLast = log.at(-1)!.instanceTransforms["agv-1"]![0]!;
    if (Math.abs(xLast - x0) < 0.3) throw new Error(`AGV lane travel too small: ${xLast - x0}`);
    const rollers = createScene().packet.instances.filter(i => i.id.startsWith("roller-"));
    if (rollers.length !== 8 || new Set(rollers.map(r => r.geometry)).size !== 1) {
      throw new Error("Conveyor rollers must be 8 instances of one shared geometry");
    }
  } });
console.log(JSON.stringify(result));
