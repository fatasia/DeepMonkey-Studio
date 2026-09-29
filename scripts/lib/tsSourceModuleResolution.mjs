/**
 * scripts 域 node:test 加载 TS 源的解析 hook(自注册,.js→.ts 回退)。
 *
 * == 为什么需要 ==
 * 仓库 TS 源(NodeNext 风格)相互导入用 `.js` 后缀 specifier(如
 * deep-engine rendererCapabilitySelfCheck.ts → "../shadows/contactShadowQuality.js")。
 * Node ≥24 的默认 type-stripping 能加载 `.ts` 文件本身,但**不做** `.js`→`.ts`
 * specifier 映射,纯 `node --test` 加载该导入闭包会 ERR_MODULE_NOT_FOUND。
 * 本 hook 只在原解析失败且 `.js` 的 `.ts` 兄弟文件存在时回退,其余错误原样抛出,
 * 不会掩盖真实的缺文件。
 *
 * == 用法 ==
 * 在测试文件把本模块作为**第一个** import(hook 注册后对其后的动态 import 生效):
 *   import "../lib/tsSourceModuleResolution.mjs";
 * 要求 Node ≥24(仓库 engines 基线;type-stripping 默认开启)。
 *
 * 自注册守卫:register() 的 hook 运行在独立 worker 线程,isMainThread=false 时不
 * 再注册,避免 hook 模块在 hook 线程内自引用导致的无界线程繁殖。
 */
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  register("./tsSourceModuleResolution.mjs", import.meta.url);
}

/** @type {import("node:module").ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
