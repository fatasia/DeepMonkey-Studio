import { createHash } from "node:crypto";
import ts from "typescript";

const SHADER_FILE = /\.(?:wgsl|glsl|vert|frag)$/i;
const SHADER_IMPORT = /(?:\?|!|^|\/)[^'"?]*(?:wgsl|glsl|vert|frag)(?:\?|$)/i;
const THREE_SHADER_TYPES = new Set(["ShaderMaterial", "RawShaderMaterial", "NodeMaterial"]);
const SHADER_PROPERTIES = new Map([
  ["onBeforeCompile", "compile-hook"],
  ["customProgramCacheKey", "program-cache-hook"],
  ["vertexShader", "vertex-source-property"],
  ["fragmentShader", "fragment-source-property"],
  ["customDepthMaterial", "custom-depth-material"],
  ["customDistanceMaterial", "custom-distance-material"],
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}${node.templateSpans.map((span) => `${span.literal.text}\${}`).join("")}`;
  }
  return undefined;
}

function classifyShaderSource(value) {
  if (/\b@(?:vertex|fragment|compute)\b|\bfn\s+\w+\s*\(/.test(value)) return "embedded-wgsl";
  if (/\bgl_Position\b|\bvoid\s+main\s*\(|#\s*(?:version|include|pragma)\b/.test(value)) return "embedded-glsl-hlsl";
  return undefined;
}

/** Static source inventory only. Runtime-created shader strings remain explicit unresolved evidence. */
export function scanShaderUsage(sources) {
  const evidence = [];
  const unresolved = [];
  for (const source of [...sources].sort((a, b) => a.file.localeCompare(b.file, "en"))) {
    const location = (file, node) => ({ file, line: file === source.file
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 : 1 });
    if (SHADER_FILE.test(source.file)) {
      evidence.push({ file: source.file, line: 1, kind: "standalone-shader", symbol: source.file.split("/").at(-1),
        sourceHash: digest(source.code), sourceBytes: Buffer.byteLength(source.code) });
      continue;
    }
    const sourceFile = ts.createSourceFile(source.file, source.code, ts.ScriptTarget.Latest, true,
      source.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const bindings = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (SHADER_IMPORT.test(module)) evidence.push({ ...location(source.file, statement), kind: "shader-file-import", symbol: module });
      const clause = statement.importClause;
      if (!clause || !(module === "three" || module.startsWith("three/"))) continue;
      if (clause.name) bindings.set(clause.name.text, { module, imported: "default" });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.set(clause.namedBindings.name.text, { module, imported: "*" });
        if (module === "three/tsl") {
          evidence.push({ ...location(source.file, clause.namedBindings.name), kind: "three-tsl-namespace-import", symbol: "*" });
        }
      } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          bindings.set(element.name.text, { module, imported });
          if (module === "three/tsl") evidence.push({ ...location(source.file, element), kind: "three-tsl-import", symbol: imported });
          else if (THREE_SHADER_TYPES.has(imported) || imported.endsWith("NodeMaterial")) {
            evidence.push({ ...location(source.file, element), kind: "three-shader-type-import", symbol: imported });
          }
        }
      }
    }
    const recordSource = (node, value) => {
      const kind = classifyShaderSource(value);
      if (kind) evidence.push({ ...location(source.file, node), kind, symbol: "literal",
        sourceHash: digest(value), sourceBytes: Buffer.byteLength(value) });
    };
    function visit(node) {
      if (ts.isPropertyAccessExpression(node)) {
        const kind = SHADER_PROPERTIES.get(node.name.text);
        if (kind) evidence.push({ ...location(source.file, node.name), kind, symbol: node.name.text });
      }
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
        const kind = name ? SHADER_PROPERTIES.get(name) : undefined;
        if (kind) evidence.push({ ...location(source.file, node.name), kind, symbol: name });
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const binding = bindings.get(node.expression.text);
        if (binding && (THREE_SHADER_TYPES.has(binding.imported) || binding.imported.endsWith("NodeMaterial"))) {
          evidence.push({ ...location(source.file, node), kind: "three-shader-constructor", symbol: binding.imported });
        }
      }
      if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)) {
        const binding = bindings.get(node.expression.expression.text), symbol = node.expression.name.text;
        if (binding?.imported === "*" && (THREE_SHADER_TYPES.has(symbol) || symbol.endsWith("NodeMaterial"))) {
          evidence.push({ ...location(source.file, node), kind: "three-shader-constructor", symbol });
        }
      }
      if (ts.isNewExpression(node) && ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && ts.isStringLiteral(node.expression.argumentExpression)) {
        const binding = bindings.get(node.expression.expression.text), symbol = node.expression.argumentExpression.text;
        if (binding?.imported === "*" && (THREE_SHADER_TYPES.has(symbol) || symbol.endsWith("NodeMaterial"))) {
          evidence.push({ ...location(source.file, node), kind: "three-shader-constructor", symbol });
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const value = literalText(node);
        if (value !== undefined) recordSource(node, value);
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
        && bindings.get(node.expression.text)?.imported === "*" && !ts.isStringLiteral(node.argumentExpression)) {
        unresolved.push({ ...location(source.file, node), kind: "dynamic-three-shader-access" });
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && (argument.text === "three/tsl" || SHADER_IMPORT.test(argument.text))) {
          unresolved.push({ ...location(source.file, node), kind: "dynamic-shader-import" });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    for (const diagnostic of sourceFile.parseDiagnostics) {
      unresolved.push({ file: source.file,
        line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, kind: "parse-error" });
    }
  }
  const compare = (a, b) => a.file.localeCompare(b.file, "en") || a.line - b.line
    || a.kind.localeCompare(b.kind, "en") || (a.symbol ?? "").localeCompare(b.symbol ?? "", "en");
  return { evidence: evidence.sort(compare), unresolved: unresolved.sort(compare) };
}
