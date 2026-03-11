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
  terminalAltClickMovesCursor: boolean;
  terminalCursorBlink: boolean;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalCursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  terminalCursorStyle: 'block' | 'underline' | 'bar';
  terminalCursorWidth: string;
  terminalCustomGlyphs: boolean;
  terminalFontWeight: string;
  terminalFontWeightBold: string;
  terminalLetterSpacing: number;
  terminalLineHeight: string;
  sshMaxRows: number;
  sshConnectionTimeoutSec: number;
  terminalDrawBoldTextInBrightColors: boolean;
  terminalScrollSensitivity: string;
  terminalFastScrollSensitivity: string;
  terminalMinimumContrastRatio: string;
  terminalScreenReaderMode: boolean;
  terminalScrollOnUserInput: boolean;
  terminalSmoothScrollDuration: number;
  terminalTabStopWidth: number;
  devToolsEnabled: boolean;
  autoSaveEnabled: boolean;
  accountSyncEnabled: boolean;
  defaultServerNoteTemplate: string;
  terminalSelectionBarEnabled: boolean;
  terminalTextDropMode: 'off' | 'always' | 'external';
  terminalContextLaunchBehavior: 'openDefaultLocalTerminal' | 'openLocalTerminalList' | 'off';
  defaultLocalTerminalProfile: string;
  terminalSelectionSearchEngine: 'google' | 'bing' | 'duckduckgo' | 'baidu' | 'custom';
  terminalSelectionSearchUrlTemplate: string;
  terminalAutoCompleteEnabled: boolean;
  terminalAutoCompleteHistoryEnabled: boolean;
  terminalAutoCompleteBuiltInCommandsEnabled: boolean;
  terminalAutoCompletePathEnabled: boolean;
  terminalAutoCompletePasswordEnabled: boolean;
  terminalAutoCompleteMinChars: number;
  terminalAutoCompleteMaxItems: number;
  terminalAutoCompleteFuzzyMatch: boolean;
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
      sshStyle: { labelI18nKey: 'settings.sections.sshStyle' },
      advancedStyle: { labelI18nKey: 'settings.sections.advancedStyle' },
    },
  },
  terminal: {
    labelI18nKey: 'settings.categories.terminal',
    sections: {
      terminalSelection: { labelI18nKey: 'settings.sections.terminalSelection' },
      search: { labelI18nKey: 'settings.sections.search' },
      runtime: { labelI18nKey: 'settings.sections.runtime' },
      autoComplete: { labelI18nKey: 'settings.sections.autoComplete' },
      advancedTerminal: { labelI18nKey: 'settings.sections.advancedTerminal' },
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

type SettingDefinitionBase = {
  key: SettingKey;
  valueType: SettingValueType;
  defaultValue: string | number | boolean;
  nameI18nKey: string;
  descriptionI18nKey: string;
  category: SettingsCategory;
  section: SettingsSection;
  path: string;
  commandActionId: string;
  searchTerms: string[];
  inputMode?: 'text' | 'none' | 'search' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal';
  min?: number;
  max?: number;
  maxLength?: number;
};

type SelectSettingDefinition = SettingDefinitionBase & {
  control: 'select';
  optionI18nNamespace?: string;
  options?: SettingSelectOption[];
  placeholderI18nKey?: never;
};

type InputLikeSettingDefinition = SettingDefinitionBase & {
  control: 'input' | 'textarea';
  placeholderI18nKey?: string;
  optionI18nNamespace?: never;
  options?: never;
};

type SwitchSettingDefinition = SettingDefinitionBase & {
  control: 'switch';
  optionI18nNamespace?: never;
  options?: never;
  placeholderI18nKey?: never;
};

export type SettingDefinition = SelectSettingDefinition | InputLikeSettingDefinition | SwitchSettingDefinition;

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
    key: 'terminalAltClickMovesCursor',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAltClickMovesCursor.title',
    descriptionI18nKey: 'settings.items.terminalAltClickMovesCursor.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'switch',
    path: 'theme.ssh.altClickMovesCursor',
    commandActionId: 'settings.theme.ssh.altClickMovesCursor.toggle',
    searchTerms: ['terminal', 'alt click', 'cursor', 'ssh style'],
  },
  {
    key: 'terminalCursorBlink',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCursorBlink.title',
    descriptionI18nKey: 'settings.items.terminalCursorBlink.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'switch',
    path: 'theme.ssh.cursorBlink',
    commandActionId: 'settings.theme.ssh.cursorBlink.toggle',
    searchTerms: ['terminal', 'cursor', 'blink', 'ssh style'],
  },
  {
    key: 'terminalFontFamily',
    valueType: 'string',
    defaultValue:
      'monospace, Consolas, "JetBrains Mono", "Liberation Mono", "Microsoft YaHei", "SFMono-Regular", "PingFang SC"',
    nameI18nKey: 'settings.items.terminalFontFamily.title',
    descriptionI18nKey: 'settings.items.terminalFontFamily.description',
    placeholderI18nKey: 'settings.items.terminalFontFamily.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'input',
    path: 'theme.ssh.fontFamily',
    commandActionId: 'settings.theme.ssh.fontFamily.set',
    searchTerms: ['terminal', 'font family', 'yahei', 'pingfang', 'consolas'],
    maxLength: 1000,
  },
  {
    key: 'terminalFontSize',
    valueType: 'number',
    defaultValue: 15,
    nameI18nKey: 'settings.items.terminalFontSize.title',
    descriptionI18nKey: 'settings.items.terminalFontSize.description',
    placeholderI18nKey: 'settings.items.terminalFontSize.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.sshStyle,
    control: 'input',
    path: 'theme.ssh.fontSize',
    commandActionId: 'settings.theme.ssh.fontSize.set',
    searchTerms: ['terminal', 'font size', 'ssh style'],
    inputMode: 'numeric',
    min: 9,
    max: 36,
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
    key: 'terminalCursorInactiveStyle',
    valueType: 'string',
    defaultValue: 'outline',
    nameI18nKey: 'settings.items.terminalCursorInactiveStyle.title',
    descriptionI18nKey: 'settings.items.terminalCursorInactiveStyle.description',
    optionI18nNamespace: 'terminalCursorInactiveStyle',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'select',
    path: 'theme.ssh.advanced.cursorInactiveStyle',
    commandActionId: 'settings.theme.ssh.advanced.cursorInactiveStyle.set',
    searchTerms: ['terminal', 'cursor', 'inactive', 'advanced style'],
    options: [
      { value: 'outline' },
      { value: 'block' },
      { value: 'bar' },
      { value: 'underline' },
      { value: 'none' },
    ],
  },
  {
    key: 'terminalCursorStyle',
    valueType: 'string',
    defaultValue: 'block',
    nameI18nKey: 'settings.items.terminalCursorStyle.title',
    descriptionI18nKey: 'settings.items.terminalCursorStyle.description',
    optionI18nNamespace: 'terminalCursorStyle',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'select',
    path: 'theme.ssh.advanced.cursorStyle',
    commandActionId: 'settings.theme.ssh.advanced.cursorStyle.set',
    searchTerms: ['terminal', 'cursor', 'style', 'advanced style'],
    options: [{ value: 'block' }, { value: 'underline' }, { value: 'bar' }],
  },
  {
    key: 'terminalCursorWidth',
    valueType: 'string',
    defaultValue: '',
    nameI18nKey: 'settings.items.terminalCursorWidth.title',
    descriptionI18nKey: 'settings.items.terminalCursorWidth.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.cursorWidth',
    commandActionId: 'settings.theme.ssh.advanced.cursorWidth.set',
    searchTerms: ['terminal', 'cursor', 'width', 'advanced style'],
    inputMode: 'numeric',
    maxLength: 8,
  },
  {
    key: 'terminalCustomGlyphs',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalCustomGlyphs.title',
    descriptionI18nKey: 'settings.items.terminalCustomGlyphs.description',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'switch',
    path: 'theme.ssh.advanced.customGlyphs',
    commandActionId: 'settings.theme.ssh.advanced.customGlyphs.toggle',
    searchTerms: ['terminal', 'custom glyphs', 'advanced style'],
  },
  {
    key: 'terminalFontWeight',
    valueType: 'string',
    defaultValue: 'normal',
    nameI18nKey: 'settings.items.terminalFontWeight.title',
    descriptionI18nKey: 'settings.items.terminalFontWeight.description',
    placeholderI18nKey: 'settings.items.terminalFontWeight.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.fontWeight',
    commandActionId: 'settings.theme.ssh.advanced.fontWeight.set',
    searchTerms: ['terminal', 'font weight', 'advanced style'],
    maxLength: 16,
  },
  {
    key: 'terminalFontWeightBold',
    valueType: 'string',
    defaultValue: 'bold',
    nameI18nKey: 'settings.items.terminalFontWeightBold.title',
    descriptionI18nKey: 'settings.items.terminalFontWeightBold.description',
    placeholderI18nKey: 'settings.items.terminalFontWeightBold.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.fontWeightBold',
    commandActionId: 'settings.theme.ssh.advanced.fontWeightBold.set',
    searchTerms: ['terminal', 'font weight bold', 'advanced style'],
    maxLength: 16,
  },
  {
    key: 'terminalLetterSpacing',
    valueType: 'number',
    defaultValue: 0,
    nameI18nKey: 'settings.items.terminalLetterSpacing.title',
    descriptionI18nKey: 'settings.items.terminalLetterSpacing.description',
    placeholderI18nKey: 'settings.items.terminalLetterSpacing.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.letterSpacing',
    commandActionId: 'settings.theme.ssh.advanced.letterSpacing.set',
    searchTerms: ['terminal', 'letter spacing', 'advanced style'],
    inputMode: 'numeric',
    min: -5,
    max: 20,
  },
  {
    key: 'terminalLineHeight',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalLineHeight.title',
    descriptionI18nKey: 'settings.items.terminalLineHeight.description',
    placeholderI18nKey: 'settings.items.terminalLineHeight.placeholder',
    category: SETTINGS_CATEGORIES.theme,
    section: SETTINGS_CATEGORIES.theme.sections.advancedStyle,
    control: 'input',
    path: 'theme.ssh.advanced.lineHeight',
    commandActionId: 'settings.theme.ssh.advanced.lineHeight.set',
    searchTerms: ['terminal', 'line height', 'advanced style'],
    inputMode: 'decimal',
    maxLength: 16,
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
    key: 'terminalContextLaunchBehavior',
    valueType: 'string',
    defaultValue: 'openDefaultLocalTerminal',
    nameI18nKey: 'settings.items.terminalContextLaunchBehavior.title',
    descriptionI18nKey: 'settings.items.terminalContextLaunchBehavior.description',
    optionI18nNamespace: 'terminalContextLaunchBehavior',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.contextLaunchBehavior',
    commandActionId: 'settings.terminal.runtime.contextLaunchBehavior.set',
    searchTerms: ['terminal', 'context menu', 'open in cosmosh', 'working directory', 'startup launch'],
    options: [
      { value: 'openDefaultLocalTerminal' },
      { value: 'openLocalTerminalList' },
      { value: 'off' },
    ],
  },
  {
    key: 'defaultLocalTerminalProfile',
    valueType: 'string',
    defaultValue: 'auto',
    nameI18nKey: 'settings.items.defaultLocalTerminalProfile.title',
    descriptionI18nKey: 'settings.items.defaultLocalTerminalProfile.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.runtime,
    control: 'select',
    path: 'terminal.runtime.defaultLocalTerminalProfile',
    commandActionId: 'settings.terminal.runtime.defaultLocalTerminalProfile.set',
    searchTerms: ['terminal', 'default profile', 'powershell', 'cmd', 'wsl'],
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
  {
    key: 'terminalAutoCompleteEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'auto complete', 'command suggestions'],
  },
  {
    key: 'terminalAutoCompleteHistoryEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteHistoryEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteHistoryEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.history.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.history.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'history', 'recent commands'],
  },
  {
    key: 'terminalAutoCompleteBuiltInCommandsEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteBuiltInCommandsEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteBuiltInCommandsEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.builtinCommands.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.builtinCommands.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'builtin commands', 'command spec'],
  },
  {
    key: 'terminalAutoCompletePathEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompletePathEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompletePathEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.path.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.path.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'path', 'directory', 'file'],
  },
  {
    key: 'terminalAutoCompletePasswordEnabled',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompletePasswordEnabled.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompletePasswordEnabled.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.runtime.autoComplete.password.enabled',
    commandActionId: 'settings.terminal.runtime.autoComplete.password.enabled.toggle',
    searchTerms: ['terminal', 'autocomplete', 'password', 'secret fill'],
  },
  {
    key: 'terminalAutoCompleteMinChars',
    valueType: 'number',
    defaultValue: 1,
    nameI18nKey: 'settings.items.terminalAutoCompleteMinChars.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteMinChars.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'input',
    path: 'terminal.runtime.autoComplete.minChars',
    commandActionId: 'settings.terminal.runtime.autoComplete.minChars.set',
    searchTerms: ['terminal', 'autocomplete', 'minimum chars', 'trigger'],
    inputMode: 'numeric',
    min: 1,
    max: 8,
  },
  {
    key: 'terminalAutoCompleteMaxItems',
    valueType: 'number',
    defaultValue: 8,
    nameI18nKey: 'settings.items.terminalAutoCompleteMaxItems.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteMaxItems.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'input',
    path: 'terminal.runtime.autoComplete.maxItems',
    commandActionId: 'settings.terminal.runtime.autoComplete.maxItems.set',
    searchTerms: ['terminal', 'autocomplete', 'max items', 'suggestions limit'],
    inputMode: 'numeric',
    min: 3,
    max: 20,
  },
  {
    key: 'terminalAutoCompleteFuzzyMatch',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalAutoCompleteFuzzyMatch.title',
    descriptionI18nKey: 'settings.items.terminalAutoCompleteFuzzyMatch.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.autoComplete,
    control: 'switch',
    path: 'terminal.advanced.autoComplete.fuzzyMatch',
    commandActionId: 'settings.terminal.advanced.autoComplete.fuzzyMatch.toggle',
    searchTerms: ['terminal', 'autocomplete', 'fuzzy', 'fuzzy match'],
  },
  {
    key: 'terminalDrawBoldTextInBrightColors',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalDrawBoldTextInBrightColors.title',
    descriptionI18nKey: 'settings.items.terminalDrawBoldTextInBrightColors.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.drawBoldTextInBrightColors',
    commandActionId: 'settings.terminal.advanced.drawBoldTextInBrightColors.toggle',
    searchTerms: ['terminal', 'bold', 'bright colors', 'advanced terminal'],
  },
  {
    key: 'terminalScrollSensitivity',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalScrollSensitivity.title',
    descriptionI18nKey: 'settings.items.terminalScrollSensitivity.description',
    placeholderI18nKey: 'settings.items.terminalScrollSensitivity.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.scrollSensitivity',
    commandActionId: 'settings.terminal.advanced.scrollSensitivity.set',
    searchTerms: ['terminal', 'scroll sensitivity', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalFastScrollSensitivity',
    valueType: 'string',
    defaultValue: '5',
    nameI18nKey: 'settings.items.terminalFastScrollSensitivity.title',
    descriptionI18nKey: 'settings.items.terminalFastScrollSensitivity.description',
    placeholderI18nKey: 'settings.items.terminalFastScrollSensitivity.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.fastScrollSensitivity',
    commandActionId: 'settings.terminal.advanced.fastScrollSensitivity.set',
    searchTerms: ['terminal', 'fast scroll', 'sensitivity', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalMinimumContrastRatio',
    valueType: 'string',
    defaultValue: '1',
    nameI18nKey: 'settings.items.terminalMinimumContrastRatio.title',
    descriptionI18nKey: 'settings.items.terminalMinimumContrastRatio.description',
    placeholderI18nKey: 'settings.items.terminalMinimumContrastRatio.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.minimumContrastRatio',
    commandActionId: 'settings.terminal.advanced.minimumContrastRatio.set',
    searchTerms: ['terminal', 'contrast ratio', 'advanced terminal'],
    inputMode: 'decimal',
    maxLength: 16,
  },
  {
    key: 'terminalScreenReaderMode',
    valueType: 'boolean',
    defaultValue: false,
    nameI18nKey: 'settings.items.terminalScreenReaderMode.title',
    descriptionI18nKey: 'settings.items.terminalScreenReaderMode.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.screenReaderMode',
    commandActionId: 'settings.terminal.advanced.screenReaderMode.toggle',
    searchTerms: ['terminal', 'screen reader', 'accessibility', 'advanced terminal'],
  },
  {
    key: 'terminalScrollOnUserInput',
    valueType: 'boolean',
    defaultValue: true,
    nameI18nKey: 'settings.items.terminalScrollOnUserInput.title',
    descriptionI18nKey: 'settings.items.terminalScrollOnUserInput.description',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'switch',
    path: 'terminal.advanced.scrollOnUserInput',
    commandActionId: 'settings.terminal.advanced.scrollOnUserInput.toggle',
    searchTerms: ['terminal', 'scroll on user input', 'advanced terminal'],
  },
  {
    key: 'terminalSmoothScrollDuration',
    valueType: 'number',
    defaultValue: 0,
    nameI18nKey: 'settings.items.terminalSmoothScrollDuration.title',
    descriptionI18nKey: 'settings.items.terminalSmoothScrollDuration.description',
    placeholderI18nKey: 'settings.items.terminalSmoothScrollDuration.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.smoothScrollDuration',
    commandActionId: 'settings.terminal.advanced.smoothScrollDuration.set',
    searchTerms: ['terminal', 'smooth scroll duration', 'advanced terminal'],
    inputMode: 'numeric',
    min: 0,
    max: 2000,
  },
  {
    key: 'terminalTabStopWidth',
    valueType: 'number',
    defaultValue: 8,
    nameI18nKey: 'settings.items.terminalTabStopWidth.title',
    descriptionI18nKey: 'settings.items.terminalTabStopWidth.description',
    placeholderI18nKey: 'settings.items.terminalTabStopWidth.placeholder',
    category: SETTINGS_CATEGORIES.terminal,
    section: SETTINGS_CATEGORIES.terminal.sections.advancedTerminal,
    control: 'input',
    path: 'terminal.advanced.tabStopWidth',
    commandActionId: 'settings.terminal.advanced.tabStopWidth.set',
    searchTerms: ['terminal', 'tab stop width', 'advanced terminal'],
    inputMode: 'numeric',
    min: 1,
    max: 16,
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
