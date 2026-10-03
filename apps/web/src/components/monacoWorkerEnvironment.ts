// 必须先于任何 monaco-editor 模块求值。两类 worker 都直接指向 Monaco 源文件，
// TS 语言服务的 worker 与 Monaco 内部 `new URL('ts.worker.js')` 解析到同一入口，产物只保留一份。
const monacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === "javascript" || label === "typescript") {
      return new Worker(new URL("../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module", name: label });
    }
    return new Worker(new URL("../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module", name: label });
  },
};

(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment ??= monacoEnvironment;
