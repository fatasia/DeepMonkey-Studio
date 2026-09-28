/**
 * 跨端稳定的文本序(localeCompare 同族清剿 2026-09-28):按 UTF-16 码元比较,
 * 不读宿主 ICU locale。行为 = JS 规范 `<`/`>` 字符串比较。
 *
 * 本包不依赖 @bim-studio/contracts,故持有与规范实现
 * packages/contracts/src/textOrder.ts 同语义的本地镜像。文档目录等列序
 * tie-break 一律使用本比较器;禁止再引入 localeCompare。
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
