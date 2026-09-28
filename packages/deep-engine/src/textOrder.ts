/**
 * 跨端稳定的文本序(localeCompare 同族清剿 2026-09-28):按 UTF-16 码元比较,
 * 不读宿主 ICU locale。行为 = JS 规范 `<`/`>` 字符串比较。
 *
 * 本包不依赖 @bim-studio/contracts,故持有与规范实现
 * packages/contracts/src/textOrder.ts(T23 的 plant-lite 版为同一语义)逐字节
 * 同语义的本地镜像。一切进入 golden 指纹/持久化状态/运行包编译/着色器与资源
 * 调度的排序 tie-break 一律使用本比较器;禁止再引入 localeCompare。
 *
 * 注:hlod/hlodIdentity.ts 内已有历史同名实现(同为码元序,先于本文件存在),
 * 保持不动;新增代码一律 import 本文件。
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
