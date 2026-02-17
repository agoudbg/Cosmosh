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
      divider: '#333333',
    },
    home: {
      card: {
        DEFAULT: '#141414d9',
        hover: '#222222cc',
        active: '#333333d9',
      },
      chip: {
        DEFAULT: '#141414d9',
        hover: '#222222cc',
        active: '#333333d9',
      },
      search: {
        DEFAULT: '#191919d9',
      },
      text: {
        subtle: '#8b95a7',
        empty: {
          icon: '#8f949d',
        },
      },
      divider: '#2b2b2b',
      icon: {
        bg: '#d2d6dc',
        active: '#ffffff',
        slate: '#30343f',
        'slate-ink': '#d9dde5',
        blue: '#1f334f',
        'blue-ink': '#b5d7ff',
        emerald: '#17342e',
        'emerald-ink': '#a8f2dd',
        violet: '#2f2348',
        'violet-ink': '#d7c1ff',
        amber: '#4a3314',
        'amber-ink': '#ffdfae',
        rose: '#4b1f2d',
        'rose-ink': '#ffc2d4',
        cyan: '#183b45',
        'cyan-ink': '#b8f0ff',
      },
    },
    menu: {
      control: {
        DEFAULT: '#191919d9',
        hover: '#292929cc',
      },
      divider: '#333333',
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
    status: {
      good: '#4ade80',
      warn: '#facc15',
      bad: '#f87171',
    },
    scrollbar: {
      width: '8px',
      track: '#00000000',
      thumb: { DEFAULT: '#2f2f2f', hover: '#3a3a3a' },
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
    home: {
      card: {
        DEFAULT: '#f8fafc',
        hover: '#eef2f7',
        active: '#e2e8f0',
      },
      chip: {
        DEFAULT: '#f8fafc',
        hover: '#eef2f7',
        active: '#e2e8f0',
      },
      search: {
        DEFAULT: '#ffffff',
      },
      text: {
        subtle: '#66758b',
        empty: {
          icon: '#8d939c',
        },
      },
      divider: '#d6deea',
      icon: {
        bg: '#d2d6dc',
        active: '#ffffff',
        slate: '#dce3ed',
        'slate-ink': '#3a4a61',
        blue: '#d8e8ff',
        'blue-ink': '#225aa8',
        emerald: '#d6f4ea',
        'emerald-ink': '#1f7d67',
        violet: '#e8defc',
        'violet-ink': '#6c48b7',
        amber: '#fdeccc',
        'amber-ink': '#9d640f',
        rose: '#ffdce7',
        'rose-ink': '#9a2f55',
        cyan: '#d8f4fb',
        'cyan-ink': '#177b93',
      },
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
