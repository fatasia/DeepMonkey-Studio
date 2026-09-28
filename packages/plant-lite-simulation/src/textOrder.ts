/**
 * 跨端稳定的文本序(同族清剿 T23-01):按 UTF-16 码元比较,不读宿主 ICU locale。
 *
 * 背景:`String.prototype.localeCompare` 的结果依赖运行环境的区域设置——
 * 中文/带重音字符的节点与资源 id 在 zh、en、root 等 collation 下顺序可不同,
 * 会破坏 contracts/fingerprint.ts "三端位级一致"的承诺,使指纹与调度顺序跨机漂移。
 * 内核一切排序 tie-break 一律使用本比较器;禁止再引入 localeCompare。
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
