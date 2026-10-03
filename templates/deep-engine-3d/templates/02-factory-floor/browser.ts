import { createScene } from "./scene";
import { runTemplateBrowser } from "../../harness";

await runTemplateBrowser({ template: "02-factory-floor", scene: createScene() });
