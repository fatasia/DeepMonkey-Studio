export interface ScriptAssistantRequest {
  owner: string;
  controller: AbortController;
}

/** 同一编辑上下文只运行一次；迟到的响应和 finally 不得清除较新的请求。 */
export class ScriptAssistantSession {
  private active: ScriptAssistantRequest | undefined;

  begin(owner: string): ScriptAssistantRequest | undefined {
    if (this.active) return undefined;
    const request = { owner, controller: new AbortController() };
    this.active = request;
    return request;
  }

  isCurrent(request: ScriptAssistantRequest, owner: string): boolean {
    return this.active === request && request.owner === owner && !request.controller.signal.aborted;
  }

  finish(request: ScriptAssistantRequest): boolean {
    if (this.active !== request) return false;
    this.active = undefined;
    return true;
  }

  cancel(): void {
    const active = this.active;
    this.active = undefined;
    active?.controller.abort();
  }
}
