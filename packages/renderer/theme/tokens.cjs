const base = {
  font: {
    sans: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif',
    mono: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  radius: {
    sm: '6px',
    md: '10px',
    lg: '16px',
  },
  colors: {
    bg: {
      DEFAULT: '#000000',
      subtle: '#191919d9',
      panel: '#131822',
    },
    header: {
      tab: {
        hover: '#222222',
        active: '#2F2F2F',
      },
      text: {
        DEFAULT: '#ffffff',
        muted: '#a7b0bd',
      },
    },
    menu: {
      control: {
        DEFAULT: '#191919d9',
        hover: '#292929cc',
      },
    },
    form: {
      control: {
        DEFAULT: '#191919d9',
        hover: '#292929cc',
      },
      text: {
        DEFAULT: '#ffffff',
        muted: '#a7b0bd',
      },
      switch: {
        track: {
          off: '#303030',
          on: '#1e90ff',
        },
      },
      thumb: {
        off: '#afafaf',
        on: '#ffffff',
      },
      message: {
        error: '#f87171',
      },
      active: '#1e90ff',
    },
    outline: '#0078d4aa',
    divider: '#333333',
    status: {
      good: '#4ade80',
      warn: '#facc15',
      bad: '#f87171',
    },
  },
  shadow: {
    soft: 'rgba(4, 8, 16, 0.6)',
  },
};

const light = {
  colors: {
    bg: {
      DEFAULT: '#f7f9fc',
      subtle: '#eef2f7',
      panel: '#ffffff',
    },
    text: {
      DEFAULT: '#111827',
      muted: '#475569',
      faint: '#94a3b8',
    },
    border: {
      DEFAULT: '#e2e8f0',
      strong: '#cbd5f5',
    },
    accent: {
      DEFAULT: '#0ea5e9',
      hover: '#0284c7',
      glow: 'rgba(14, 165, 233, 0.35)',
    },
    menu: {
      control: '#ffffff',
      controlHover: '#f1f5f9',
    },
    form: {
      control: {
        DEFAULT: '#ffffff',
        hover: '#f1f5f9',
      },
      text: {
        DEFAULT: '#111827',
        muted: '#475569',
      },
      switch: {
        track: {
          off: '#d5deea',
          on: '#0a84ff',
        },
      },
      thumb: {
        off: '#acb9cb',
        on: '#ffffff',
      },
      message: {
        error: '#dc2626',
      },
      active: '#0a84ff',
    },
    status: {
      good: '#4ade80',
      warn: '#facc15',
      bad: '#f87171',
    },
    divider: '#333333',
  },
  shadow: {
    soft: 'rgba(148, 163, 184, 0.4)',
  },
};

module.exports = {
  base,
  light,
};
