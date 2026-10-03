import { createScene } from "./scene";
import { runTemplateBrowser } from "../../harness";

await runTemplateBrowser({ template: "06-logistics", scene: createScene() });
