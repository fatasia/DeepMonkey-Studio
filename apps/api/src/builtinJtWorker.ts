import { writeJtInspectionArtifacts } from "./jtInspection.js";
import { convertJtLod0ToGlb } from "./jtGlbConverter.js";
import type { BuiltinJtRequest, BuiltinJtResult } from "./builtinJtWorkerProtocol.js";

async function execute(request: BuiltinJtRequest) {
  try {
    if (![request?.sourcePath, request?.outputDir, request?.sourceName].every(value => typeof value === "string" && value.length > 0)) throw new Error("JT worker 请求无效");
    const { inspection, document } = await writeJtInspectionArtifacts(request.sourcePath, request.outputDir);
    const converted = await convertJtLod0ToGlb(document, request.outputDir, request.sourceName, inspection.materials);
    const value: BuiltinJtResult = {
      inspection: { header: { majorVersion: inspection.header.majorVersion, minorVersion: inspection.header.minorVersion },
        toc: { entryCount: inspection.toc.entryCount }, assembly: { nodeCount: inspection.assembly.nodeCount } },
      ...(converted ? {
        result: {
          meshCount: converted.meshCount, instanceCount: converted.instanceCount, triangleCount: converted.triangleCount,
          decodedAttributes: converted.decodedAttributes,
        },
      } : {}),
    };
    reply({ type: "result", value });
  } catch (error) {
    process.exitCode = 1;
    reply({ type: "error", message: error instanceof Error ? error.message.slice(0, 500) : "JT worker 失败" });
  }
}
function reply(message: unknown) {
  if (process.send) process.send(message, () => process.disconnect());
  else process.stdout.write(JSON.stringify(message));
}
if (process.send) process.once("message", execute);
else {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { text += chunk; if (text.length > 16_384) process.exit(2); });
  process.stdin.once("end", () => { void execute(JSON.parse(text) as BuiltinJtRequest); });
}
