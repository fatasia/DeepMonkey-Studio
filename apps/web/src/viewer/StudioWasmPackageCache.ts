// 上限对齐运行包输入预算(256 MiB,与 Native MAX_INPUT_BYTES 同源):
// 159.9 MB 的真实 SMT 产线包此前被 64 MiB 上限排除,每次自动保存后都重走
// 完整 Worker 编译 + 5 秒级主线程 set;扩容后 refresh 走 O(1) 引用复用。
const MAX_CACHED_PACKAGE_BYTES = 256 * 1024 * 1024;

/** Keeps one immutable CPU package. Equality is exact, never a hash-only gate. */
export class StudioWasmPackageCache {
  private bytes: Uint8Array | undefined;

  matches(bytes: Uint8Array): boolean {
    const previous = this.bytes;
    if (!previous || previous.byteLength !== bytes.byteLength) return false;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (previous[index] !== bytes[index]) return false;
    }
    return true;
  }

  /** detached 快照合同:缓存与调用方字节隔离,调用方后续改写不穿透。 */
  commit(bytes: Uint8Array): void {
    this.bytes = bytes.byteLength <= MAX_CACHED_PACKAGE_BYTES ? bytes.slice() : undefined;
  }

  clear(): void { this.bytes = undefined; }
}
