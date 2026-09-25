import type { AppliedEngineEditCommand, EngineEditCommand, EngineEditCommandInput } from "./engineEditCommand";

export type { AppliedEngineEditCommand } from "./engineEditCommand";

/** 命令执行器;由发布方提供(批 0 形态:接线点绑定 engine,见 engineCommandApplier)。 */
export interface EngineEditCommandApplier {
  apply(command: EngineEditCommand): void;
}

/** 订阅事件:命令应用完成后发出,revision 为该命令的文档序位(1 起)。 */
export interface CommandBusEvent {
  readonly command: EngineEditCommand;
  readonly revision: number;
}

export type CommandBusListener = (event: CommandBusEvent) => void;

export interface CommandBusOptions {
  /** 内存命令日志上限(环形裁剪最旧);默认 1000。 */
  readonly logLimit?: number;
}

/**
 * 引擎中立编辑命令总线(设计文档 docs/specs/engine-neutral-command-layer-design-2026-09-25.md 批 0)。
 *
 * 零行为变化约束:publish 同步冲刷队列(发布返回时命令已执行完毕),
 * 与"UI 直调引擎 setter"的时序逐点一致;异步合帧是后续批次(§4)的事,批 0 不做。
 * revision 单调递增(undo/redo 后仍递增),错误路径:applier 抛错时错误原样传播、
 * 命令不入日志、revision 不增、队列清空——与直调 setter 抛错的可见行为一致。
 */
export class CommandBus {
  private revision = 0;
  private seq = 0;
  private readonly logLimit: number;
  private readonly log: AppliedEngineEditCommand[] = [];
  private readonly queue: Array<{ command: EngineEditCommand; applier: EngineEditCommandApplier }> = [];
  private readonly listeners = new Set<CommandBusListener>();
  private flushing = false;

  constructor(options: CommandBusOptions = {}) {
    this.logLimit = options.logLimit ?? 1000;
  }

  /** 当前文档 revision(成功应用一条命令 +1)。 */
  getRevision(): number {
    return this.revision;
  }

  /**
   * 发布命令:分配 id 与 baseRevision,入队并同步冲刷。返回带身份的命令。
   * applier 抛错时错误向调用方传播(与直调等价),队列中未执行命令被清空。
   */
  publish(input: EngineEditCommandInput, applier: EngineEditCommandApplier): EngineEditCommand {
    const command = {
      ...input,
      id: `editcmd-${++this.seq}`,
      baseRevision: this.revision,
    } as EngineEditCommand;
    this.queue.push({ command, applier });
    this.flush();
    return command;
  }

  /** 订阅应用后事件;返回退订函数,重复退订安全。 */
  subscribe(listener: CommandBusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 应用后的命令日志(旧→新,环形裁剪)。 */
  getLog(): readonly AppliedEngineEditCommand[] {
    return [...this.log];
  }

  /**
   * 将日志重放给指定 applier(引擎重建/增量消费者恢复投影用)。
   * 重放不是新编辑:不推进 revision、不写日志、不通知订阅者。返回重放条数。
   */
  replay(applier: EngineEditCommandApplier): number {
    let count = 0;
    for (const entry of this.log) {
      applier.apply(entry.command);
      count += 1;
    }
    return count;
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        item.applier.apply(item.command);
        this.revision += 1;
        this.appendLog({ command: item.command, revision: this.revision });
      }
    } finally {
      // applier 抛错时:丢弃队列剩余命令并交还冲刷权;错误沿 publish 调用栈传播。
      this.queue.length = 0;
      this.flushing = false;
    }
  }

  private appendLog(entry: AppliedEngineEditCommand): void {
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    this.emit(entry);
  }

  private emit(entry: AppliedEngineEditCommand): void {
    for (const listener of this.listeners) {
      try {
        listener({ command: entry.command, revision: entry.revision });
      } catch (error) {
        console.error("[CommandBus] 订阅者处理命令事件失败", error);
      }
    }
  }
}

/** 应用内共享总线:单会话单总线;测试用例自行 new CommandBus,不污染共享实例。 */
export const sceneCommandBus = new CommandBus();
