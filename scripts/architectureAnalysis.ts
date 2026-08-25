import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const excludedDirectories = new Set(["dist", "generated", "node_modules"]);

export function typescriptSourceFiles(directory: string, includeTests = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name)
        ? []
        : typescriptSourceFiles(path.join(directory, entry.name), includeTests);
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    if (!includeTests && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))) return [];
    return [path.join(directory, entry.name)];
  });
}

export function moduleSpecifiers(source: string, fileName = "source.ts"): string[] {
  const sourceFile = parseSource(source, fileName);
  const values: string[] = [];
  visit(sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      values.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1
      && ts.isStringLiteralLike(node.arguments[0]!)) {
      values.push(node.arguments[0]!.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      values.push(node.moduleReference.expression.text);
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      values.push(node.argument.literal.text);
    }
  });
  return values;
}

export function isAllowedPurePackageImport(
  specifier: string,
  allowedExternalModules: ReadonlySet<string>
): boolean {
  return specifier.startsWith("./")
    || specifier.startsWith("../")
    || allowedExternalModules.has(specifier);
}

const publicPackageDeepImport = /^@bim-studio\/(?:contracts|server-sdk|studio-core|scene-sdk)\/.+/;

export function isWorkspacePackageSourceDeepImport(
  specifier: string,
  importer: string,
  workspaceRoot: string
): boolean {
  if (publicPackageDeepImport.test(specifier)) return true;
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return false;

  const packagesRoot = path.resolve(workspaceRoot, "packages");
  const target = path.resolve(path.dirname(importer), specifier);
  const targetParts = path.relative(packagesRoot, target).split(path.sep);
  if (targetParts[0] === ".." || targetParts.length < 3 || targetParts[1] !== "src") return false;

  const importerParts = path.relative(packagesRoot, path.resolve(importer)).split(path.sep);
  const importerIsInSamePackageSource = importerParts[0] !== ".."
    && importerParts[0] === targetParts[0]
    && importerParts[1] === "src";
  return !importerIsInSamePackageSource;
}

const rawNetworkCapabilities = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);

export function forbiddenNetworkCapabilities(source: string, fileName = "source.ts"): string[] {
  const sourceFile = parseSource(source, fileName);
  const aliases = new Map<string, string>();
  const hostAliases = new Set(["globalThis", "window", "self"]);

  let changed = true;
  while (changed) {
    changed = false;
    visit(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          changed = recordNetworkAlias(node.name.text, node.initializer, aliases, hostAliases) || changed;
        } else if (ts.isObjectBindingPattern(node.name) && isHostReference(node.initializer, hostAliases)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = element.propertyName ?? element.name;
            if (!ts.isIdentifier(property) && !ts.isStringLiteralLike(property)) continue;
            changed = recordCapabilityAlias(element.name.text, property.text, aliases) || changed;
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(node.left);
        if (ts.isIdentifier(left)) {
          changed = recordNetworkAlias(left.text, node.right, aliases, hostAliases) || changed;
        } else if (ts.isObjectLiteralExpression(left) && isHostReference(node.right, hostAliases)) {
          for (const property of left.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              changed = recordCapabilityAlias(property.name.text, property.name.text, aliases) || changed;
            } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
              const propertyName = propertyNameText(property.name);
              if (propertyName) changed = recordCapabilityAlias(property.initializer.text, propertyName, aliases) || changed;
            }
          }
        }
      }
    });
  }

  const found = new Set<string>();
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
    const capability = networkCapabilityReference(node.expression, aliases, hostAliases);
    if (capability) found.add(capability);
  });
  return [...found].sort();
}

function networkCapabilityReference(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, string>,
  hostAliases: ReadonlySet<string>
): string | undefined {
  expression = unwrapExpression(expression);
  if (ts.isIdentifier(expression)) {
    if (rawNetworkCapabilities.has(expression.text)) return expression.text;
    return aliases.get(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)
    && isHostReference(expression.expression, hostAliases)
    && rawNetworkCapabilities.has(expression.name.text)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)
    && isHostReference(expression.expression, hostAliases)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
    && rawNetworkCapabilities.has(expression.argumentExpression.text)) {
    return expression.argumentExpression.text;
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(expression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind") {
      return networkCapabilityReference(callee.expression, aliases, hostAliases);
    }
    if (ts.isElementAccessExpression(callee)
      && callee.argumentExpression
      && ts.isStringLiteralLike(callee.argumentExpression)
      && callee.argumentExpression.text === "bind") {
      return networkCapabilityReference(callee.expression, aliases, hostAliases);
    }
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "bind") {
    return networkCapabilityReference(expression.expression, aliases, hostAliases);
  }
  if (ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
    && expression.argumentExpression.text === "bind") {
    return networkCapabilityReference(expression.expression, aliases, hostAliases);
  }
  return undefined;
}

function recordNetworkAlias(
  name: string,
  initializer: ts.Expression,
  aliases: Map<string, string>,
  hostAliases: Set<string>
): boolean {
  let changed = false;
  if (isHostReference(initializer, hostAliases) && !hostAliases.has(name)) {
    hostAliases.add(name);
    changed = true;
  }
  const capability = networkCapabilityReference(initializer, aliases, hostAliases);
  if (capability && !aliases.has(name)) {
    aliases.set(name, capability);
    changed = true;
  }
  return changed;
}

function recordCapabilityAlias(name: string, capability: string, aliases: Map<string, string>): boolean {
  if (!rawNetworkCapabilities.has(capability) || aliases.get(name) === capability) return false;
  aliases.set(name, capability);
  return true;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function isHostReference(expression: ts.Expression, hostAliases: ReadonlySet<string>): boolean {
  return ts.isIdentifier(expression) && hostAliases.has(expression.text);
}

export function containsIdentifier(source: string, identifier: string, fileName = "source.ts"): boolean {
  let found = false;
  visit(parseSource(source, fileName), (node) => {
    if (ts.isIdentifier(node) && node.text === identifier) found = true;
  });
  return found;
}

export function hasDomHostReference(source: string, fileName = "source.ts"): boolean {
  const domMembers = new Set(["body", "cookie", "createElement", "getElementById", "querySelector", "querySelectorAll"]);
  let found = false;
  visit(parseSource(source, fileName), (node) => {
    if (ts.isIdentifier(node) && node.text === "window") found = true;
    if (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "document"
      && domMembers.has(node.name.text)) {
      found = true;
    }
    if (ts.isPropertyAccessExpression(node)
      && node.name.text === "document"
      && ts.isIdentifier(node.expression)
      && node.expression.text === "globalThis") {
      found = true;
    }
  });
  return found;
}

export function workspaceDependencyCycles(workspaceRoot: string): string[][] {
  const manifests = ["apps", "packages"].flatMap((group) => {
    const groupDirectory = path.join(workspaceRoot, group);
    return readdirSync(groupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(groupDirectory, entry.name, "package.json"));
  });
  const packages = new Map<string, Record<string, unknown>>();
  for (const manifest of manifests) {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    if (typeof value.name === "string") packages.set(value.name, value);
  }
  const graph = new Map<string, string[]>();
  for (const [name, manifest] of packages) {
    const dependencyNames = ["dependencies", "optionalDependencies", "peerDependencies"]
      .flatMap((key) => Object.keys(asRecord(manifest[key])))
      .filter((dependency) => packages.has(dependency))
      .sort();
    graph.set(name, [...new Set(dependencyNames)]);
  }
  return findDependencyCycles(graph);
}

export function findDependencyCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visitNode = (node: string): void => {
    if (state.get(node) === "visited") return;
    if (state.get(node) === "visiting") {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const canonical = canonicalCycle(cycle);
      cycles.set(canonical.join(" -> "), canonical);
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) visitNode(dependency);
    stack.pop();
    state.set(node, "visited");
  };

  for (const node of [...graph.keys()].sort()) visitNode(node);
  return [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function canonicalCycle(cycle: string[]): string[] {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_value, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  const selected = rotations[0] ?? [];
  return [...selected, selected[0]!];
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function visit(root: ts.Node, inspect: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    inspect(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
