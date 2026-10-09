import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []))).flat();
}
const violations = [];
for (const file of await files('src')) {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function check(specifier) {
    const layer = file.split(path.sep)[1];
    const target = specifier.startsWith('.') ? path.normalize(path.join(path.dirname(file), specifier)) : specifier;
    const allowed = layer === 'core' ? target.startsWith('src/core/')
      : layer === 'application' ? target.startsWith('src/core/') || target.startsWith('src/application/')
      : layer === 'ui' ? target === 'obsidian' || target.startsWith('src/ui/') || target.startsWith('src/core/') || target.startsWith('src/application/')
      : layer === 'adapters' ? !(target.startsWith('src/ui/') || target.startsWith('src/application/'))
      : true;
    if (!allowed) violations.push(`${file}: forbidden dependency ${specifier}`);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log('Module boundaries passed.');
