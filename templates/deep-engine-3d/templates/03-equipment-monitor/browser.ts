import { createScene } from "./scene";
import { runTemplateBrowser } from "../../harness";

await runTemplateBrowser({ template: "03-equipment-monitor", scene: createScene() });
