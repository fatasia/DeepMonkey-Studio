import { createScene } from "./scene.js";
import { runTemplateNode } from "../../nodeHarness.js";

const result = await runTemplateNode({ template: "01-starter", scene: createScene(),
  checks: log => {
    const first = log[0]!, last = log.at(-1)!;
    if (first.instanceTransforms["crate"]![1] === last.instanceTransforms["crate"]![1]) {
      throw new Error("starter crate bob animation did not move");
    }
  } });
console.log(JSON.stringify(result));
