import { COLUMN_COUNT, createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "08-structure", scene: createScene(),
  frames: 12, stepMs: 60,
  checks: log => {
    const scene = createScene().packet;
    const columns = scene.instances.filter(instance => instance.id.startsWith("column-"));
    if (columns.length !== COLUMN_COUNT) {
      throw new Error(`Expected ${COLUMN_COUNT} columns, got ${columns.length}`);
    }
    const glass = scene.materials.find(material => material.alphaMode === "BLEND");
    if (!glass?.doubleSided) throw new Error("Curtain wall must be BLEND + doubleSided");
    const liftBottom = log[0]!.instanceTransforms["lift"]![1]!;
    const liftTop = Math.max(...log.map(entry => entry.instanceTransforms["lift"]![1]!));
    if (liftTop - liftBottom < 2) throw new Error(`Lift travel too small: ${liftTop - liftBottom}`);
    const highlighted = scene.instances.filter(instance => instance.material === "column-highlight");
    if (highlighted.length !== 1) throw new Error("Exactly one structural member must be highlighted");
  } });
console.log(JSON.stringify(result));
