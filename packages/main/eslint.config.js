const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');
const simpleImportSort = require('eslint-plugin-simple-import-sort');
const prettierPlugin = require('eslint-plugin-prettier');

module.exports = tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
      prettier: prettierPlugin,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.ts', '.tsx', '.js', '.jsx'],
        },
      },
    },
    rules: {
      'prettier/prettier': 'error',
      indent: 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-console': 0,
      'import/extensions': 0,
      'simple-import-sort/imports': 'warn',
      'import/no-unresolved': 0,
      'no-underscore-dangle': 0,
      'no-plusplus': 0,
      'no-shadow': 0,
      'max-len': 'off',
      'no-alert': 0,
      'import/prefer-default-export': 0,
      'no-param-reassign': 0,
      'no-nested-ternary': 0,
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'no-trailing-spaces': 'error',
      'no-multi-spaces': 'error',
      'space-in-parens': ['error', 'never'],
      'func-call-spacing': 'off',
      '@/func-call-spacing': ['error', 'never'],
      'function-call-argument-newline': 'off',
      'function-paren-newline': 'off',
      'object-curly-newline': 'off',
      'comma-spacing': ['error', { before: false, after: true }],
      'spaced-comment': ['error', 'always'],
      'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
      'eol-last': ['error', 'always'],
    },
  }
);
