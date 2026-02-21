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
        menu: '0 8px 30px var(--shadow-menu)',
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
        'overlay-hide': {
          from: { opacity: 1 },
          to: { opacity: 0 },
        },
        'content-show': {
          from: { opacity: 0, transform: 'translate(-50%, calc(-50% + 6px)) scale(0.98)' },
          to: { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
        },
        'content-hide': {
          from: { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: 0, transform: 'translate(-50%, calc(-50% + 4px)) scale(0.98)' },
        },
        'toast-in': {
          from: {
            opacity: 0,
            transform: 'translateY(8px) scale(0.98)',
            maxHeight: '0px',
            paddingTop: '0px',
            paddingBottom: '0px',
            borderWidth: '0px',
          },
          to: {
            opacity: 1,
            transform: 'translateY(0) scale(1)',
            maxHeight: '220px',
            paddingTop: '0.625rem',
            paddingBottom: '0.625rem',
            borderWidth: '1px',
          },
        },
        'toast-out': {
          from: {
            opacity: 1,
            transform: 'translateY(0) scale(1)',
            maxHeight: '220px',
            paddingTop: '0.625rem',
            paddingBottom: '0.625rem',
            borderWidth: '1px',
          },
          to: {
            opacity: 0,
            transform: 'translateY(6px) scale(0.98)',
            maxHeight: '0px',
            paddingTop: '0px',
            paddingBottom: '0px',
            borderWidth: '0px',
          },
        },
        'toast-swipe-out': {
          from: { transform: 'translateX(var(--radix-toast-swipe-end-x))' },
          to: { transform: 'translateY(10px) scale(0.98)', opacity: 0 },
        },
      },
      animation: {
        'overlay-show': 'overlay-show 120ms ease-out',
        'overlay-hide': 'overlay-hide 120ms ease-in',
        'content-show': 'content-show 180ms ease-out',
        'content-hide': 'content-hide 140ms ease-in',
        'toast-in': 'toast-in 200ms ease-out',
        'toast-out': 'toast-out 160ms ease-in',
        'toast-swipe-out': 'toast-swipe-out 160ms ease-out',
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
