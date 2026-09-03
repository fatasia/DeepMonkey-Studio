import type { SimulationEvent } from "./runtimeTypes.js";

/** 以时间和创建序号稳定排序的最小堆，避免长仿真反复 sort/shift。 */
export class SimulationEventQueue {
  readonly #heap: SimulationEvent[] = [];

  get size(): number {
    return this.#heap.length;
  }

  peek(): SimulationEvent | undefined {
    return this.#heap[0];
  }

  push(event: SimulationEvent): void {
    this.#heap.push(event);
    this.#bubbleUp(this.#heap.length - 1);
  }

  pop(): SimulationEvent | undefined {
    const first = this.#heap[0];
    const last = this.#heap.pop();
    if (!first || !last || this.#heap.length === 0) return first;
    this.#heap[0] = last;
    this.#sinkDown(0);
    return first;
  }

  #bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(this.#heap[parent]!, this.#heap[index]!) <= 0) return;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index]!, this.#heap[parent]!];
      index = parent;
    }
  }

  #sinkDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#heap.length && compare(this.#heap[left]!, this.#heap[smallest]!) < 0) smallest = left;
      if (right < this.#heap.length && compare(this.#heap[right]!, this.#heap[smallest]!) < 0) smallest = right;
      if (smallest === index) return;
      [this.#heap[index], this.#heap[smallest]] = [this.#heap[smallest]!, this.#heap[index]!];
      index = smallest;
    }
  }
}

function compare(left: SimulationEvent, right: SimulationEvent): number {
  return left.at - right.at || left.sequence - right.sequence;
}
