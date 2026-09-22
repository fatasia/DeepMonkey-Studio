import { convertSolidworksPreview } from "./solidworksPreviewConversion.js";

let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  text += chunk;
  if (Buffer.byteLength(text) > 16384) process.exit(2);
});
process.stdin.once("end", () => {
  void (async () => {
    try { process.stdout.write(JSON.stringify(await convertSolidworksPreview(JSON.parse(text)))); }
    catch (error) { process.stdout.write(JSON.stringify({ status: "error", message: error instanceof Error ? error.message.slice(0, 1000) : "SolidWorks Worker 失败" })); }
  })();
});
