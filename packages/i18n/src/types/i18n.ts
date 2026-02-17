export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

export type TranslationPrimitive = string | number | boolean;

export type TranslationParams = Record<string, TranslationPrimitive> | TranslationPrimitive[];

export type MissingKeyPayload = {
  locale: Locale;
  scope: Scope;
  key: string;
};

export type MessagesByScope = {
  main: TranslationTree;
  renderer: TranslationTree;
  backend: TranslationTree;
};

export type Messages = Record<Locale, MessagesByScope>;

export type Locale = 'en' | 'zh-CN';

export type Scope = keyof MessagesByScope;

export type I18nInstance = {
  t: (key: string, params?: TranslationParams) => string;
  getLocale: () => Locale;
  setLocale: (nextLocale: string) => void;
  getLocales: () => Locale[];
};

export type CreateI18nOptions = {
  locale: string;
  scope: Scope;
  fallbackLocale?: Locale;
  onMissingKey?: (payload: MissingKeyPayload) => void;
  resources?: Messages;
};

export type EnableI18nDevHotReloadOptions = {
  localeRootDir: string;
  debounceMs?: number;
};
