import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactPlugin from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import prettierPlugin from 'eslint-plugin-prettier';
import tailwindcss from 'eslint-plugin-tailwindcss';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.node.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
      prettier: prettierPlugin,
      tailwindcss,
    },
    settings: {
      react: {
        version: 'detect',
      },
      'import/resolver': {
        node: {
          extensions: ['.ts', '.tsx', '.js', '.jsx'],
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'prettier/prettier': 'error',
      indent: 'off',
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-console': 0,
      'import/extensions': 0,
      'simple-import-sort/imports': 'warn',
      'import/no-unresolved': 0,
      'max-classes-per-file': 0,
      'no-underscore-dangle': 0,
      'no-plusplus': 0,
      'no-shadow': 0,
      'max-len': 'off',
      'no-alert': 0,
      'import/prefer-default-export': 0,
      'no-param-reassign': 0,
      'no-nested-ternary': 0,
      'react/jsx-sort-props': [
        'error',
        {
          reservedFirst: true,
          callbacksLast: true,
          shorthandFirst: true,
          noSortAlphabetically: true,
        },
      ],
      'tailwindcss/classnames-order': 'error',
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'no-trailing-spaces': 'error',
      'no-multi-spaces': 'error',
      'space-in-parens': ['error', 'never'],
      'func-call-spacing': ['error', 'never'],
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
