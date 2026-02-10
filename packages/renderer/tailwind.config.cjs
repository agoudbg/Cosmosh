const plugin = require('tailwindcss/plugin');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--color-bg)',
          subtle: 'var(--color-bg-subtle)',
          panel: 'var(--color-bg-panel)',
        },
        text: {
          DEFAULT: 'var(--color-text)',
          muted: 'var(--color-text-muted)',
          faint: 'var(--color-text-faint)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--color-accent-hover)',
          glow: 'var(--color-accent-glow)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
        },
        status: {
          good: 'var(--color-status-good)',
          warn: 'var(--color-status-warn)',
          bad: 'var(--color-status-bad)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
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
    }),
  ],
};
