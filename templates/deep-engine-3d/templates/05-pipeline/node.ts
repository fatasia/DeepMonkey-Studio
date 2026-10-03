import { createScene, markerTransforms, pathPoint } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "05-pipeline", scene: createScene(),
  frames: 10, stepMs: 40,
  checks: log => {
    const first = log[0]!, last = log.at(-1)!;
    const id = "flow-0";
    const a = first.instanceTransforms[id]!, b = last.instanceTransforms[id]!;
    const travel = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
    if (travel <= 0.05) throw new Error(`Flow marker did not travel: ${travel}`);
    if (travel > 40 * 0.4 * 2) throw new Error(`Flow marker teleported: ${travel}`);
    const blend = createScene().packet.materials.find(material => material.alphaMode === "BLEND");
    if (!blend?.doubleSided) throw new Error("Observation window must be BLEND + doubleSided");
    const s = 120 * 0.001 * 2.4;
    const [px, , pz] = pathPoint(s);
    if (Math.hypot(px - markerTransforms(120)[0]!.transform[12]!,
      pz - markerTransforms(120)[0]!.transform[14]!) > 1e-6) {
      throw new Error("Marker transform diverged from pathPoint");
    }
  } });
console.log(JSON.stringify(result));
