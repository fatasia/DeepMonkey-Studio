import ts from "typescript";

const isThreeModule = (name) => name === "three" || name.startsWith("three/");

/** 仅盘点静态源码证据；无法解析的命名空间逃逸必须显式留待运行时语料验证。 */
export function scanThreeUsage(sources) {
  const options = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve };
  const files = new Map(sources.map(({ file, code }) => [file, ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)]));
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => files.get(file);
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const usages = [];
  const unresolved = [];
  const imports = [];

  for (const source of files.values()) {
    const bindings = new Map();
    const bindingNames = new Set();
    const location = (node) => ({ file: source.fileName, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    const unresolvedAt = (node, kind) => unresolved.push({ ...location(node), kind });
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (!isThreeModule(module)) continue;
      const clause = statement.importClause;
      const add = (name, imported, typeOnly) => {
        const entry = { module, imported, typeOnly, ...location(name) };
        bindingNames.add(name.text);
        imports.push(entry);
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol) bindings.set(symbol, entry);
      };
      if (!clause) { unresolvedAt(statement, "side-effect-import"); continue; }
      if (clause.name) { add(clause.name, "default", clause.isTypeOnly); unresolvedAt(clause.name, "default-import"); }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        add(clause.namedBindings.name, "*", clause.isTypeOnly);
      } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          add(element.name, (element.propertyName ?? element.name).text, clause.isTypeOnly || element.isTypeOnly);
        }
      }
    }

    function isTypeUse(node) {
      for (let current = node.parent; current && current !== source; current = current.parent) {
        if (ts.isTypeNode(current)) return true;
        if (ts.isStatement(current)) break;
      }
      return false;
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        && isThreeModule(node.moduleSpecifier.text)) unresolvedAt(node, "re-export");
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && isThreeModule(argument.text)) unresolvedAt(node, "dynamic-import");
      }
      if (ts.isIdentifier(node) && bindingNames.has(node.text)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const binding = bindings.get(checker.getSymbolAtLocation(node));
        if (binding) {
          let symbol = binding.imported;
          const parent = node.parent;
          if (symbol === "*") {
            if (ts.isPropertyAccessExpression(parent) && parent.expression === node) symbol = parent.name.text;
            else if (ts.isQualifiedName(parent) && parent.left === node) symbol = parent.right.text;
            else if (ts.isElementAccessExpression(parent) && parent.expression === node
              && ts.isStringLiteral(parent.argumentExpression)) symbol = parent.argumentExpression.text;
            else { unresolvedAt(node, "namespace-escape-or-dynamic-access"); symbol = undefined; }
          }
          if (symbol) usages.push({ module: binding.module, symbol, kind: binding.typeOnly || isTypeUse(node) ? "type" : "value", ...location(node) });
        }
      }
      // 嵌入脚本不能当普通 import 使用计数；记录其位置，后续单独采集和回放。
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && /\b(?:THREE|studio|engine)\s*(?:\.|\[)/.test(node.getText(source))) {
        unresolvedAt(node, "embedded-script-candidate");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const diagnostic of source.parseDiagnostics) {
      unresolved.push({ file: source.fileName, line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, kind: "parse-error" });
    }
  }
  return { imports, usages, unresolved };
}
