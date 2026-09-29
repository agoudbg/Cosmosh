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

/** One nested static command with its literal name, optional description and supported flags. */
export type TerminalCommandSpecSubcommand = {
  name: string;
  descriptionI18nKey?: string;
  subcommands?: TerminalCommandSpecSubcommand[];
  options?: TerminalCommandSpecOption[];
};

/** Imported static command metadata; it never executes Shell code or receives renderer input. */
export type TerminalCommandSpec = {
  command: string;
  descriptionI18nKey?: string;
  subcommands?: TerminalCommandSpecSubcommand[];
  options?: TerminalCommandSpecOption[];
};
