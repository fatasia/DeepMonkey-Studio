import { createScene } from "./scene";
import { runTemplateBrowser } from "../../harness";

await runTemplateBrowser({ template: "07-energy", scene: createScene() });
