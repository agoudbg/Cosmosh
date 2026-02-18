const plugin = require('tailwindcss/plugin');
const { base: themeBase } = require('./theme/tokens.cjs');

const toVar = (prefix, pathParts) => {
  const normalized = pathParts.filter((part) => part !== 'DEFAULT');
  return `var(--${[prefix, ...normalized].join('-')})`;
};

const mapVars = (obj, prefix, pathParts = []) => {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [key, mapVars(value, prefix, [...pathParts, key])];
      }

      return [key, toVar(prefix, [...pathParts, key])];
    })
  );
};

const themeColors = mapVars(themeBase.colors, 'color');
const themeRadius = mapVars(themeBase.radius, 'radius');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ...themeColors,
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        ...themeRadius,
      },
      boxShadow: {
        soft: '0 8px 30px var(--shadow-soft)',
        glow: '0 0 40px var(--color-accent-glow)',
      },
      spacing: {
        18: '4.5rem',
        22: '5.5rem',
      },
      keyframes: {
        'overlay-show': {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        'content-show': {
          from: { opacity: 0, transform: 'translateY(6px) scale(0.98)' },
          to: { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'overlay-show': 'overlay-show 120ms ease-out',
        'content-show': 'content-show 180ms ease-out',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    plugin(({ addVariant }) => {
      const states = ['open', 'closed', 'checked', 'unchecked', 'on', 'off', 'active', 'inactive', 'indeterminate'];
      states.forEach((state) => addVariant(`radix-state-${state}`, `&[data-state="${state}"]`));

      const sides = ['top', 'bottom', 'left', 'right'];
      sides.forEach((side) => addVariant(`radix-side-${side}`, `&[data-side="${side}"]`));

      addVariant('radix-disabled', '&[data-disabled]');

      addVariant('hof', ['&:hover', '&:focus']);
    }),
  ],
};
