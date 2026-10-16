import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface ManifestEntry {
  app: string;
  routes: string[];
  title: string;
  smoke: boolean;
}

export type Manifest = Record<string, ManifestEntry>;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compare(left.name, right.name))
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        return sourceFiles(filename);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [filename] : [];
    });
}

function unwrap(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function initializerFor(node: ts.Node, checker: ts.TypeChecker): ts.Expression | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const
  ) {
    return declaration.initializer;
  }
  if (declaration && ts.isPropertyAssignment(declaration)) {
    return declaration.initializer;
  }
  return undefined;
}

// Resolve syntax, not runtime values: factory calls and other dynamic expressions
// retain their names as ${...} placeholders rather than executing test modules.
function routeValue(node: ts.Node, checker: ts.TypeChecker, resolving = new Set<ts.Node>()): string {
  node = unwrap(node);
  const current = node;
  const unresolved = (): string => `\${${current.getText().replace(/\s+/g, ' ').trim()}}`;
  if (resolving.has(node)) return unresolved();
  const next = new Set(resolving).add(node);

  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => routeValue(span.expression, checker, next) + span.literal.text).join('')
    );
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // Numeric addition is not string concatenation. Keep it symbolic rather
    // than inventing an id (for example, `${1 + 2}` must not become "12").
    if (checker.getTypeAtLocation(node).flags & ts.TypeFlags.NumberLike) {
      return unresolved();
    }
    return routeValue(node.left, checker, next) + routeValue(node.right, checker, next);
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const initializer = initializerFor(node, checker);
    if (initializer) return routeValue(initializer, checker, next);
  }
  if (ts.isElementAccessExpression(node)) {
    const target = unwrap(node.expression);
    const initializer = ts.isIdentifier(target) ? initializerFor(target, checker) : target;
    const key = unwrap(node.argumentExpression);
    if (initializer && ts.isStringLiteralLike(key)) {
      const object = unwrap(initializer);
      if (ts.isObjectLiteralExpression(object)) {
        const property = object.properties.find(
          (member): member is ts.PropertyAssignment =>
            ts.isPropertyAssignment(member) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
            member.name.text === key.text
        );
        if (property) return routeValue(property.initializer, checker, next);
      }
    }
  }
  return unresolved();
}

function testCallKind(expression: ts.Expression): 'test' | 'describe' | undefined {
  const names: string[] = [];
  while (ts.isPropertyAccessExpression(expression)) {
    names.unshift(expression.name.text);
    expression = expression.expression;
  }
  if (!ts.isIdentifier(expression) || expression.text !== 'test') return undefined;
  if (names.length === 0) return 'test';
  if (
    names[0] === 'describe' &&
    (names.length === 1 ||
      (names.length === 2 && ['only', 'skip', 'fixme', 'serial', 'parallel'].includes(names[1]!)) ||
      (names.length === 3 && ['serial', 'parallel'].includes(names[1]!) && ['only', 'skip'].includes(names[2]!)))
  ) {
    return 'describe';
  }
  return names.length === 1 && ['only', 'skip', 'fixme', 'fail'].includes(names[0]!) ? 'test' : undefined;
}

function containsSmoke(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): boolean {
  node = unwrap(node);
  if (seen.has(node)) return false;
  seen.add(node);
  if (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  ) {
    return /(^|\s)@smoke($|\s)/.test(routeValue(node, checker));
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const initializer = initializerFor(node, checker);
    return initializer ? containsSmoke(initializer, checker, seen) : false;
  }
  if (ts.isConditionalExpression(node)) {
    return containsSmoke(node.whenTrue, checker, seen) || containsSmoke(node.whenFalse, checker, seen);
  }
  return ts.isArrayLiteralExpression(node) && node.elements.some((element) => containsSmoke(element, checker, seen));
}

function hasSmokeDetails(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Node>()): boolean {
  node = unwrap(node);
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const initializer = initializerFor(node, checker);
    return initializer ? hasSmokeDetails(initializer, checker, seen) : false;
  }
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(
    (member) =>
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
      member.name.text === 'tag' &&
      containsSmoke(member.initializer, checker)
  );
}

/**
 * Build a stable inventory of `<root>/e2e/**\/*.spec.ts` without importing or running specs.
 * Keys are relative to `root` (e.g. `e2e/admin/x.spec.ts`); `app` is the first segment under `e2e/`.
 */
export function generateManifest(root: string): Manifest {
  root = path.resolve(root);
  const files = sourceFiles(path.join(root, 'e2e'));
  // All local helpers are roots so imports resolve, while noResolve/noLib prevent
  // walking app dependencies or loading Playwright and generated API declarations.
  const program = ts.createProgram(files, {
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const manifest: Manifest = {};

  for (const filename of files.filter((file) => file.endsWith('.spec.ts')).sort(compare)) {
    const key = path.relative(root, filename).split(path.sep).join('/');
    const segments = key.split('/');
    const app = segments.length > 2 ? segments[1]! : '';
    const source = program.getSourceFile(filename);
    if (!source) continue;
    const routes = new Set<string>();
    const titles: string[] = [];
    let smoke = false;

    const visit = (node: ts.Node, describeDepth: number): void => {
      let depth = describeDepth;
      if (ts.isCallExpression(node)) {
        const kind = testCallKind(node.expression);
        if (kind) {
          const title = node.arguments[0];
          if (title && containsSmoke(title, checker)) smoke = true;
          if (node.arguments[1] && hasSmokeDetails(node.arguments[1], checker)) smoke = true;
          if (kind === 'describe') {
            if (title && depth === 0) titles.push(routeValue(title, checker));
            depth += 1;
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'goto' &&
          node.arguments[0]
        ) {
          routes.add(routeValue(node.arguments[0], checker));
        }
      }
      ts.forEachChild(node, (child) => visit(child, depth));
    };

    visit(source, 0);
    manifest[key] = {
      app,
      routes: [...routes].sort(compare),
      title: [...new Set(titles)].join('; ') || path.basename(filename, '.spec.ts'),
      smoke,
    };
  }
  return manifest;
}
