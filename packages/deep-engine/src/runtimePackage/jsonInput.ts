import { requireValue } from "./primitives.js";
import { DEEP_RUNTIME_PACKAGE_BUDGETS } from "./types.js";

/** JSON.parse 会覆盖重复键；预扫描保留与 Rust 结构解码一致的拒绝语义。 */
export function parseUniqueRuntimeJson(text: string): unknown {
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index], top = stack[stack.length - 1];
    if (char === "\"") {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === "\"") break;
      }
      if (top?.object && top.key) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        requireValue(!top.keys.has(key), "$", `Duplicate JSON field: ${key}.`);
        top.keys.add(key); top.key = false;
      }
    } else if (char === "{" || char === "[") {
      requireValue(stack.length <= DEEP_RUNTIME_PACKAGE_BUDGETS.depth, "$", "JSON depth budget exceeded.");
      stack.push({ object: char === "{", key: char === "{", keys: new Set() });
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && top?.object) top.key = true;
  }
  return JSON.parse(text);
}
