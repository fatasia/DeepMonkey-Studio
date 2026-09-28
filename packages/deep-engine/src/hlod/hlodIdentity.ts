/**
 * T26 HLOD 内容身份原语:FNV-1a 双种子 64 位内容指纹与确定性比较器。
 * 节点 id = `hlod-` + contentHash64(payload)——子树内容不变 ⇒ id 不变 ⇒
 * 跨版本复用同一对象(增量失效的根基);哈希碰撞由调用方逐字段比对 fail-closed。
 * 跨引擎字符编码/UTF-16 code unit 序差异不在合同内(同 T13 诚实条款)。
 */

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** FNV-1a 32 位;双种子拼接为 64 位十六进制内容指纹。 */
function fnv1a(seed: number, text: string): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul((hash ^ text.charCodeAt(index)) >>> 0, 0x01000193) >>> 0;
  }
  return hash;
}

export function contentHash64(text: string): string {
  return fnv1a(0x811c9dc5, text).toString(16).padStart(8, "0")
    + fnv1a(0x9dc5811c, text).toString(16).padStart(8, "0");
}

/** 胞元几何 → 载荷片段(纳入节点内容哈希:同内容不同胞元 ⇒ 不同身份)。 */
export function cellPayload(cell: { readonly center: readonly number[]; readonly side: number }): string {
  return `${cell.center[0]},${cell.center[1]},${cell.center[2]},${cell.side}`;
}
