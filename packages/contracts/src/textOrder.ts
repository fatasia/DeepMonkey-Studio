/**
 * 跨端稳定的文本序(localeCompare 同族清剿 2026-09-28):按 UTF-16 码元比较,
 * 不读宿主 ICU locale。行为 = JS 规范 `<`/`>` 字符串比较(规范 7.2.13)。
 *
 * 背景:`String.prototype.localeCompare` 的结果依赖运行环境的区域设置——
 * 中文/带重音字符的节点与资源 id 在 zh、en、root 等 collation 下顺序可不同,
 * 会破坏 contracts/fingerprint.ts "三端位级一致"的承诺,使 golden 指纹、
 * 持久化清单、运行包编译产物与跨端对照证据跨机漂移。
 *
 * 规范实现即本文件。各独立包持有同语义本地镜像(不允许 contracts 反向依赖):
 * - packages/plant-lite-simulation/src/textOrder.ts(T23 先行版)
 * - packages/deep-engine/src/textOrder.ts
 * - packages/plugin-runtime/src/textOrder.ts
 * - packages/factory-flow-plugin/src/textOrder.ts
 * - packages/docs-runtime/src/textOrder.ts
 * - packages/deep-engine/src/hlod/hlodIdentity.ts 内同名实现(历史先例,同为码元序)
 * 任何一处改动语义必须全量同步;一切进入 golden/持久化/编译/跨端对照/仿真
 * 状态演进的排序 tie-break 一律使用本比较器,禁止再引入 localeCompare。
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
