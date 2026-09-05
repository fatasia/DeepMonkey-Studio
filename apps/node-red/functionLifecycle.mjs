const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Node-RED 5 的消息/初始化可异步，On Stop 被包装为普通函数。这里只编译，不执行用户脚本。 */
export function validateFunctionLifecycle(node) {
  if (node.type !== "function") return;
  for (const [stage, Compiler] of [["func", AsyncFunction], ["initialize", AsyncFunction], ["finalize", Function]]) {
    try {
      new Compiler("msg", "context", "global", "env", "node", "Buffer", node[stage] ?? "");
    } catch (error) {
      throw new SyntaxError(`Function ${node.id} (${stage}): ${error.message}`, { cause: error });
    }
  }
}
