interface WeightedValue<V> {
  readonly value: V;
  readonly bytes: number;
}

export interface LruEviction<K, V> {
  readonly key: K;
  readonly value: V;
}

export class BoundedLru<K, V> {
  private readonly values = new Map<K, WeightedValue<V>>();
  private totalBytes = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 65_536) {
      throw new RangeError("LRU maxEntries must be an integer from 1 through 65536.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_073_741_824) {
      throw new RangeError("LRU maxBytes must be an integer from 1 through 1073741824.");
    }
  }

  get size(): number { return this.values.size; }
  get bytes(): number { return this.totalBytes; }

  get(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean { return this.values.has(key); }

  set(key: K, value: V, bytes = 1): readonly LruEviction<K, V>[] {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError("LRU entry bytes must be positive.");
    const previous = this.values.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.values.delete(key);
    }
    if (bytes > this.maxBytes) return previous ? [{ key, value: previous.value }] : [];
    this.values.set(key, { value, bytes });
    this.totalBytes += bytes;
    const evicted: LruEviction<K, V>[] = [];
    while (this.values.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const first = this.values.entries().next().value as [K, WeightedValue<V>] | undefined;
      if (!first) break;
      this.values.delete(first[0]);
      this.totalBytes -= first[1].bytes;
      evicted.push({ key: first[0], value: first[1].value });
    }
    return evicted;
  }

  delete(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.totalBytes -= entry.bytes;
    return entry.value;
  }

  clear(): readonly V[] {
    const entries = [...this.values.values()].map((entry) => entry.value);
    this.values.clear();
    this.totalBytes = 0;
    return entries;
  }
}
