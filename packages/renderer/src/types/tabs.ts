import type { components } from '@cosmosh/api-contract';

export type TabPage = string;

export type TabIconKey = string;
export type TabIconColorKey = components['schemas']['SshVisualColorKey'];

/** Progress states exposed by one terminal tab after pane aggregation. */
export type TerminalTabProgressState = 'none' | 'normal' | 'error' | 'indeterminate' | 'warning';

/** Source selected for the progress indicator rendered in one terminal tab. */
export type TerminalTabProgressSource = 'active-pane' | 'background-attention' | null;

/** Memory-only presentation state derived from all terminal panes in one tab. */
export type TerminalTabPresentation = {
  /** Sanitized title emitted by the active terminal pane through OSC 0/2. */
  applicationTitle: string | null;
  /** Progress state selected by the tab aggregation policy. */
  progressState: TerminalTabProgressState;
  /** Percentage for determinate states, otherwise null. */
  progressValue: number | null;
  /** Whether the selected progress belongs to the active pane or background attention. */
  progressSource: TerminalTabProgressSource;
  /** Whether at least one pane still has unacknowledged Bell attention. */
  bellAttention: boolean;
  /** Pane ids retaining Bell attention, ordered by the tab pane layout. */
  bellAttentionPaneIds: ReadonlyArray<string>;
};

/** Independent title sources retained for terminal-specific title precedence. */
export type TerminalTabTitleSources = {
  /** Static localized fallback associated with the terminal page. */
  defaultTitle: string;
  /** Stable local-terminal or SSH connection identity. */
  connectionTitle: string | null;
  /** Optional explicit user override, reserved for manual rename surfaces. */
  manualTitle: string | null;
};

export type SshTargetSelection = {
  type: 'ssh-server' | 'local-terminal';
  id: string;
};

export type SshResolvedTargetSnapshot =
  | {
      type: 'ssh-server';
      serverId: string;
      serverName: string;
      strictHostKey: boolean;
      enableSshCompression: boolean;
      remoteEnhancementsEnabled: boolean;
      disableCharacterWidthCompatibilityMode: boolean;
      terminalClipboardAccess: components['schemas']['TerminalClipboardAccess'];
      capturedAt: number;
    }
  | {
      type: 'local-terminal';
      profileId: string;
      profileName: string | null;
      capturedAt: number;
    };

export type SshConnectionIntent = {
  intentId: string;
  createdAt: number;
  target: SshTargetSelection | null;
  lastResolvedSnapshot: SshResolvedTargetSnapshot | null;
  startupCommand?: string;
};

export type SftpConnectionIntent = {
  serverId: string;
  serverName: string;
  initialPath?: string;
  createdAt: number;
};

export type HomeState = {
  initialMode?: 'ssh' | 'keychains' | 'portForwarding';
  initialPortForwardRuleId?: string;
};

export type TabItem = {
  id: string;
  title: string;
  page: TabPage;
  iconKey: TabIconKey;
  iconColorKey?: TabIconColorKey;
  closable?: boolean;
  /**
   * Terminal title sources remain separate so untrusted OSC titles never
   * overwrite stable connection identity or a future manual override.
   */
  terminalTitleSources?: TerminalTabTitleSources;
  /**
   * Ephemeral renderer projection used by tab chrome. This value is never
   * stored in terminal session intents or persisted settings.
   */
  terminalPresentation?: TerminalTabPresentation;
  state?: {
    settingsCategory?: string;
    settingsInitialSearch?: string;
    settingsEditorSettingKey?: string;
    sshConnectionIntent?: SshConnectionIntent;
    sftpConnectionIntent?: SftpConnectionIntent;
    home?: HomeState;
  };
};
