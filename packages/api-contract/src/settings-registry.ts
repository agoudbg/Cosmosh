/**
 * Cosmosh Settings Registry — Single Source of Truth
 *
 * This file is the ONLY place where application settings are defined.
 * When adding or removing a setting:
 *   1. Add/remove the key in the `SettingsValues` interface.
 *   2. Add/remove the corresponding `SettingDefinition` entry in `SETTINGS_REGISTRY`.
 *   3. Add/remove i18n keys in locale files.
 *
 * Everything else — defaults, validation rules, UI controls, categories — is
 * derived from this registry at build/runtime.  The OpenAPI schema for
 * `SettingsValues` is intentionally left as a generic object; constraints
 * and enum sets live here exclusively.
 */

// ── SettingsValues — strict canonical TypeScript interface ────

export interface SettingsValues {
  language: 'en' | 'zh-CN';
  theme: 'dark' | 'light' | 'auto';
  sshMaxRows: number;
  sshConnectionTimeoutSec: number;
  devToolsEnabled: boolean;
  autoSaveEnabled: boolean;
  accountSyncEnabled: boolean;
  defaultServerNoteTemplate: string;
  terminalSelectionBarEnabled: boolean;
  terminalTextDropMode: 'off' | 'always' | 'external';
  terminalSelectionSearchEngine: 'google' | 'bing' | 'duckduckgo' | 'baidu' | 'custom';
  terminalSelectionSearchUrlTemplate: string;
}

export type SettingKey = keyof SettingsValues;

// ── Category & Section Node Types ────────────────────────────

export type SettingsSection = {
  readonly labelI18nKey: string;
};

export type SettingsCategory = {
  readonly labelI18nKey: string;
  readonly sections: Readonly<Record<string, SettingsSection>>;
};

// ── Categories & Sections (Single Source of Truth) ───────────
// Key insertion order determines navigation order in the Settings UI.

export const SETTINGS_CATEGORIES = {
  general: {
    labelI18nKey: 'settings.categories.general',
    sections: {
      localization: { labelI18nKey: 'settings.sections.localization' },
    },
  },
  'account-sync': {
    labelI18nKey: 'settings.categories.account-sync',
    sections: {
      synchronization: { labelI18nKey: 'settings.sections.synchronization' },
    },
  },
  theme: {
    labelI18nKey: 'settings.categories.theme',
    sections: {
      appearance: { labelI18nKey: 'settings.sections.appearance' },
    },
  },
  terminal: {
    labelI18nKey: 'settings.categories.terminal',
    sections: {
      terminalSelection: { labelI18nKey: 'settings.sections.terminalSelection' },
      search: { labelI18nKey: 'settings.sections.search' },
      runtime: { labelI18nKey: 'settings.sections.runtime' },
    },
  },
  connection: {
    labelI18nKey: 'settings.categories.connection',
    sections: {
      connection: { labelI18nKey: 'settings.sections.connection' },
    },
  },
  advanced: {
    labelI18nKey: 'settings.categories.advanced',
    sections: {
      runtime: { labelI18nKey: 'settings.sections.runtime' },
      editorDefaults: { labelI18nKey: 'settings.sections.editorDefaults' },
    },
  },
  about: {
    labelI18nKey: 'settings.categories.about',
    sections: {},
  },
} as const satisfies Record<string, SettingsCategory>;

// Derived type from the categories constant — no manual union needed.
export type SettingsCategoryId = keyof typeof SETTINGS_CATEGORIES;

// Ordered list of category IDs (mirrors key insertion order).
export const SETTINGS_CATEGORY_IDS: ReadonlyArray<SettingsCategoryId> =
  Object.keys(SETTINGS_CATEGORIES) as SettingsCategoryId[];

// ── Setting Definition ───────────────────────────────────────

type SettingControlType = 'select' | 'input' | 'textarea' | 'switch';
type SettingValueType = 'string' | 'number' | 'boolean';
type SettingSelectOption = { value: string };

export type SettingDefinition = {
  key: SettingKey;
  valueType: SettingValueType;
  defaultValue: string | number | boolean;
  nameI18nKey: string;
  descriptionI18nKey: string;
  placeholderI18nKey?: string;
  optionI18nNamespace?: string;
  category: SettingsCategory;
  section: SettingsSection;
  control: SettingControlType;
  path: string;
  commandActionId: string;
  searchTerms: string[];
  inputMode?: 'text' | 'none' | 'search' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal';
  min?: number;
  max?: number;
  maxLength?: number;
  options?: SettingSelectOption[];
};

// ── The Registry ─────────────────────────────────────────────

export const SETTINGS_REGISTRY: ReadonlyArray<SettingDefinition> = [
  {
    key: 'language',
    valueType: 'string',
    defaultValue: 'en',
    nameI18nKey: 'settings.items.language.title',
    descriptionI18nKey: 'settings.items.language.description',
    optionI18nNamespace: 'language',
    category: SETTINGS_CATEGORIES.general,
    section: SETTINGS_CATEGORIES.general.sections.localization,
    control: 'select',
    path: 'general.language',
    commandActionId: 'settings.general.language.set',
    searchTerms: ['language', 'locale', 'ui language', 'english', 'chinese'],
    options: [{ value: 'en' }, { value: 'zh-CN' }],
  },
  {
    key: 'accountSyncEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.accountSyncEnabled.title',
    descriptionI18nKey: 'settings.items.accountSyncEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES['account-sync'],
    section: SETTINGS_CATEGORIES['account-sync'].sections.synchronization,
    control: 'select',
    path: 'account.sync.enabled',
    commandActionId: 'settings.account.sync.toggle',
    searchTerms: ['sync', 'account sync', 'cloud sync'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'theme',
    valueType: 'string',
    defaultValue: 'dark',
    nameI18nKey: 'settings.items.theme.title',
    descriptionI18nKey: 'settings.items.theme.description',
    optionI18nNamespace: 'theme',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.appearance,
    control: 'select',
    path: 'theme.mode',
    commandActionId: 'settings.theme.mode.set',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
    options: [{ value: 'dark' }, { value: 'light' }, { value: 'auto' }],
  },
  {
    key: 'sshMaxRows',
    valueType: 'number',
    defaultValue: 10000,
    nameI18nKey: 'settings.items.sshMaxRows.title',
    descriptionI18nKey: 'settings.items.sshMaxRows.description',
    placeholderI18nKey: 'settings.items.sshMaxRows.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'input',
    path: 'terminal.runtime.maxRows',
    commandActionId: 'settings.terminal.runtime.maxRows.set',
    searchTerms: ['ssh', 'max rows', 'terminal lines', 'scrollback', 'terminal'],
    inputMode: 'numeric',
    min: 100,
    max: 200000,
  },
  {
    key: 'sshConnectionTimeoutSec',
    valueType: 'number',
    defaultValue: 45,
    nameI18nKey: 'settings.items.sshConnectionTimeoutSec.title',
    descriptionI18nKey: 'settings.items.sshConnectionTimeoutSec.description',
    placeholderI18nKey: 'settings.items.sshConnectionTimeoutSec.placeholder',
    category: SETTINGS_CATEGORIES.connection,
    section: SETTINGS_CATEGORIES.connection.sections.connection,
    control: 'input',
    path: 'connection.ssh.timeoutSec',
    commandActionId: 'settings.connection.ssh.timeout.set',
    searchTerms: ['ssh', 'timeout', 'connection timeout'],
    inputMode: 'numeric',
    min: 5,
    max: 180,
  },
  {
    key: 'autoSaveEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.autoSaveEnabled.title',
    descriptionI18nKey: 'settings.items.autoSaveEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.editorDefaults,
    control: 'select',
    path: 'advanced.editor.autoSaveEnabled',
    commandActionId: 'settings.advanced.editor.autoSave.toggle',
    searchTerms: ['auto save', 'autosave', 'save automatically'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'devToolsEnabled',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.devToolsEnabled.title',
    descriptionI18nKey: 'settings.items.devToolsEnabled.description',
    optionI18nNamespace: 'boolean',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.runtime,
    control: 'select',
    path: 'advanced.runtime.devToolsEnabled',
    commandActionId: 'settings.advanced.runtime.devTools.toggle',
    searchTerms: ['devtools', 'developer tools', 'debug tools', 'ctrl+shift+i'],
    options: [{ value: 'true' }, { value: 'false' }],
  },
  {
    key: 'defaultServerNoteTemplate',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.defaultServerNoteTemplate.title',
    descriptionI18nKey: 'settings.items.defaultServerNoteTemplate.description',
    placeholderI18nKey: 'settings.items.defaultServerNoteTemplate.placeholder',
    category: SETTINGS_CATEGORIES.advanced,
    section: SETTINGS_CATEGORIES.advanced.sections.editorDefaults,
    control: 'textarea',
    path: 'advanced.editor.defaultServerNoteTemplate',
    commandActionId: 'settings.advanced.editor.defaultServerNoteTemplate.set',
    searchTerms: ['template', 'note', 'server note', 'editor defaults'],
    maxLength: 1000,
  },
  {
    key: 'terminalSelectionBarEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalSelectionBarEnabled.title',
    descriptionI18nKey: 'settings.items.terminalSelectionBarEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.terminalSelection,
    control: 'switch',
    path: 'terminal.selection.toolbar.enabled',
    commandActionId: 'settings.terminal.selection.toolbar.toggle',
    searchTerms: ['terminal', 'orbit bar', 'floating bar', 'enable orbit bar'],
  },
  {
    key: 'terminalTextDropMode',
    valueType: 'string',
    defaultValue: 'external',
    nameI18nKey: 'settings.items.terminalTextDropMode.title',
    descriptionI18nKey: 'settings.items.terminalTextDropMode.description',
    optionI18nNamespace: 'terminalTextDropMode',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.textDropMode',
    commandActionId: 'settings.terminal.runtime.textDropMode.set',
    searchTerms: ['terminal', 'drag', 'drop', 'text drop', 'external drag'],
    options: [{ value: 'off' }, { value: 'always' }, { value: 'external' }],
  },
  {
    key: 'terminalSelectionSearchEngine',
    valueType: 'string',
    defaultValue: 'google',
    nameI18nKey: 'settings.items.terminalSelectionSearchEngine.title',
    descriptionI18nKey: 'settings.items.terminalSelectionSearchEngine.description',
    optionI18nNamespace: 'searchEngine',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.search,
    control: 'select',
    path: 'ssh.search.searchEngine',
    commandActionId: 'settings.ssh.searchEngine.set',
    searchTerms: ['search engine', 'quick search', 'google', 'bing', 'duckduckgo', 'baidu'],
    options: [{ value: 'google' }, { value: 'bing' }, { value: 'duckduckgo' }, { value: 'baidu' }, { value: 'custom' }],
  },
  {
    key: 'terminalSelectionSearchUrlTemplate',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.title',
    descriptionI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.description',
    placeholderI18nKey: 'settings.items.terminalSelectionSearchUrlTemplate.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.search,
    control: 'input',
    path: 'ssh.search.searchUrlTemplate',
    commandActionId: 'settings.ssh.searchUrlTemplate.set',
    searchTerms: ['search url', 'template', '%s', 'browser'],
    maxLength: 1000,
  },
];

// ── Derived Defaults ─────────────────────────────────────────

export const DEFAULT_SETTINGS_VALUES: SettingsValues = Object.fromEntries(
  SETTINGS_REGISTRY.map((item) => [item.key, item.defaultValue]),
) as unknown as SettingsValues;

// ── Lookup Map ───────────────────────────────────────────────

export const SETTINGS_DEFINITION_MAP: ReadonlyMap<SettingKey, SettingDefinition> = new Map(
  SETTINGS_REGISTRY.map((item) => [item.key, item]),
);

// Reverse lookup: category object → category ID string.
const CATEGORY_ID_MAP = new Map<SettingsCategory, SettingsCategoryId>(
  (Object.entries(SETTINGS_CATEGORIES) as [SettingsCategoryId, SettingsCategory][]).map(
    ([id, category]) => [category, id],
  ),
);

// ── Helpers ──────────────────────────────────────────────────

export const resolveCategoryId = (category: SettingsCategory): SettingsCategoryId | undefined => {
  return CATEGORY_ID_MAP.get(category);
};

export const paginateSettingsByCategory = (
  settings: ReadonlyArray<SettingDefinition>,
  category: SettingsCategory,
): SettingDefinition[] => {
  return settings.filter((item) => item.category === category);
};

export const getVisibleCategories = (settings: ReadonlyArray<SettingDefinition>): SettingsCategoryId[] => {
  const presentCategories = new Set(
    settings.map((item) => resolveCategoryId(item.category)).filter((id): id is SettingsCategoryId => id !== undefined),
  );
  return SETTINGS_CATEGORY_IDS.filter(
    (categoryId) => categoryId === 'about' || presentCategories.has(categoryId),
  );
};
