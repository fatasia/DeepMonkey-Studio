import { createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "03-equipment-monitor", scene: createScene(),
  frames: 24, stepMs: 100,
  checks: log => {
    const strengths = log.map(entry => entry.emissiveStrengths["status-alarm"]!);
    const amplitude = Math.max(...strengths) - Math.min(...strengths);
    if (amplitude < 2) throw new Error(`Alarm breathing amplitude too small: ${amplitude}`);
    const scene = createScene().packet;
    const halo = scene.instances.filter(instance => instance.id.endsWith("select-band"));
    if (halo.length !== 1 || !halo[0]!.id.startsWith("cnc-03")) {
      throw new Error("Exactly the alarmed cabinet must carry the selection halo band");
    }
    if (!scene.materials.some(material => material.shadingModel === "unlit")) {
      throw new Error("HMI panels must use the unlit shading model");
    }
  } });
console.log(JSON.stringify(result));
