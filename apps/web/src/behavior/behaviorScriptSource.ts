/** Stable across runs; encode IDs so whitespace cannot corrupt the sourceURL directive. */
export function behaviorScriptSource(module: { id: string; code: string }) {
  const moduleSyntax = /\b(?:import|export)\s/.test(module.code);
  return {
    url: `industrial-studio-behavior-${encodeURIComponent(module.id)}.${moduleSyntax ? "mjs" : "js"}`,
    lineOffset: moduleSyntax ? 2 : 3,
  };
}
