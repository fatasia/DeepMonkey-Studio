import type { AgentCheckpoint, AgentCheckpointStore } from "./types.js";

/** 单进程测试和嵌入式运行使用；服务端生产适配器会替换为可恢复持久化存储。 */
export class MemoryAgentCheckpointStore implements AgentCheckpointStore {
  readonly #records = new Map<string, AgentCheckpoint>();

  async get(id: string): Promise<AgentCheckpoint | undefined> {
    const checkpoint = this.#records.get(id);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    this.#records.set(checkpoint.id, structuredClone(checkpoint));
  }
}
