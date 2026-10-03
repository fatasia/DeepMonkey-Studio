import { beaconStrength, createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "07-energy", scene: createScene(),
  frames: 24, stepMs: 100,
  checks: log => {
    const strengths = log.map(entry => entry.emissiveStrengths["beacon-red"]!);
    if (Math.max(...strengths) - Math.min(...strengths) < 2.5) {
      throw new Error("Beacon pulse amplitude too small");
    }
    const scene = createScene().packet;
    const caps = scene.instances.filter(instance => instance.id.endsWith("-cap"));
    if (caps.length !== 2) throw new Error("Two tank caps expected");
    const statics = log.at(-1)!.instanceTransforms["tank-a-shell"]!;
    if (statics[1]! !== log[0]!.instanceTransforms["tank-a-shell"]![1]!) {
      throw new Error("Tanks are static and must not move");
    }
  } });
console.log(JSON.stringify(result));
