import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ts from 'typescript';

/**
 * Determines whether an import declaration creates a runtime dependency.
 *
 * @param declaration TypeScript import declaration from the preload source.
 * @returns Whether transpilation can emit a runtime module load.
 */
const isRuntimeImport = (declaration: ts.ImportDeclaration): boolean => {
  const importClause = declaration.importClause;
  if (!importClause) {
    return true;
  }
  if (importClause.isTypeOnly) {
    return false;
  }
  if (importClause.name) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings || ts.isNamespaceImport(namedBindings)) {
    return true;
  }

  return namedBindings.elements.some((element) => !element.isTypeOnly);
};

test('sandboxed preload has no runtime dependency outside Electron', () => {
  const preloadPath = path.join(__dirname, 'preload.ts');
  const sourceText = fs.readFileSync(preloadPath, 'utf8');
  const sourceFile = ts.createSourceFile(preloadPath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const runtimeModules = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter(isRuntimeImport)
    .map((declaration) => {
      assert.ok(ts.isStringLiteral(declaration.moduleSpecifier), 'Preload imports must use static module specifiers.');
      return declaration.moduleSpecifier.text;
    });

  assert.deepEqual(runtimeModules, ['electron']);
});
