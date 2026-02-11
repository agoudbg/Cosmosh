const fs = require('node:fs');
const path = require('node:path');

const { base, light } = require('../theme/tokens.cjs');

const START_MARKER = '/* theme-tokens:start */';
const END_MARKER = '/* theme-tokens:end */';

const cssPath = path.resolve(__dirname, '../src/index.css');

const toVarName = (prefixParts) => `--${prefixParts.join('-')}`;

const collectVars = (value, prefixParts, out) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    Object.entries(value).forEach(([key, child]) => {
      const nextParts = key === 'DEFAULT' ? prefixParts : [...prefixParts, key];
      collectVars(child, nextParts, out);
    });
    return;
  }

  out.push([toVarName(prefixParts), String(value)]);
};

const buildVars = (tokens) => {
  const entries = [];
  collectVars(tokens.font, ['font'], entries);
  collectVars(tokens.radius, ['radius'], entries);
  collectVars(tokens.colors, ['color'], entries);
  collectVars(tokens.shadow, ['shadow'], entries);
  return entries;
};

const buildThemeVars = (tokens) => {
  const entries = [];
  collectVars(tokens.colors, ['color'], entries);
  collectVars(tokens.shadow, ['shadow'], entries);
  return entries;
};

const formatBlock = (selector, entries) => {
  const lines = entries.map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
};

const indentLines = (text, spaces) => {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
};

const baseVars = buildVars(base);
const lightVars = buildThemeVars(light);

const generated = [
  START_MARKER,
  formatBlock(':root', baseVars),
  '',
  formatBlock(":root[data-theme='light']", lightVars),
  '',
  '@media (prefers-color-scheme: light) {',
  indentLines(formatBlock(":root[data-theme='auto']", lightVars), 2),
  '}',
  END_MARKER,
].join('\n');

const css = fs.readFileSync(cssPath, 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRegex = new RegExp(`${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`, 'm');

if (!blockRegex.test(css)) {
  throw new Error(`Missing theme token markers in ${cssPath}`);
}

const nextCss = css.replace(blockRegex, generated);

if (nextCss !== css) {
  fs.writeFileSync(cssPath, nextCss, 'utf8');
}
