export type TerminalCompletionTrigger = 'typing' | 'manual';

export type TerminalCompletionSource = 'history' | 'inshellisense' | 'runtime';

export type TerminalCompletionItemKind = 'command' | 'subcommand' | 'option' | 'history' | 'path';

export type TerminalPathEntry = {
  name: string;
  kind: 'file' | 'directory';
};

export type TerminalPathCompletionContext = {
  partialPath: string;
  directoriesOnly: boolean;
  fuzzyMatch: boolean;
  limit: number;
};

/**
 * Completion item returned to renderer.
 */
export type TerminalCompletionItem = {
  id: string;
  label: string;
  insertText: string;
  replacePrefixLength?: number;
  detail: string | null;
  detailI18nKey?: string;
  source: TerminalCompletionSource;
  kind: TerminalCompletionItemKind;
  score: number;
};

/**
 * Request payload for completion search in a terminal session.
 */
export type TerminalCompletionRequest = {
  linePrefix: string;
  cursorIndex: number;
  limit?: number;
  fuzzyMatch?: boolean;
  includeHistory?: boolean;
  includeBuiltInCommands?: boolean;
  includePathSuggestions?: boolean;
  trigger: TerminalCompletionTrigger;
};

/**
 * Response payload returned by backend completion engine.
 */
export type TerminalCompletionResponse = {
  replacePrefixLength: number;
  items: TerminalCompletionItem[];
};

/**
 * Shape of imported command metadata from Fig/inshellisense resources.
 */
export type TerminalCommandSpecOption = {
  name: string;
  insertText?: string;
  takesValue?: boolean;
  valueSuggestions?: string[];
  descriptionI18nKey?: string;
};

export type TerminalCommandSpecSubcommand = {
  name: string;
  descriptionI18nKey?: string;
  subcommands?: TerminalCommandSpecSubcommand[];
  options?: TerminalCommandSpecOption[];
};

export type TerminalCommandSpec = {
  command: string;
  descriptionI18nKey?: string;
  subcommands?: TerminalCommandSpecSubcommand[];
  options?: TerminalCommandSpecOption[];
};
