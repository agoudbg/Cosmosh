const standardTextColorDefault = '#eeeeee';
const standardTextColorMuted = '#a7b0bd';

const base = {
  font: {
    sans: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif',
    mono: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    size: {
      form: {
        label: '0.8rem',
      },
    },
  },
  radius: {
    xs: '2px',
    'xs-2': '4px',
    sm: '6px',
    'sm-2': '8px',
    md: '10px',
    'md-2': '12px',
    lg: '14px',
    'lg-2': '16px',
    xl: '18px',
    'xl-2': '20px',
  },
  colors: {
    text: {
      DEFAULT: standardTextColorDefault,
      muted: standardTextColorMuted,
    },
    bg: {
      DEFAULT: '#000000',
      subtle: '#191919d9',
      panel: '#131822',
    },
    header: {
      tab: {
        hover: '#222222',
        active: '#2F2F2F',
        'server-active-overlay': '#00000000',
        'server-inactive-overlay': '#00000080',
        'server-inactive-overlay-hover': '#00000059',
      },
      text: {
        DEFAULT: standardTextColorDefault,
        muted: standardTextColorMuted,
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
        active: standardTextColorDefault,
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
        indigo: '#242f57',
        'indigo-ink': '#c7d2ff',
        teal: '#153b3a',
        'teal-ink': '#a8f3ea',
        lime: '#324112',
        'lime-ink': '#e2f8b0',
      },
    },
    windows: {
      'system-menu-symbol': '#f5f7fa',
    },
    ssh: {
      card: {
        bg: {
          DEFAULT: '#191919',
          terminal: '#0f0f0f',
        },
      },
      terminal: {
        DEFAULT: '#cccccc',
        split: {
          divider: '#2a2a2a',
        },
      },
    },
    syntax: {
      attribute: '#9cdcfe',
      comment: '#6a9955',
      definition: '#dcdcaa',
      invalid: '#f44747',
      keyword: '#569cd6',
      link: '#569cd6',
      literal: '#b5cea8',
      meta: '#c586c0',
      operator: '#d4d4d4',
      property: '#9cdcfe',
      punctuation: '#808080',
      string: '#ce9178',
      tag: '#4ec9b0',
      text: '#d4d4d4',
      type: '#4ec9b0',
    },
    menu: {
      control: {
        DEFAULT: '#191919d9',
        hover: '#292929cc',
      },
      divider: '#333333',
      'selection-bar-border': '#ffffff1f',
    },
    command: {
      surface: '#0f0f0ff2',
      border: '#3a3a3a66',
      divider: '#33333399',
      input: '#1a1a1ad9',
      text: {
        DEFAULT: standardTextColorDefault,
        muted: standardTextColorMuted,
      },
      item: {
        hover: '#242424e6',
        active: '#2e2e2ee6',
        'color-visual-active-overlay': '#00000000',
        'color-visual-overlay': '#00000080',
        'color-visual-overlay-hover': '#00000059',
      },
      action: {
        hover: '#333333cc',
      },
    },
    dialog: {
      overlay: '#000000aa',
      surface: '#0e0e0ee6',
      border: '#33333333',
      text: {
        DEFAULT: standardTextColorDefault,
        muted: standardTextColorMuted,
      },
      action: {
        danger: '#f87171',
      },
    },
    toast: {
      surface: '#070707f2',
      border: '#3333332e',
      text: {
        DEFAULT: standardTextColorDefault,
        muted: standardTextColorMuted,
      },
      icon: {
        info: '#60a5fa',
        success: '#4ade80',
        warning: '#facc15',
        error: '#f87171',
      },
    },
    form: {
      control: {
        DEFAULT: '#191919d9',
        hover: '#292929cc',
      },
      text: {
        DEFAULT: standardTextColorDefault,
        label: '#cdd3dc',
        muted: standardTextColorMuted,
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
      track: '#00000000',
      thumb: { DEFAULT: '#2f2f2f', hover: '#3a3a3a' },
    },
  },
  shadow: {
    lg: '0 0px 10px #00000088',
    soft: 'rgba(4, 8, 16, 0.6)',
    menu: 'rgba(0, 0, 0, 0)',
    'menu-content': 'rgba(4, 8, 16, 0.6)',
    'selection-bar': 'rgba(0, 0, 0, 0.24)',
  },
};

const light = {
  colors: {
    bg: {
      DEFAULT: '#f5f5f7',
      subtle: '#f0f0f3',
      panel: '#ffffff',
    },
    header: {
      tab: {
        hover: '#ececf0',
        active: '#e4e4ea',
        'server-active-overlay': '#00000014',
        'server-inactive-overlay': '#f5f5f780',
        'server-inactive-overlay-hover': '#f5f5f759',
      },
      text: {
        DEFAULT: '#111827',
        muted: '#6e6e73',
      },
      divider: '#e2e2e8',
    },
    text: {
      DEFAULT: '#111827',
      muted: '#6e6e73',
      faint: '#9b9ba1',
    },
    border: {
      DEFAULT: '#e2e2e8',
      strong: '#d1d1d8',
    },
    home: {
      card: {
        DEFAULT: '#f7f7fa',
        hover: '#efeff3',
        active: '#e6e6ed',
      },
      chip: {
        DEFAULT: '#f7f7fa',
        hover: '#efeff3',
        active: '#e6e6ed',
      },
      search: {
        DEFAULT: '#ffffff',
      },
      text: {
        subtle: '#6e6e73',
        empty: {
          icon: '#9b9ba1',
        },
      },
      divider: '#e2e2e8',
      icon: {
        bg: '#d8d8de',
        active: '#ffffff',
        slate: '#e5e5ea',
        'slate-ink': '#4b5563',
        blue: '#e7efff',
        'blue-ink': '#355b9a',
        emerald: '#e4f4ee',
        'emerald-ink': '#2f7a67',
        violet: '#eee7fa',
        'violet-ink': '#6a52a3',
        amber: '#fdf0db',
        'amber-ink': '#996722',
        rose: '#fce5eb',
        'rose-ink': '#9c4363',
        cyan: '#e4f3f7',
        'cyan-ink': '#2e7484',
        indigo: '#e9edff',
        'indigo-ink': '#4155a8',
        teal: '#e4f6f4',
        'teal-ink': '#2f7c76',
        lime: '#eef8dc',
        'lime-ink': '#5f7f1f',
      },
    },
    windows: {
      'system-menu-symbol': '#111827',
    },
    ssh: {
      card: {
        bg: {
          DEFAULT: '#ffffff',
        },
      },
      terminal: {
        split: {
          divider: '#d9dde6',
        },
      },
    },
    syntax: {
      attribute: '#0451a5',
      comment: '#008000',
      definition: '#795e26',
      invalid: '#cd3131',
      keyword: '#0000ff',
      link: '#0000ff',
      literal: '#098658',
      meta: '#af00db',
      operator: '#383a42',
      property: '#0451a5',
      punctuation: '#5f6a7d',
      string: '#a31515',
      tag: '#267f99',
      text: '#383a42',
      type: '#267f99',
    },
    accent: {
      DEFAULT: '#0ea5e9',
      hover: '#0284c7',
      glow: 'rgba(14, 165, 233, 0.35)',
    },
    menu: {
      control: {
        DEFAULT: '#ffffff',
        hover: '#f1f1f5',
      },
      divider: '#e2e2e8',
      'selection-bar-border': '#d4d8e180',
    },
    command: {
      surface: '#ffffffed',
      border: '#d6d8e199',
      divider: '#e2e2e8',
      input: '#f4f5f8',
      text: {
        DEFAULT: '#111827',
        muted: '#6e6e73',
      },
      item: {
        hover: '#eff1f6',
        active: '#e8ebf2',
        'color-visual-active-overlay': '#00000014',
        'color-visual-overlay': '#f5f5f780',
        'color-visual-overlay-hover': '#f5f5f759',
      },
      action: {
        hover: '#dde2ec',
      },
    },
    dialog: {
      overlay: '#0f172a4d',
      surface: '#ffffff',
      border: '#d6deea10',
      text: {
        DEFAULT: '#111827',
        muted: '#475569',
      },
      action: {
        danger: '#dc2626',
      },
    },
    toast: {
      surface: '#f8fafc',
      border: '#d6deea80',
      text: {
        DEFAULT: '#111827',
        muted: '#475569',
      },
      icon: {
        info: '#0ea5e9',
        success: '#22c55e',
        warning: '#d97706',
        error: '#dc2626',
      },
    },
    form: {
      control: {
        DEFAULT: '#ffffff',
        hover: '#f1f1f5',
      },
      text: {
        DEFAULT: '#111827',
        label: '#39424e',
        muted: '#6e6e73',
      },
      switch: {
        track: {
          off: '#d1d1d8',
          on: '#0a84ff',
        },
      },
      thumb: {
        off: '#a8a8b2',
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
    divider: '#e2e2e8',
    scrollbar: {
      thumb: {
        DEFAULT: '#c9c9d2',
        hover: '#b4b4bf',
      },
    },
  },
  shadow: {
    soft: 'rgba(148, 163, 184, 0.4)',
    menu: 'rgba(0, 0, 0, 0)',
    'menu-content': 'rgba(148, 163, 184, 0.4)',
    'selection-bar': 'rgba(148, 163, 184, 0.24)',
  },
};

module.exports = {
  base,
  light,
};
