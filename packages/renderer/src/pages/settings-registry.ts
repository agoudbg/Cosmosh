import type { components } from '@cosmosh/api-contract';
import type React from 'react';

export type SettingsCategoryId =
  | 'general'
  | 'account-sync'
  | 'theme'
  | 'terminal'
  | 'connection'
  | 'advanced'
  | 'about';

type SettingControlType = 'select' | 'input' | 'textarea' | 'switch';
type SettingValueType = 'string' | 'number' | 'boolean';

type SettingsValues = components['schemas']['SettingsValues'];

type SettingSelectOption = {
  label: string;
  value: string;
};

export type SettingsCategory = {
  id: SettingsCategoryId;
  label: string;
  searchTerms: string[];
};

export type SettingDefinition = {
  key: keyof SettingsValues;
  valueType: SettingValueType;
  defaultValue: string | number | boolean;
  title: string;
  description?: string;
  categoryId: SettingsCategoryId;
  sectionTitle: string;
  control: SettingControlType;
  path: string;
  commandActionId: string;
  searchTerms: string[];
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  options?: SettingSelectOption[];
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    searchTerms: ['general', 'language', 'locale'],
  },
  {
    id: 'account-sync',
    label: 'Account & Sync',
    searchTerms: ['account', 'sync', 'cloud'],
  },
  {
    id: 'theme',
    label: 'Theme',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    searchTerms: ['terminal', 'orbit bar', 'floating bar', 'search'],
  },
  {
    id: 'connection',
    label: 'Connection',
    searchTerms: ['connection', 'ssh', 'timeout', 'dial'],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    searchTerms: ['advanced', 'editor', 'template', 'autosave'],
  },
  {
    id: 'about',
    label: 'About',
    searchTerms: ['about', 'version', 'scope'],
  },
];

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    key: 'language',
    valueType: 'string',
    defaultValue: 'en',
    title: 'Language',
    description: 'Controls UI language for the renderer and main process.',
    categoryId: 'general',
    sectionTitle: 'Localization',
    control: 'select',
    path: 'general.language',
    commandActionId: 'settings.general.language.set',
    searchTerms: ['language', 'locale', 'ui language', 'english', 'chinese'],
    options: [
      { label: 'English', value: 'en' },
      { label: 'Chinese (Simplified)', value: 'zh-CN' },
    ],
  },
  {
    key: 'accountSyncEnabled',
    valueType: 'boolean',
    defaultValue: false,
    title: 'Account Sync',
    description: 'Controls whether the header Sync Settings action is enabled.',
    categoryId: 'account-sync',
    sectionTitle: 'Synchronization',
    control: 'select',
    path: 'account.sync.enabled',
    commandActionId: 'settings.account.sync.toggle',
    searchTerms: ['sync', 'account sync', 'cloud sync'],
    options: [
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' },
    ],
  },
  {
    key: 'theme',
    valueType: 'string',
    defaultValue: 'dark',
    title: 'Theme',
    description: 'Controls application visual theme.',
    categoryId: 'theme',
    sectionTitle: 'Appearance',
    control: 'select',
    path: 'theme.mode',
    commandActionId: 'settings.theme.mode.set',
    searchTerms: ['theme', 'appearance', 'dark', 'light', 'auto'],
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Auto', value: 'auto' },
    ],
  },
  {
    key: 'sshMaxRows',
    valueType: 'number',
    defaultValue: 10000,
    title: 'SSH Max Rows',
    description: 'Maximum retained terminal lines for SSH sessions.',
    categoryId: 'terminal',
    sectionTitle: 'Runtime',
    control: 'input',
    path: 'terminal.runtime.maxRows',
    commandActionId: 'settings.terminal.runtime.maxRows.set',
    searchTerms: ['ssh', 'max rows', 'terminal lines', 'scrollback', 'terminal'],
    inputMode: 'numeric',
    placeholder: '10000',
  },
  {
    key: 'sshConnectionTimeoutSec',
    valueType: 'number',
    defaultValue: 45,
    title: 'SSH Connection Timeout (sec)',
    description: 'SSH handshake timeout in seconds for session creation.',
    categoryId: 'connection',
    sectionTitle: 'Connection',
    control: 'input',
    path: 'connection.ssh.timeoutSec',
    commandActionId: 'settings.connection.ssh.timeout.set',
    searchTerms: ['ssh', 'timeout', 'connection timeout'],
    inputMode: 'numeric',
    placeholder: '45',
  },
  {
    key: 'autoSaveEnabled',
    valueType: 'boolean',
    defaultValue: true,
    title: 'Auto Save',
    description: 'When enabled, settings changes are saved automatically and the save button is hidden.',
    categoryId: 'advanced',
    sectionTitle: 'Editor Defaults',
    control: 'select',
    path: 'advanced.editor.autoSaveEnabled',
    commandActionId: 'settings.advanced.editor.autoSave.toggle',
    searchTerms: ['auto save', 'autosave', 'save automatically'],
    options: [
      { label: 'Enabled', value: 'true' },
      { label: 'Disabled', value: 'false' },
    ],
  },
  {
    key: 'defaultServerNoteTemplate',
    valueType: 'string',
    defaultValue: '',
    title: 'Default Server Note Template',
    description: 'Template text prefilled in Note when creating a new server profile.',
    categoryId: 'advanced',
    sectionTitle: 'Editor Defaults',
    control: 'textarea',
    path: 'advanced.editor.defaultServerNoteTemplate',
    commandActionId: 'settings.advanced.editor.defaultServerNoteTemplate.set',
    searchTerms: ['template', 'note', 'server note', 'editor defaults'],
    placeholder: 'Example: owner=@ops env=prod',
  },
  {
    key: 'terminalSelectionBarEnabled',
    valueType: 'boolean',
    defaultValue: true,
    title: 'Orbit Bar',
    description: 'Show Orbit Bar when text is selected in terminal sessions.',
    categoryId: 'terminal',
    sectionTitle: 'Orbit Bar',
    control: 'switch',
    path: 'terminal.selection.toolbar.enabled',
    commandActionId: 'settings.terminal.selection.toolbar.toggle',
    searchTerms: ['terminal', 'orbit bar', 'floating bar', 'enable orbit bar'],
  },
  {
    key: 'terminalTextDropMode',
    valueType: 'string',
    defaultValue: 'external',
    title: 'Drag To Terminal',
    description: 'Controls when drag-and-drop text insertion into terminal is enabled.',
    categoryId: 'terminal',
    sectionTitle: 'Runtime',
    control: 'select',
    path: 'terminal.runtime.textDropMode',
    commandActionId: 'settings.terminal.runtime.textDropMode.set',
    searchTerms: ['terminal', 'drag', 'drop', 'text drop', 'external drag'],
    options: [
      { label: 'Off', value: 'off' },
      { label: 'Always Enabled', value: 'always' },
      { label: 'Enable on External Drag', value: 'external' },
    ],
  },
  {
    key: 'terminalSelectionSearchEngine',
    valueType: 'string',
    defaultValue: 'google',
    title: 'Search Engine',
    description: 'Defines the default search engine for quick search actions.',
    categoryId: 'terminal',
    sectionTitle: 'Search',
    control: 'select',
    path: 'ssh.search.searchEngine',
    commandActionId: 'settings.ssh.searchEngine.set',
    searchTerms: ['search engine', 'quick search', 'google', 'bing', 'duckduckgo', 'baidu'],
    options: [
      { label: 'Google', value: 'google' },
      { label: 'Bing', value: 'bing' },
      { label: 'DuckDuckGo', value: 'duckduckgo' },
      { label: 'Baidu', value: 'baidu' },
      { label: 'Custom', value: 'custom' },
    ],
  },
  {
    key: 'terminalSelectionSearchUrlTemplate',
    valueType: 'string',
    defaultValue: '',
    title: 'Custom Search URL',
    description: 'Optional custom URL template for quick search actions. Use %s as placeholder for selected text.',
    categoryId: 'terminal',
    sectionTitle: 'Search',
    control: 'input',
    path: 'ssh.search.searchUrlTemplate',
    commandActionId: 'settings.ssh.searchUrlTemplate.set',
    searchTerms: ['search url', 'template', '%s', 'browser'],
    placeholder: 'https://www.google.com/search?q=%s',
  },
];
