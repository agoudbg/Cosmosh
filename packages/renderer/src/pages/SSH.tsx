import '@xterm/xterm/css/xterm.css';

import type { components, SettingsValues } from '@cosmosh/api-contract';
import { FitAddon } from '@xterm/addon-fit';
import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import classNames from 'classnames';
import { ArrowUpDown, Cpu, MemoryStick, RefreshCw, Search, Send, Sparkles } from 'lucide-react';
import React from 'react';

import { TerminalContextMenu } from '../components/terminal/terminal-context-menu';
import { TerminalSelectionBar } from '../components/terminal/terminal-selection-bar';
import { TerminalTextDropZone } from '../components/terminal/terminal-text-drop-zone';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Menubar } from '../components/ui/menubar';
import {
  closeLocalTerminalSession,
  closeSshSession,
  createLocalTerminalSession,
  createSshSession,
  listLocalTerminalProfiles,
  listSshServers,
  trustSshFingerprint,
} from '../lib/backend';
import { t } from '../lib/i18n';
import { useSettingsValues } from '../lib/settings-store';
import { getActiveSshServerId, parseTerminalTarget } from '../lib/ssh-target';
import { useToast } from '../lib/toast-context';
import { useTerminalTextDropZone } from '../lib/use-terminal-text-drop-zone';

type SshServerListItem = components['schemas']['SshServerListItem'];

type ClientOutboundMessage =
  | {
      type: 'input';
      data: string;
    }
  | {
      type: 'resize';
      cols: number;
      rows: number;
    }
  | {
      type: 'close';
    }
  | {
      type: 'ping';
    };

type ServerInboundMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'output';
      data: string;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'exit';
      reason: string;
    }
  | {
      type: 'pong';
    }
  | {
      type: 'telemetry';
      cpuUsagePercent: number | null;
      memoryUsedBytes: number | null;
      memoryTotalBytes: number | null;
      networkRxBytesPerSec: number | null;
      networkTxBytesPerSec: number | null;
      recentCommands: string[];
    };

type SshTelemetryState = {
  cpuUsagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  recentCommands: string[];
};

type HostFingerprintPrompt = {
  serverId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};

const DEFAULT_TELEMETRY_STATE: SshTelemetryState = {
  cpuUsagePercent: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  networkRxBytesPerSec: null,
  networkTxBytesPerSec: null,
  recentCommands: [],
};

const formatCompactBytes = (value: number): string => {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const units = ['B', 'K', 'M', 'G', 'T'];
  let scaled = safeValue;
  let unitIndex = 0;

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(scaled)}${units[unitIndex]}`;
  }

  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${units[unitIndex]}`;
};

const formatCpuPercent = (value: number | null): string => {
  if (value === null) {
    return 'N/A';
  }

  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `${safeValue.toFixed(1)}%`;
};

const formatMemoryUsage = (usedBytes: number | null, totalBytes: number | null): string => {
  if (usedBytes === null || totalBytes === null) {
    return 'N/A';
  }

  return `${formatCompactBytes(usedBytes)}/${formatCompactBytes(totalBytes)}`;
};

const formatTrafficRate = (bytesPerSecond: number | null): string => {
  if (bytesPerSecond === null) {
    return 'N/A';
  }

  return formatCompactBytes(bytesPerSecond);
};

const sendClientMessage = (socket: WebSocket, payload: ClientOutboundMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
};

type ResolvedTerminalTarget =
  | {
      type: 'ssh-server';
      server: SshServerListItem;
    }
  | {
      type: 'local-terminal';
      profileId: string;
      profileName: string | null;
    };

const resolveLocalTerminalProfileName = async (profileId: string): Promise<string | null> => {
  try {
    const response = await listLocalTerminalProfiles();
    const profile = response.data.items.find((item) => item.id === profileId);
    if (!profile?.name) {
      return null;
    }

    return profile.name;
  } catch {
    return null;
  }
};

const resolveTerminalTarget = async (): Promise<ResolvedTerminalTarget> => {
  const activeTarget = parseTerminalTarget(getActiveSshServerId());
  if (activeTarget?.type === 'local-terminal') {
    const profileName = await resolveLocalTerminalProfileName(activeTarget.id);
    return {
      type: 'local-terminal',
      profileId: activeTarget.id,
      profileName,
    };
  }

  const serverResponse = await listSshServers();
  const servers = serverResponse.data.items;

  if (servers.length === 0) {
    throw new Error('No SSH server is configured yet.');
  }

  const preferredTarget = parseTerminalTarget(getActiveSshServerId());
  const preferredServerId = preferredTarget?.type === 'ssh-server' ? preferredTarget.id : null;
  if (preferredServerId) {
    const preferredServer = servers.find((item) => item.id === preferredServerId);
    if (preferredServer) {
      return {
        type: 'ssh-server',
        server: preferredServer,
      };
    }
  }

  return {
    type: 'ssh-server',
    server: servers[0],
  };
};

type TerminalSelectionAnchor = {
  selectionText: string;
  pointerClientX: number | null;
  anchorLeft: number;
  anchorRight: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
};

type TerminalSelectionBarPosition = {
  top: number;
  left: number;
};

type TerminalSelectionSettings = {
  enabled: boolean;
  searchEngine: SettingsValues['terminalSelectionSearchEngine'];
  searchUrlTemplate: string;
};

type TerminalSelectionBounds = Pick<
  TerminalSelectionAnchor,
  'anchorLeft' | 'anchorRight' | 'top' | 'left' | 'right' | 'bottom'
>;

const INTERNAL_TERMINAL_TEXT_DRAG_MIME = 'application/x-cosmosh-terminal-text';

const SEARCH_URL_BY_ENGINE: Partial<Record<TerminalSelectionSettings['searchEngine'], string>> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

const resolveSearchTemplate = (template: string, encodedQuery: string): string => {
  if (template.includes('%s')) {
    return template.replaceAll('%s', encodedQuery);
  }

  if (template.includes('QUERY_TOKEN')) {
    return template.replaceAll('QUERY_TOKEN', encodedQuery);
  }

  return `${template}${encodedQuery}`;
};

const tryResolveCustomSearchUrl = (searchUrlTemplate: string, encodedQuery: string): string | null => {
  const normalizedTemplate = searchUrlTemplate.trim();
  if (normalizedTemplate.length === 0) {
    return null;
  }

  const resolvedTemplate = resolveSearchTemplate(normalizedTemplate, encodedQuery);

  try {
    const parsedCustomUrl = new URL(resolvedTemplate);
    if (parsedCustomUrl.protocol === 'http:' || parsedCustomUrl.protocol === 'https:') {
      return parsedCustomUrl.toString();
    }
  } catch {
    // Ignore invalid custom templates and fallback to configured search engine.
  }

  return null;
};

const resolveSearchUrl = (
  engine: TerminalSelectionSettings['searchEngine'],
  query: string,
  searchUrlTemplate: string,
): string => {
  const encodedQuery = encodeURIComponent(query.trim());

  if (engine === 'custom') {
    const customUrl = tryResolveCustomSearchUrl(searchUrlTemplate, encodedQuery);
    if (customUrl) {
      return customUrl;
    }
  }

  const baseUrl = SEARCH_URL_BY_ENGINE[engine] ?? SEARCH_URL_BY_ENGINE.google;
  return `${baseUrl}${encodedQuery}`;
};

const parseOptionalNumberSetting = (
  value: string,
  constraints?: { min?: number; max?: number },
): number | undefined => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return undefined;
  }

  const parsedValue = Number(normalizedValue);
  if (!Number.isFinite(parsedValue)) {
    return undefined;
  }

  if (constraints?.min !== undefined && parsedValue < constraints.min) {
    return undefined;
  }

  if (constraints?.max !== undefined && parsedValue > constraints.max) {
    return undefined;
  }

  return parsedValue;
};

const resolveTerminalFontWeightSetting = (
  value: string,
  fallback: NonNullable<ITerminalOptions['fontWeight']>,
): ITerminalOptions['fontWeight'] => {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return fallback;
  }

  if (/^\d+$/.test(normalizedValue)) {
    return Number(normalizedValue);
  }

  const literalWeightValues: Array<Exclude<NonNullable<ITerminalOptions['fontWeight']>, number>> = [
    'normal',
    'bold',
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
  ];

  return literalWeightValues.includes(normalizedValue as (typeof literalWeightValues)[number])
    ? (normalizedValue as (typeof literalWeightValues)[number])
    : fallback;
};

type SSHProps = {
  onTabTitleChange?: (title: string) => void;
};

const SSH: React.FC<SSHProps> = ({ onTabTitleChange }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const settingsValues = useSettingsValues();
  const onTabTitleChangeRef = React.useRef<SSHProps['onTabTitleChange']>(onTabTitleChange);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const terminalContainerRef = React.useRef<HTMLDivElement | null>(null);
  const selectionPointerClientXRef = React.useRef<number | null>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const selectionBarRef = React.useRef<HTMLDivElement | null>(null);
  const connectSessionRef = React.useRef<(() => void) | null>(null);
  const fingerprintPromptResolverRef = React.useRef<((accepted: boolean) => void) | null>(null);
  const [connectionState, setConnectionState] = React.useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connectionError, setConnectionError] = React.useState<string>('');
  const [telemetryState, setTelemetryState] = React.useState<SshTelemetryState>(DEFAULT_TELEMETRY_STATE);
  const [hostFingerprintPrompt, setHostFingerprintPrompt] = React.useState<HostFingerprintPrompt | null>(null);
  const [selectionAnchor, setSelectionAnchor] = React.useState<TerminalSelectionAnchor | null>(null);
  const [selectionBarPosition, setSelectionBarPosition] = React.useState<TerminalSelectionBarPosition | null>(null);
  const [dismissedSelectionText, setDismissedSelectionText] = React.useState<string | null>(null);

  // Derive terminal-relevant settings from the centralized store.
  const sshMaxRows = settingsValues.sshMaxRows;
  const sshConnectionTimeoutSec = settingsValues.sshConnectionTimeoutSec;
  const terminalTextDropMode = settingsValues.terminalTextDropMode;
  const terminalInitOptions = React.useMemo<ITerminalOptions>(() => {
    const terminalBackground =
      getComputedStyle(document.documentElement).getPropertyValue('--color-ssh-card-bg-terminal').trim() || '#000000';
    const cursorWidth = parseOptionalNumberSetting(settingsValues.terminalCursorWidth, { min: 1, max: 32 });
    const lineHeight = parseOptionalNumberSetting(settingsValues.terminalLineHeight, { min: 0.5, max: 3 });
    const scrollSensitivity = parseOptionalNumberSetting(settingsValues.terminalScrollSensitivity, {
      min: 0.1,
      max: 50,
    });
    const fastScrollSensitivity = parseOptionalNumberSetting(settingsValues.terminalFastScrollSensitivity, {
      min: 0.1,
      max: 200,
    });
    const minimumContrastRatio = parseOptionalNumberSetting(settingsValues.terminalMinimumContrastRatio, {
      min: 1,
      max: 21,
    });

    return {
      convertEol: true,
      altClickMovesCursor: settingsValues.terminalAltClickMovesCursor,
      cursorBlink: settingsValues.terminalCursorBlink,
      cursorInactiveStyle: settingsValues.terminalCursorInactiveStyle,
      cursorStyle: settingsValues.terminalCursorStyle,
      cursorWidth,
      customGlyphs: settingsValues.terminalCustomGlyphs,
      drawBoldTextInBrightColors: settingsValues.terminalDrawBoldTextInBrightColors,
      fastScrollSensitivity,
      fontFamily: settingsValues.terminalFontFamily,
      fontSize: settingsValues.terminalFontSize,
      fontWeight: resolveTerminalFontWeightSetting(settingsValues.terminalFontWeight, 'normal'),
      fontWeightBold: resolveTerminalFontWeightSetting(settingsValues.terminalFontWeightBold, 'bold'),
      letterSpacing: settingsValues.terminalLetterSpacing,
      lineHeight: lineHeight ?? 1,
      minimumContrastRatio,
      reflowCursorLine: true,
      screenReaderMode: settingsValues.terminalScreenReaderMode,
      scrollback: sshMaxRows,
      scrollOnUserInput: settingsValues.terminalScrollOnUserInput,
      scrollSensitivity,
      smoothScrollDuration: settingsValues.terminalSmoothScrollDuration,
      tabStopWidth: settingsValues.terminalTabStopWidth,
      theme: {
        background: terminalBackground,
      },
    };
  }, [
    settingsValues.terminalAltClickMovesCursor,
    settingsValues.terminalCursorBlink,
    settingsValues.terminalCursorInactiveStyle,
    settingsValues.terminalCursorStyle,
    settingsValues.terminalCursorWidth,
    settingsValues.terminalCustomGlyphs,
    settingsValues.terminalDrawBoldTextInBrightColors,
    settingsValues.terminalFastScrollSensitivity,
    settingsValues.terminalFontFamily,
    settingsValues.terminalFontSize,
    settingsValues.terminalFontWeight,
    settingsValues.terminalFontWeightBold,
    settingsValues.terminalLetterSpacing,
    settingsValues.terminalLineHeight,
    settingsValues.terminalMinimumContrastRatio,
    settingsValues.terminalScreenReaderMode,
    settingsValues.terminalScrollOnUserInput,
    settingsValues.terminalScrollSensitivity,
    settingsValues.terminalSmoothScrollDuration,
    settingsValues.terminalTabStopWidth,
    sshMaxRows,
  ]);
  const terminalSelectionSettings: TerminalSelectionSettings = React.useMemo(
    () => ({
      enabled: settingsValues.terminalSelectionBarEnabled,
      searchEngine: settingsValues.terminalSelectionSearchEngine,
      searchUrlTemplate: settingsValues.terminalSelectionSearchUrlTemplate,
    }),
    [
      settingsValues.terminalSelectionBarEnabled,
      settingsValues.terminalSelectionSearchEngine,
      settingsValues.terminalSelectionSearchUrlTemplate,
    ],
  );

  React.useEffect(() => {
    onTabTitleChangeRef.current = onTabTitleChange;
  }, [onTabTitleChange]);

  const resolveHostFingerprintPrompt = React.useCallback((accepted: boolean) => {
    const resolver = fingerprintPromptResolverRef.current;
    fingerprintPromptResolverRef.current = null;
    setHostFingerprintPrompt(null);
    resolver?.(accepted);
  }, []);

  const requestHostFingerprintTrust = React.useCallback((prompt: HostFingerprintPrompt): Promise<boolean> => {
    return new Promise((resolve) => {
      fingerprintPromptResolverRef.current = resolve;
      setHostFingerprintPrompt(prompt);
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (fingerprintPromptResolverRef.current) {
        fingerprintPromptResolverRef.current(false);
        fingerprintPromptResolverRef.current = null;
      }
    };
  }, []);

  const handleRetry = React.useCallback(() => {
    if (connectionState === 'connecting' || connectionState === 'connected') {
      return;
    }

    connectSessionRef.current?.();
  }, [connectionState]);

  const resolveSelectionBounds = React.useCallback((): TerminalSelectionBounds | null => {
    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      return null;
    }

    const selectionLayer = containerElement.querySelector('.xterm-selection');
    if (!selectionLayer) {
      return null;
    }

    const selectionBlocks = selectionLayer.querySelectorAll('div');
    if (selectionBlocks.length === 0) {
      return null;
    }

    let top = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let anchorLeft = Number.POSITIVE_INFINITY;
    let anchorRight = Number.NEGATIVE_INFINITY;

    selectionBlocks.forEach((block) => {
      const rect = block.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      if (rect.top < top - 0.5) {
        top = rect.top;
        anchorLeft = rect.left;
      } else if (Math.abs(rect.top - top) <= 0.5) {
        anchorLeft = Math.min(anchorLeft, rect.left);
      }

      if (rect.bottom > bottom + 0.5) {
        bottom = rect.bottom;
        anchorRight = rect.right;
      } else if (Math.abs(rect.bottom - bottom) <= 0.5) {
        anchorRight = Math.max(anchorRight, rect.right);
      }

      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    });

    if (
      !Number.isFinite(top) ||
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom) ||
      !Number.isFinite(anchorLeft) ||
      !Number.isFinite(anchorRight)
    ) {
      return null;
    }

    return {
      anchorLeft,
      anchorRight,
      top,
      left,
      right,
      bottom,
    };
  }, []);

  const refreshSelectionAnchor = React.useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setSelectionAnchor(null);
      return;
    }

    const selectionText = terminal.getSelection();
    const normalizedText = selectionText.trim();
    if (normalizedText.length === 0) {
      setSelectionAnchor(null);
      return;
    }

    const bounds = resolveSelectionBounds();
    if (!bounds) {
      setSelectionAnchor(null);
      return;
    }

    setSelectionAnchor({
      selectionText,
      ...bounds,
      pointerClientX: selectionPointerClientXRef.current,
    });
  }, [resolveSelectionBounds]);

  React.useLayoutEffect(() => {
    if (
      !selectionAnchor ||
      !terminalSelectionSettings.enabled ||
      dismissedSelectionText === selectionAnchor.selectionText
    ) {
      setSelectionBarPosition(null);
      return;
    }

    const wrapperElement = wrapperRef.current;
    const selectionBarElement = selectionBarRef.current;
    if (!wrapperElement) {
      return;
    }

    const terminalBoundsElement = terminalContainerRef.current;

    const wrapperRect = wrapperElement.getBoundingClientRect();
    const placementBoundsRect = terminalBoundsElement?.getBoundingClientRect() ?? wrapperRect;
    const barWidth = selectionBarElement?.offsetWidth ?? 320;
    const barHeight = selectionBarElement?.offsetHeight ?? 42;
    const edgePadding = 8;
    const gap = 8;

    const selectionTop = selectionAnchor.top - wrapperRect.top;
    const selectionBottom = selectionAnchor.bottom - wrapperRect.top;
    const selectionLeft = selectionAnchor.anchorLeft - wrapperRect.left;
    const pointerBasedRight =
      selectionAnchor.pointerClientX !== null &&
      selectionAnchor.pointerClientX >= selectionAnchor.left &&
      selectionAnchor.pointerClientX <= selectionAnchor.right
        ? selectionAnchor.pointerClientX
        : null;
    const selectionRight = (pointerBasedRight ?? selectionAnchor.anchorRight) - wrapperRect.left;
    const boundsTop = placementBoundsRect.top - wrapperRect.top;
    const boundsBottom = placementBoundsRect.bottom - wrapperRect.top;

    const canPlaceAbove = selectionTop - gap - barHeight >= boundsTop + edgePadding;
    const canPlaceBelow = selectionBottom + gap + barHeight <= boundsBottom - edgePadding;
    const horizontalPadding = canPlaceAbove ? edgePadding : 0;
    const minLeftBound = placementBoundsRect.left - wrapperRect.left + horizontalPadding;
    const maxLeftBound = placementBoundsRect.right - wrapperRect.left - horizontalPadding - barWidth;

    if (!canPlaceAbove && !canPlaceBelow) {
      setSelectionBarPosition(null);
      return;
    }

    const unclampedLeft = canPlaceAbove ? selectionLeft : selectionRight - barWidth;
    const maxLeft = Math.max(minLeftBound, maxLeftBound);
    const left = Math.max(minLeftBound, Math.min(unclampedLeft, maxLeft));
    const top = canPlaceAbove ? selectionTop - gap - barHeight : selectionBottom + gap;

    setSelectionBarPosition({
      left,
      top,
    });
  }, [dismissedSelectionText, selectionAnchor, terminalSelectionSettings.enabled]);

  React.useEffect(() => {
    if (!selectionAnchor) {
      setDismissedSelectionText(null);
      return;
    }

    if (dismissedSelectionText && dismissedSelectionText !== selectionAnchor.selectionText) {
      setDismissedSelectionText(null);
    }
  }, [dismissedSelectionText, selectionAnchor]);

  // ---------------------------------------------------------------------------
  // Shared terminal action helpers — used by both the Orbit Bar and the context
  // menu so that behaviour is consistent across interaction surfaces.
  // ---------------------------------------------------------------------------

  const copyTextToClipboard = React.useCallback(
    async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        notifySuccess(t('ssh.selectionBarCopySuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('ssh.selectionBarCopyFailed'));
      }
    },
    [notifyError, notifySuccess],
  );

  const openSearchForText = React.useCallback(
    (text: string): void => {
      try {
        const resolvedSearchUrl = resolveSearchUrl(
          terminalSelectionSettings.searchEngine,
          text,
          terminalSelectionSettings.searchUrlTemplate,
        );
        if (window.electron?.openExternalUrl) {
          void window.electron.openExternalUrl(resolvedSearchUrl).then((opened) => {
            if (!opened) {
              notifyError(t('ssh.selectionBarSearchFailed'));
            }
          });
          return;
        }

        const openedWindow = window.open(resolvedSearchUrl, '_blank', 'noopener,noreferrer');
        if (!openedWindow) {
          notifyError(t('ssh.selectionBarSearchFailed'));
          return;
        }

        openedWindow.opener = null;
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('ssh.selectionBarSearchFailed'));
      }
    },
    [notifyError, terminalSelectionSettings.searchEngine, terminalSelectionSettings.searchUrlTemplate],
  );

  // ---------------------------------------------------------------------------
  // Orbit Bar (TerminalSelectionBar) handlers
  // ---------------------------------------------------------------------------

  const handleSelectionBarCopy = React.useCallback(async () => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    await copyTextToClipboard(selectionAnchor.selectionText);
  }, [copyTextToClipboard, selectionAnchor]);

  const handleSelectionBarInsert = React.useCallback(() => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data: selectionAnchor.selectionText,
    });
    terminalRef.current?.focus();
  }, [selectionAnchor]);

  const handleSelectionBarSearch = React.useCallback(() => {
    if (!selectionAnchor?.selectionText.trim()) {
      return;
    }

    openSearchForText(selectionAnchor.selectionText);
  }, [openSearchForText, selectionAnchor]);

  // ---------------------------------------------------------------------------
  // Context menu handlers
  // ---------------------------------------------------------------------------

  const handleContextMenuCopy = React.useCallback(() => {
    const selectionText = terminalRef.current?.getSelection() ?? '';
    if (!selectionText) {
      return;
    }

    void copyTextToClipboard(selectionText);
  }, [copyTextToClipboard]);

  const handleContextMenuPaste = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          sendClientMessage(socket, { type: 'input', data: text });
          terminalRef.current?.focus();
        }
      })
      .catch(() => {
        // Clipboard read permission denied or unavailable; silently ignore.
      });
  }, []);

  const handleContextMenuSearchOnline = React.useCallback(() => {
    const selectionText = terminalRef.current?.getSelection() ?? '';
    if (!selectionText.trim()) {
      return;
    }

    openSearchForText(selectionText);
  }, [openSearchForText]);

  const handleContextMenuFind = React.useCallback(() => {
    notifyWarning(t('ssh.contextMenuFindComingSoon'));
  }, [notifyWarning]);

  const handleContextMenuSelectAll = React.useCallback(() => {
    terminalRef.current?.selectAll();
  }, []);

  const handleContextMenuClearTerminal = React.useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Send Ctrl+L — the standard ANSI clear-screen sequence.
    sendClientMessage(socket, { type: 'input', data: '\x0c' });
    terminalRef.current?.focus();
  }, []);

  const handleSelectionBarDragStart = React.useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      if (!selectionAnchor?.selectionText) {
        event.preventDefault();
        return;
      }

      const escapedHtml = selectionAnchor.selectionText
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('\n', '<br/>');

      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(INTERNAL_TERMINAL_TEXT_DRAG_MIME, '1');
      event.dataTransfer.setData('text/plain', selectionAnchor.selectionText);
      event.dataTransfer.setData('text', selectionAnchor.selectionText);
      event.dataTransfer.setData('text/unicode', selectionAnchor.selectionText);
      event.dataTransfer.setData('text/html', `<pre>${escapedHtml}</pre>`);
    },
    [selectionAnchor],
  );

  const handleSelectionBarClose = React.useCallback(() => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    setDismissedSelectionText(selectionAnchor.selectionText);
    setSelectionBarPosition(null);
  }, [selectionAnchor]);

  const handleSelectionOpenDirectory = React.useCallback(() => {
    notifyWarning(t('ssh.selectionBarOpenDirectoryComingSoon'));
  }, [notifyWarning]);

  const handleSelectionAskAi = React.useCallback(() => {
    notifyWarning(t('ssh.selectionBarAskAiComingSoon'));
  }, [notifyWarning]);

  const handleTerminalTextDrop = React.useCallback((droppedText: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendClientMessage(socket, {
      type: 'input',
      data: droppedText,
    });
    terminalRef.current?.focus();
  }, []);

  const {
    isVisible: isTextDropZoneVisible,
    isActive: isTextDropZoneActive,
    centerX: textDropZoneCenterX,
    handleWrapperDragEnter,
    handleWrapperDragOver,
    handleWrapperDragLeave,
    handleWrapperDrop,
    handleZoneDragEnter: handleTextDropZoneDragEnter,
    handleZoneDragOver: handleTextDropZoneDragOver,
    handleZoneDragLeave: handleTextDropZoneDragLeave,
    handleZoneDrop: handleTextDropZoneDrop,
  } = useTerminalTextDropZone({
    mode: terminalTextDropMode,
    isConnected: connectionState === 'connected',
    wrapperRef,
    terminalContainerRef,
    internalDragMimeType: INTERNAL_TERMINAL_TEXT_DRAG_MIME,
    onDropText: handleTerminalTextDrop,
  });

  React.useEffect(() => {
    const terminal = new Terminal(terminalInitOptions);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      terminalRef.current = null;
      terminal.dispose();
      return;
    }

    terminal.open(containerElement);
    terminalRef.current = terminal;
    let disposed = false;
    let retryFitFrameId: number | null = null;

    const hasRenderableSize = (): boolean => {
      const rect = containerElement.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    };

    const safeFit = (): boolean => {
      if (disposed) {
        return false;
      }

      if (!hasRenderableSize()) {
        return false;
      }

      try {
        fitAddon.fit();
        return true;
      } catch {
        // Ignore fit races during StrictMode mount/unmount cycles.
        return false;
      }
    };

    const retryFitUntilVisible = (): void => {
      if (disposed) {
        return;
      }

      if (safeFit()) {
        retryFitFrameId = null;
        return;
      }

      retryFitFrameId = requestAnimationFrame(retryFitUntilVisible);
    };

    retryFitUntilVisible();

    let socket: WebSocket | null = null;
    let sessionId: string | null = null;
    let sessionType: 'ssh-server' | 'local-terminal' | null = null;
    let lastSyncedCols: number | null = null;
    let lastSyncedRows: number | null = null;
    let fitFrameId: number | null = null;

    const syncResizeIfNeeded = (): void => {
      if (disposed || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (terminal.cols === lastSyncedCols && terminal.rows === lastSyncedRows) {
        return;
      }

      lastSyncedCols = terminal.cols;
      lastSyncedRows = terminal.rows;
      sendClientMessage(socket, {
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    const scheduleFitAndResizeSync = (): void => {
      if (disposed || fitFrameId !== null) {
        return;
      }

      fitFrameId = requestAnimationFrame(() => {
        fitFrameId = null;

        const didFit = safeFit();
        if (!didFit || disposed) {
          return;
        }

        syncResizeIfNeeded();
        refreshSelectionAnchor();
      });
    };

    void document.fonts.ready.then(() => {
      if (disposed) {
        return;
      }

      scheduleFitAndResizeSync();
    });

    const setupResizeSync = (): (() => void) => {
      const observer = new ResizeObserver(() => {
        scheduleFitAndResizeSync();
        refreshSelectionAnchor();
      });

      observer.observe(containerElement);

      return () => observer.disconnect();
    };

    const handleSocketMessage = (event: MessageEvent<string>): void => {
      if (disposed) {
        return;
      }

      try {
        const payload = JSON.parse(event.data) as ServerInboundMessage;

        if (payload.type === 'output') {
          terminal.write(payload.data);
          return;
        }

        if (payload.type === 'error') {
          setConnectionState('failed');
          setConnectionError(payload.message);
          return;
        }

        if (payload.type === 'exit') {
          setConnectionState('failed');
          setConnectionError(payload.reason);
          return;
        }

        if (payload.type === 'ready') {
          return;
        }

        if (payload.type === 'telemetry') {
          setTelemetryState({
            cpuUsagePercent: payload.cpuUsagePercent,
            memoryUsedBytes: payload.memoryUsedBytes,
            memoryTotalBytes: payload.memoryTotalBytes,
            networkRxBytesPerSec: payload.networkRxBytesPerSec,
            networkTxBytesPerSec: payload.networkTxBytesPerSec,
            // Backend already caps and de-duplicates commands; keep latest at top in the view layer.
            recentCommands: payload.recentCommands,
          });
          return;
        }
      } catch {
        setConnectionState('failed');
        setConnectionError(t('ssh.websocketMalformedMessage'));
      }
    };

    const connectSession = async (): Promise<void> => {
      try {
        setConnectionState('connecting');
        setConnectionError('');
        setTelemetryState(DEFAULT_TELEMETRY_STATE);

        const target = await resolveTerminalTarget();
        if (disposed) {
          return;
        }

        if (target.type === 'ssh-server') {
          onTabTitleChangeRef.current?.(target.server.name.trim() || t('tabs.page.ssh'));
        } else {
          onTabTitleChangeRef.current?.(target.profileName?.trim() || t('tabs.page.localTerminal'));
        }

        if (target.type === 'local-terminal') {
          terminal.options.windowsPty = { backend: 'conpty' };
          terminal.options.reflowCursorLine = false;

          const createResult = await createLocalTerminalSession({
            profileId: target.profileId,
            cols: terminal.cols,
            rows: terminal.rows,
            term: 'xterm-256color',
          });

          if (disposed) {
            void closeLocalTerminalSession(createResult.data.sessionId).catch(() => undefined);
            return;
          }

          sessionType = 'local-terminal';
          sessionId = createResult.data.sessionId;
          const websocketUrl = new URL(createResult.data.websocketUrl);
          websocketUrl.searchParams.set('token', createResult.data.websocketToken);

          socket = new WebSocket(websocketUrl.toString());
          socketRef.current = socket;
          socket.addEventListener('message', handleSocketMessage);

          socket.addEventListener('open', () => {
            if (disposed) {
              return;
            }

            setConnectionState('connected');
            setConnectionError('');
            scheduleFitAndResizeSync();
          });

          socket.addEventListener('close', () => {
            socketRef.current = null;
            if (disposed) {
              return;
            }

            setConnectionState('failed');
            setConnectionError(t('ssh.websocketClosed'));
          });

          socket.addEventListener('error', () => {
            socketRef.current = null;
            if (disposed) {
              return;
            }

            setConnectionState('failed');
            setConnectionError(t('ssh.websocketTransportFailed'));
          });

          return;
        }

        terminal.options.windowsPty = undefined;
        terminal.options.reflowCursorLine = true;

        const createPayload = await createSshSession({
          serverId: target.server.id,
          cols: terminal.cols,
          rows: terminal.rows,
          term: 'xterm-256color',
          connectTimeoutSec: sshConnectionTimeoutSec,
        });

        let createResult = createPayload;
        if (disposed) {
          if (createResult.success) {
            void closeSshSession(createResult.data.sessionId).catch(() => undefined);
          }
          return;
        }

        if (!createResult.success && createResult.code === 'SSH_HOST_UNTRUSTED') {
          const confirmed = await requestHostFingerprintTrust({
            serverId: createResult.data.serverId,
            host: createResult.data.host,
            port: createResult.data.port,
            algorithm: createResult.data.algorithm,
            fingerprint: createResult.data.fingerprint,
          });

          if (disposed) {
            return;
          }

          if (!confirmed) {
            setConnectionState('failed');
            setConnectionError(t('ssh.hostFingerprintNotTrusted'));
            return;
          }

          await trustSshFingerprint({
            serverId: createResult.data.serverId,
            fingerprintSha256: createResult.data.fingerprint,
            algorithm: createResult.data.algorithm,
          });

          createResult = await createSshSession({
            serverId: target.server.id,
            cols: terminal.cols,
            rows: terminal.rows,
            term: 'xterm-256color',
            connectTimeoutSec: sshConnectionTimeoutSec,
          });

          if (disposed) {
            if (createResult.success) {
              void closeSshSession(createResult.data.sessionId).catch(() => undefined);
            }
            return;
          }
        }

        if (!createResult.success) {
          throw new Error(createResult.message);
        }

        sessionType = 'ssh-server';
        sessionId = createResult.data.sessionId;
        const websocketUrl = new URL(createResult.data.websocketUrl);
        websocketUrl.searchParams.set('token', createResult.data.websocketToken);

        if (disposed) {
          void closeSshSession(createResult.data.sessionId).catch(() => undefined);
          return;
        }

        socket = new WebSocket(websocketUrl.toString());
        socketRef.current = socket;
        socket.addEventListener('message', handleSocketMessage);

        socket.addEventListener('open', () => {
          if (disposed) {
            return;
          }

          setConnectionState('connected');
          setConnectionError('');
          scheduleFitAndResizeSync();
        });

        socket.addEventListener('close', () => {
          socketRef.current = null;
          if (disposed) {
            return;
          }

          setConnectionState('failed');
          setConnectionError(t('ssh.websocketClosed'));
          return;
        });

        socket.addEventListener('error', () => {
          socketRef.current = null;
          if (disposed) {
            return;
          }

          setConnectionState('failed');
          setConnectionError(t('ssh.websocketTransportFailed'));
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : t('ssh.sessionInitFailed');
        setConnectionState('failed');
        setConnectionError(message);
      }
    };

    const disposeResize = setupResizeSync();
    const trackPointerPosition = (event: MouseEvent | PointerEvent): void => {
      selectionPointerClientXRef.current = event.clientX;
    };
    containerElement.addEventListener('pointerup', trackPointerPosition);
    containerElement.addEventListener('mouseup', trackPointerPosition);
    const disposeTerminalInput = terminal.onData((data) => {
      if (disposed) {
        return;
      }

      if (socket) {
        sendClientMessage(socket, {
          type: 'input',
          data,
        });
      }
    });
    const disposeSelectionChange = terminal.onSelectionChange(() => {
      refreshSelectionAnchor();
    });
    const disposeSelectionScroll = terminal.onScroll(() => {
      refreshSelectionAnchor();
    });
    const disposeSelectionRender = terminal.onRender(() => {
      if (!terminal.hasSelection()) {
        return;
      }

      refreshSelectionAnchor();
    });
    const handleWindowResize = (): void => {
      refreshSelectionAnchor();
    };
    window.addEventListener('resize', handleWindowResize);
    refreshSelectionAnchor();

    connectSessionRef.current = connectSession;
    void connectSession();

    return () => {
      disposed = true;

      if (retryFitFrameId !== null) {
        cancelAnimationFrame(retryFitFrameId);
        retryFitFrameId = null;
      }

      if (fitFrameId !== null) {
        cancelAnimationFrame(fitFrameId);
        fitFrameId = null;
      }

      try {
        if (socket && socket.readyState === WebSocket.OPEN) {
          sendClientMessage(socket, { type: 'close' });
          socket.close();
        }
      } catch {
        // Ignore websocket close race conditions.
      }

      socketRef.current = null;

      if (sessionId) {
        if (sessionType === 'local-terminal') {
          void closeLocalTerminalSession(sessionId).catch(() => undefined);
        } else {
          void closeSshSession(sessionId).catch(() => undefined);
        }
      }

      connectSessionRef.current = null;
      terminalRef.current = null;
      selectionPointerClientXRef.current = null;
      setSelectionAnchor(null);
      setSelectionBarPosition(null);
      disposeTerminalInput.dispose();
      disposeSelectionChange.dispose();
      disposeSelectionScroll.dispose();
      disposeSelectionRender.dispose();
      containerElement.removeEventListener('pointerup', trackPointerPosition);
      containerElement.removeEventListener('mouseup', trackPointerPosition);
      window.removeEventListener('resize', handleWindowResize);
      disposeResize();
      terminal.dispose();
    };
  }, [refreshSelectionAnchor, requestHostFingerprintTrust, sshConnectionTimeoutSec, terminalInitOptions]);

  // Card style
  const cardStyle = 'bg-ssh-card-bg-terminal h-full w-full flex-1 rounded-[18px] p-1';
  const sidebarCardStyle = 'bg-ssh-card-bg w-full flex-1 rounded-[18px] p-1';
  const cardHiddenArea =
    'overflow-hidden hof:my-[-38px] hof:py-[42px] hof:z-20 hof:shadow-lg transition-all duration-300 ease-in-out';
  const hiddenHeaderStyle = 'h-[34px] mt-[-38px]';

  const commandButtonStyle =
    '!justify-start overflow-hidden text-ellipsis text-start w-full whitespace-nowrap flex-shrink-0';

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full w-full gap-2.5"
      onDragEnter={handleWrapperDragEnter}
      onDragOver={handleWrapperDragOver}
      onDragLeave={handleWrapperDragLeave}
      onDrop={handleWrapperDrop}
    >
      {/* SSH */}
      <div className={classNames(cardStyle, 'min-w-0')}>
        <TerminalContextMenu
          hasSelection={!!selectionAnchor?.selectionText}
          isConnected={connectionState === 'connected'}
          copyLabel={t('ssh.contextMenuCopy')}
          pasteLabel={t('ssh.contextMenuPaste')}
          searchOnlineLabel={t('ssh.contextMenuSearchOnline')}
          findLabel={t('ssh.contextMenuFind')}
          selectAllLabel={t('ssh.contextMenuSelectAll')}
          clearTerminalLabel={t('ssh.contextMenuClearTerminal')}
          onCopy={handleContextMenuCopy}
          onPaste={handleContextMenuPaste}
          onSearchOnline={handleContextMenuSearchOnline}
          onFind={handleContextMenuFind}
          onSelectAll={handleContextMenuSelectAll}
          onClearTerminal={handleContextMenuClearTerminal}
        >
          <div
            ref={terminalContainerRef}
            className="h-full w-full p-2"
          />
        </TerminalContextMenu>
      </div>

      {connectionState === 'connected' &&
      terminalSelectionSettings.enabled &&
      selectionAnchor &&
      selectionBarPosition &&
      dismissedSelectionText !== selectionAnchor.selectionText ? (
        <div
          className="pointer-events-none absolute z-40"
          style={{
            top: `${selectionBarPosition.top}px`,
            left: `${selectionBarPosition.left}px`,
          }}
        >
          <TerminalSelectionBar
            ref={selectionBarRef}
            selectedText={selectionAnchor.selectionText}
            dragLabel={t('ssh.selectionBarDrag')}
            copyLabel={t('ssh.selectionBarCopy')}
            insertLabel={t('ssh.selectionBarInsert')}
            openDirectoryLabel={t('ssh.selectionBarOpenDirectory')}
            searchLabel={t('ssh.selectionBarSearch')}
            askAiLabel={t('ssh.selectionBarAskAiLabel')}
            closeLabel={t('ssh.selectionBarClose')}
            onDragStart={handleSelectionBarDragStart}
            onCopy={() => {
              void handleSelectionBarCopy();
            }}
            onInsert={handleSelectionBarInsert}
            onOpenDirectory={handleSelectionOpenDirectory}
            onSearch={handleSelectionBarSearch}
            onAskAi={handleSelectionAskAi}
            onClose={handleSelectionBarClose}
          />
        </div>
      ) : null}

      {connectionState === 'connected' && isTextDropZoneVisible ? (
        <TerminalTextDropZone
          centerX={textDropZoneCenterX ?? 0}
          label={t('ssh.dropTextToTerminal')}
          active={isTextDropZoneActive}
          onDragEnter={handleTextDropZoneDragEnter}
          onDragOver={handleTextDropZoneDragOver}
          onDragLeave={handleTextDropZoneDragLeave}
          onDrop={handleTextDropZoneDrop}
        />
      ) : null}

      {/* Sidebar */}
      <div className="flex w-[300px] min-w-[300px] shrink-0 flex-col items-center justify-between gap-2.5 overflow-auto">
        {/* Usage */}
        <div
          className={classNames(
            sidebarCardStyle,
            'flex flex-shrink-0 flex-grow-0 items-center justify-between gap-2 px-3 py-2',
          )}
        >
          {/* CPU */}
          <div className="flex flex-grow items-center gap-1">
            <Cpu size={14} />
            <span className="text-sm">{formatCpuPercent(telemetryState.cpuUsagePercent)}</span>
          </div>

          {/* Memory */}
          <div className="flex flex-grow items-center gap-1">
            <MemoryStick size={14} />
            <span className="text-sm">
              {formatMemoryUsage(telemetryState.memoryUsedBytes, telemetryState.memoryTotalBytes)}
            </span>
          </div>

          {/* Transit */}
          <div className="flex flex-grow items-center gap-1">
            <ArrowUpDown size={14} />
            <span className="text-sm">
              {formatTrafficRate(telemetryState.networkTxBytesPerSec)}/
              {formatTrafficRate(telemetryState.networkRxBytesPerSec)}
            </span>
          </div>
        </div>

        {/* Recent commands */}
        <div className={classNames(sidebarCardStyle, cardHiddenArea)}>
          <div className={classNames(hiddenHeaderStyle, 'flex flex-shrink-0 items-center justify-between')}>
            <Button>Commands</Button>
            <div className="flex">
              <Button
                aria-label="Search"
                variant="icon"
              >
                <Search size={16} />
              </Button>
            </div>
          </div>
          <div className="flex h-[178px] flex-col overflow-auto">
            {telemetryState.recentCommands.length === 0 ? (
              <div className="text-muted-text flex h-full items-center justify-center text-xs">No recent commands</div>
            ) : (
              [...telemetryState.recentCommands].reverse().map((command, index) => (
                <Button
                  key={`${command}-${index}`}
                  className={commandButtonStyle}
                >
                  {command}
                </Button>
              ))
            )}
          </div>
        </div>

        {/* Files */}
        <div className={sidebarCardStyle}>
          <span>1</span>
        </div>

        {/* Shortcuts */}
        <div className={sidebarCardStyle}>
          <span>1</span>
        </div>

        {/* Ask AI */}
        <div className={classNames(sidebarCardStyle, 'flex-grow-0')}>
          <div className="flex h-full w-full items-center justify-center">
            <Button
              variant="icon"
              aria-label="Ask AI"
            >
              <Sparkles size={16} />
            </Button>
            <Input placeholder="Ask AI Anything..." />
            <Button
              variant="icon"
              aria-label="Send"
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      </div>

      {connectionState !== 'connected' ? (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-between bg-bg px-4 py-12">
          <div></div>
          <div className="text-sm text-header-text">
            {connectionState === 'connecting' ? t('ssh.connecting') : connectionError}
          </div>
          <div
            className={classNames(
              'flex items-center justify-center',
              connectionState === 'connecting' ? 'invisible' : '',
            )}
          >
            <Menubar>
              <Button onClick={handleRetry}>
                <RefreshCw size={16} />
                {t('ssh.retry')}
              </Button>
            </Menubar>
          </div>
        </div>
      ) : null}

      <Dialog
        open={hostFingerprintPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            resolveHostFingerprintPrompt(false);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            resolveHostFingerprintPrompt(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ssh.hostFingerprintDialogTitle')}</DialogTitle>
            <DialogDescription>{t('ssh.hostFingerprintDialogDescription')}</DialogDescription>
          </DialogHeader>

          {hostFingerprintPrompt ? (
            <div className="space-y-2 rounded-md border border-home-divider p-3 text-sm">
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogHost')}: </span>
                <span>
                  {hostFingerprintPrompt.host}:{hostFingerprintPrompt.port}
                </span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogAlgorithm')}: </span>
                <span>{hostFingerprintPrompt.algorithm}</span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogFingerprint')}: </span>
                <span className="break-all">{hostFingerprintPrompt.fingerprint}</span>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <DialogSecondaryButton onClick={() => resolveHostFingerprintPrompt(false)}>
              {t('ssh.hostFingerprintDialogCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton onClick={() => resolveHostFingerprintPrompt(true)}>
              {t('ssh.hostFingerprintDialogTrustContinue')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SSH;
