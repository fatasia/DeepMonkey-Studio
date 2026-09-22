import type { ShaderDiagnostic } from "../shader/types.js";

export interface ShaderGraphEditorDiagnostic extends Omit<ShaderDiagnostic, "code" | "severity"> {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly provider: "schema" | "graph" | "lowering" | "wgsl" | "preview" | "runtime";
  readonly nodeId?: string;
  readonly portId?: string;
  readonly edgeId?: string;
}

/** 增量式编辑器诊断存储；编译器报告保持不可变。 */
export class ShaderGraphMessageStore {
  private readonly providers = new Map<string, readonly ShaderGraphEditorDiagnostic[]>();

  replace(provider: string, diagnostics: readonly ShaderGraphEditorDiagnostic[]): void {
    this.providers.set(provider, Object.freeze([...diagnostics]));
  }
  clear(provider: string): void { this.providers.delete(provider); }
  clearNode(nodeId: string): void {
    for (const [provider, diagnostics] of this.providers) {
      const kept = diagnostics.filter(diagnostic => diagnostic.nodeId !== nodeId);
      if (kept.length === diagnostics.length) continue;
      if (kept.length) this.providers.set(provider, Object.freeze(kept));
      else this.providers.delete(provider);
    }
  }
  all(): readonly ShaderGraphEditorDiagnostic[] {
    return Object.freeze([...this.providers.values()].flat());
  }
  forNode(nodeId: string): readonly ShaderGraphEditorDiagnostic[] {
    return Object.freeze(this.all().filter(diagnostic => diagnostic.nodeId === nodeId));
  }
}
