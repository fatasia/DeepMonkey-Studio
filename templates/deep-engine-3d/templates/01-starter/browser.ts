import { createScene } from "./scene";
import { runTemplateBrowser } from "../../harness";

await runTemplateBrowser({ template: "01-starter", scene: createScene() });
