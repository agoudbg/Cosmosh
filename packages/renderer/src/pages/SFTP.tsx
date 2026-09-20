import {
  type ApiSftpEntry,
  type ApiSftpUploadFileRequest,
  type ApiSftpUploadFileResponse,
  compareSftpEntryNames,
  compareSftpNames,
  type SftpUploadLocalFile,
  type SftpUploadRejectedLocalEntry,
} from '@cosmosh/api-contract';
import React from 'react';

import { Button } from '../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import {
  closeSftpSession,
  createSftpDirectory,
  createSftpFile,
  createSftpSession,
  downloadSftpFile,
  getSftpEntryDetails,
  getSftpTransferProgress,
  isBackendApiError,
  isBackendSftpTaskError,
  listSftpDirectory,
  renameSftpEntry,
  runSftpBatchOperation,
  trustSshFingerprint,
  uploadSftpFile,
} from '../lib/backend';
import { t } from '../lib/i18n';
import { resolveSystemProxyRulesForServerId } from '../lib/server-proxy';
import { useSettingsValue, useSettingsValues } from '../lib/settings-store';
import { useToast } from '../lib/toast-context';
import type { SftpConnectionIntent } from '../types/tabs';
import { NEW_DIRECTORY_NAME, NEW_FILE_NAME, PARENT_DIRECTORY_ROW_KEY } from './sftp/sftp-constants';
import { sortSftpEntriesByDirectoryListView } from './sftp/sftp-directory-view';
import { buildSftpEntryPropertiesWindowUrl } from './sftp/sftp-entry-properties-window';
import {
  createSftpEntryRemoteSnapshot,
  doesSftpEntryMatchRemoteSnapshot,
  isDirtySftpTextPreviewState,
  resolvePreviewStatePath,
  type SftpImagePreviewTempFileCacheEntry,
} from './sftp/sftp-page-utils';
import {
  ensureSharedSftpReconnect,
  isSftpSessionNotFoundError,
  runSftpOperationWithReconnect,
  type SftpOperationImpact,
} from './sftp/sftp-reconnect';
import type {
  ClipboardState,
  DirectoryCacheEntry,
  DirectoryLoadOptions,
  NavigationHistoryControlOptions,
  NavigationHistoryMenuItem,
  NavigationState,
  PendingCreateState,
  SftpActionMenuOptions,
  SftpDeleteInvocationSource,
  SftpFileNavigationRow,
  SftpOpenWithApplication,
  SftpPreviewState,
  SftpSelectionClickEvent,
  SftpTaskContext,
  SftpWatchedOpenFile,
  TreeDirectoryNode,
} from './sftp/sftp-types';
import {
  buildBreadcrumbs,
  buildNavigationHistoryMenuItems,
  dedupeSftpEntries,
  filterSftpEntries,
  filterSftpEntriesByHiddenVisibility,
  formatBatchFeedback,
  formatBatchPartialFailureFeedback,
  formatSftpTabTitle,
  isSameClipboardSnapshot,
  joinRemotePath,
  mergeResolvedDirectoryIntoTree,
  resolveAddressBreadcrumbRenderState,
  resolveAncestorDirectoryPaths,
  resolveEntryParentPath,
  resolveRemoteParentPath,
  resolveRenameTargetPath,
  resolveShortcutModifier,
  sanitizeLocalFileName,
  shouldConfirmSftpDelete,
  sortSftpEntries,
} from './sftp/sftp-utils';
import { flattenVisibleSftpTreeRows } from './sftp/sftp-virtualization';
import { SftpActionMenuItems } from './sftp/SftpActionMenuItems';
import {
  SftpArchiveCompressionDialog,
  SftpArchiveConflictDialog,
  SftpArchiveDestinationDialog,
} from './sftp/SftpArchiveDialogs';
import type { SftpPreviewEditorHandle } from './sftp/SftpCodeMirrorPreviewEditor';
import { SftpDetailPanel } from './sftp/SftpDetailPanel';
import {
  SftpDeleteConfirmationDialog,
  SftpHostFingerprintDialog,
  SftpUploadConfirmationDialog,
  SftpUploadConflictConfirmationDialog,
} from './sftp/SftpDialogs';
import { SftpDirectoryPanel, type SftpDirectoryPanelHandle } from './sftp/SftpDirectoryPanel';
import { SftpDropOperationMenu } from './sftp/SftpDropOperationMenu';
import { SftpToolbar } from './sftp/SftpToolbar';
import { SftpTreePanel, type SftpTreePanelHandle } from './sftp/SftpTreePanel';
import { useSftpAddressInputController } from './sftp/useSftpAddressInputController';
import { useSftpArchiveActions } from './sftp/useSftpArchiveActions';
import { useSftpConfirmationPrompts } from './sftp/useSftpConfirmationPrompts';
import { useSftpDirectoryListPreferences } from './sftp/useSftpDirectoryListPreferences';
import { useSftpDragDropController } from './sftp/useSftpDragDropController';
import { useSftpInlineEditFocus } from './sftp/useSftpInlineEditFocus';
import { useSftpKeyboardShortcuts } from './sftp/useSftpKeyboardShortcuts';
import { useSftpPreviewActions } from './sftp/useSftpPreviewActions';
import { useSftpSelectionModel } from './sftp/useSftpSelectionModel';
import { useSftpTaskQueue } from './sftp/useSftpTaskQueue';

type SFTPProps = {
  connectionIntent?: SftpConnectionIntent;
  onOpenDirectoryInNewTab: (initialPath: string) => void;
  onOpenSshAtPath: (initialPath: string) => void;
  onTabTitleChange: (title: string) => void;
};

const SFTP_TRANSFER_POLL_INTERVAL_MS = 500;

/**
 * Read-only SFTP browser page bound to one renderer tab.
 *
 * @param props SFTP tab runtime props.
 * @returns SFTP workbench page.
 */
const SFTP: React.FC<SFTPProps> = ({
  connectionIntent,
  onOpenDirectoryInNewTab,
  onOpenSshAtPath,
  onTabTitleChange,
}) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const settingsValues = useSettingsValues();
  const sftpDeleteConfirmationMode = useSettingsValue('sftpDeleteConfirmationMode');
  const sftpShowHiddenEntries = useSettingsValue('sftpShowHiddenEntries');
  const sftpDimHiddenEntries = useSettingsValue('sftpDimHiddenEntries');
  const sftpShowParentDirectoryEntry = useSettingsValue('sftpShowParentDirectoryEntry');
  const sftpShowAddressAsText = useSettingsValue('sftpShowAddressAsText');
  const sftpAuxiliarySidebarMode = useSettingsValue('sftpAuxiliarySidebarMode');
  const sftpTextPreviewWarningThresholdBytes = useSettingsValue('sftpTextPreviewWarningThresholdBytes');
  const sftpImagePreviewWarningThresholdBytes = useSettingsValue('sftpImagePreviewWarningThresholdBytes');
  const registrySftpDirectoryListView = useSettingsValue('sftpDirectoryListView');
  const sftpInternalDragDefaultAction = useSettingsValue('sftpInternalDragDefaultAction');
  const sftpInternalDragModifierAction = useSettingsValue('sftpInternalDragModifierAction');
  const sftpReconnectMode = useSettingsValue('sftpReconnectMode');
  const [sessionId, setSessionId] = React.useState<string>('');
  const [currentPath, setCurrentPath] = React.useState<string>('.');
  // Keep the requested address visible after a failed listing without changing the last usable directory.
  const [addressPath, setAddressPath] = React.useState<string>(connectionIntent?.initialPath ?? '.');
  const [parentPath, setParentPath] = React.useState<string | undefined>(undefined);
  const [entries, setEntries] = React.useState<ApiSftpEntry[]>([]);
  const [status, setStatus] = React.useState<'idle' | 'connecting' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [filterQuery, setFilterQuery] = React.useState<string>('');
  const [treeNodes, setTreeNodes] = React.useState<Record<string, TreeDirectoryNode>>({});
  const [navigationState, setNavigationState] = React.useState<NavigationState>({ paths: [], index: -1 });
  const [clipboardState, setClipboardState] = React.useState<ClipboardState | null>(null);
  const [isRefreshingDirectory, setIsRefreshingDirectory] = React.useState(false);
  const [renamingEntryPath, setRenamingEntryPath] = React.useState<string>('');
  const [renameInput, setRenameInput] = React.useState<string>('');
  const [pendingCreate, setPendingCreate] = React.useState<PendingCreateState | null>(null);
  const [previewState, setPreviewState] = React.useState<SftpPreviewState | null>(null);
  const [openWithApplicationsByPath, setOpenWithApplicationsByPath] = React.useState<
    Record<string, SftpOpenWithApplication[]>
  >({});
  const [loadingOpenWithPath, setLoadingOpenWithPath] = React.useState<string>('');
  const [activeTreePath, setActiveTreePath] = React.useState<string>('');
  const [activeFileRowKey, setActiveFileRowKey] = React.useState<string>('');
  const directoryCacheRef = React.useRef<Record<string, DirectoryCacheEntry>>({});
  const sessionIdRef = React.useRef<string>('');
  const currentPathRef = React.useRef<string>('.');
  const sftpShowHiddenEntriesRef = React.useRef(sftpShowHiddenEntries);
  const syncedTabTitleRef = React.useRef<string>('');
  const temporaryOpenFilePathsRef = React.useRef<Record<string, string>>({});
  const imagePreviewTempFilesRef = React.useRef<Record<string, SftpImagePreviewTempFileCacheEntry>>({});
  const watchedOpenFilesRef = React.useRef<Record<string, SftpWatchedOpenFile>>({});
  const stagedUploadPathsRef = React.useRef<Set<string>>(new Set());
  const reconnectPromiseRef = React.useRef<Promise<string> | null>(null);
  const directoryLoadGenerationRef = React.useRef(0);
  const currentDirectoryRefreshPromiseRef = React.useRef<Promise<void> | null>(null);
  const pendingDirectoryRefreshPathsRef = React.useRef<Set<string>>(new Set());
  const previewLoadGenerationRef = React.useRef(0);
  const previewEditorRef = React.useRef<SftpPreviewEditorHandle | null>(null);
  const previewStateRef = React.useRef<SftpPreviewState | null>(null);
  const treePanelRef = React.useRef<SftpTreePanelHandle | null>(null);
  const directoryPanelRef = React.useRef<SftpDirectoryPanelHandle | null>(null);
  const getActiveSftpSessionId = React.useCallback((): string => sessionIdRef.current, []);
  const {
    hostFingerprintPrompt,
    deleteConfirmationPrompt,
    uploadConfirmationPrompt,
    uploadConflictConfirmationPrompt,
    setUploadConfirmationPrompt,
    requestHostFingerprintTrust,
    resolveHostFingerprintPrompt,
    requestDeleteConfirmation,
    resolveDeleteConfirmationPrompt,
    requestUploadConflictConfirmation,
    resolveUploadConflictConfirmationPrompt,
    cancelUploadConflictConfirmationPrompt,
  } = useSftpConfirmationPrompts();
  const {
    sftpDirectoryListView,
    setSftpHiddenEntriesVisibility,
    setSftpAuxiliarySidebarMode,
    setSftpAddressDisplayMode,
    setSftpDirectoryListSort,
    handleSftpDirectoryListSortFieldClick,
    setSftpDirectoryListColumnVisibility,
    setSftpDirectoryListColumnOrder,
  } = useSftpDirectoryListPreferences({
    settingsValues,
    registrySftpDirectoryListView,
    previewStateRef,
    notifyError,
  });
  const {
    renameInputRef,
    handleInlineEditMenuCloseAutoFocus,
    handleInlineEditInputBlur,
    runInlineEditMenuActionAfterClose,
  } = useSftpInlineEditFocus({
    isInlineEditActive: Boolean(renamingEntryPath || pendingCreate),
    notifyError,
  });
  const hasSftpSession = Boolean(sessionId);
  const isBusy = status === 'connecting' || status === 'loading';
  const hasResolvedCurrentDirectory = status === 'ready' || navigationState.index >= 0;
  const isAddressLoading =
    isBusy || (Boolean(connectionIntent?.serverId) && !hasResolvedCurrentDirectory && status !== 'error');
  const canUseFileActions = hasSftpSession && status === 'ready' && !isBusy;
  const {
    activeTaskCount,
    runningTaskCount,
    sortedSftpTasks,
    taskToolbarLabel,
    onTaskMenuOpenChange,
    resetTaskQueue,
    runSftpOperation,
    runSftpReconnectTask,
  } = useSftpTaskQueue({ canUseFileActions, notifyError });

  /**
   * Runs one byte transfer while polling the backend's bounded progress record.
   *
   * Polling is deliberately slower than backend speed sampling so large transfers do not
   * cause a page render for every stream chunk.
   *
   * @param transferId Renderer-generated transfer identifier.
   * @param context Active task update helpers.
   * @param operation Upload or download request to execute.
   * @returns Operation result.
   */
  const runTrackedSftpTransfer = React.useCallback(async function runTrackedSftpTransferRequest<TResult>(
    transferId: string,
    context: Pick<SftpTaskContext, 'isCurrent' | 'update'>,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    let stopped = false;
    let timerId: number | undefined;
    let pendingPoll: Promise<void> | null = null;

    const readProgress = async (): Promise<void> => {
      try {
        const response = await getSftpTransferProgress(transferId);
        if (!context.isCurrent()) {
          return;
        }

        context.update({
          progress: {
            completed: response.data.transferredBytes,
            total: response.data.totalBytes,
            unit: 'bytes',
            bytesPerSecond: response.data.bytesPerSecond,
          },
          errorMessage: response.data.status === 'failed' ? response.data.errorMessage : undefined,
        });
      } catch {
        // The final transfer request remains authoritative; progress polling is best effort.
      }
    };

    const schedulePoll = (): void => {
      timerId = window.setTimeout(() => {
        pendingPoll = readProgress().finally(() => {
          pendingPoll = null;
          if (!stopped) {
            schedulePoll();
          }
        });
      }, SFTP_TRANSFER_POLL_INTERVAL_MS);
    };

    schedulePoll();
    try {
      return await operation();
    } finally {
      stopped = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
      await pendingPoll;
      await readProgress();
    }
  }, []);

  React.useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  React.useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  React.useEffect(() => {
    sftpShowHiddenEntriesRef.current = sftpShowHiddenEntries;
  }, [sftpShowHiddenEntries]);

  /**
   * Stops every main-process watcher attached to opened SFTP temp files.
   *
   * @returns void.
   */
  const stopAllWatchedOpenFiles = React.useCallback((): void => {
    Object.values(watchedOpenFilesRef.current).forEach((watchedFile) => {
      void window.electron?.stopSftpTemporaryFileWatch(watchedFile.watchId);
    });
    watchedOpenFilesRef.current = {};
    cancelUploadConflictConfirmationPrompt();
    setUploadConfirmationPrompt(null);
  }, [cancelUploadConflictConfirmationPrompt, setUploadConfirmationPrompt]);

  /**
   * Removes every local file staged by the native upload picker.
   *
   * @returns void.
   */
  const cleanupAllStagedUploadFiles = React.useCallback((): void => {
    const stagedPaths = [...stagedUploadPathsRef.current];
    stagedUploadPathsRef.current.clear();
    if (stagedPaths.length > 0) {
      void window.electron?.cleanupSftpTemporaryFiles(stagedPaths);
    }
  }, []);

  React.useEffect(() => {
    return () => {
      stopAllWatchedOpenFiles();
      cleanupAllStagedUploadFiles();
    };
  }, [cleanupAllStagedUploadFiles, stopAllWatchedOpenFiles]);

  React.useEffect(() => {
    return window.electron?.onSftpTemporaryFileChanged((change) => {
      const watchedFile = Object.values(watchedOpenFilesRef.current).find(
        (candidate) => candidate.watchId === change.watchId,
      );
      if (!watchedFile) {
        return;
      }

      const nextWatchedFile: SftpWatchedOpenFile = {
        ...watchedFile,
        pendingChange: {
          size: change.size,
          modifiedAt: change.modifiedAt,
        },
        isPromptOpen: true,
      };
      watchedOpenFilesRef.current = {
        ...watchedOpenFilesRef.current,
        [watchedFile.remotePath]: nextWatchedFile,
      };
      setUploadConfirmationPrompt({
        remotePath: watchedFile.remotePath,
        name: watchedFile.name,
        localPath: watchedFile.localPath,
        size: change.size,
        modifiedAt: change.modifiedAt,
      });
    });
  }, [setUploadConfirmationPrompt]);

  React.useEffect(() => {
    const serverName = connectionIntent?.serverName;
    if (!serverName) {
      return;
    }

    const fallbackTitle = serverName.trim() || t('tabs.page.sftp');
    const nextTitle = hasResolvedCurrentDirectory ? formatSftpTabTitle(currentPath, serverName) : fallbackTitle;
    if (syncedTabTitleRef.current !== nextTitle) {
      syncedTabTitleRef.current = nextTitle;
      onTabTitleChange(nextTitle);
    }
  }, [connectionIntent?.serverName, currentPath, hasResolvedCurrentDirectory, onTabTitleChange]);

  React.useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  const visibleEntries = React.useMemo(() => {
    const filteredEntries = filterSftpEntries(
      filterSftpEntriesByHiddenVisibility(entries, sftpShowHiddenEntries),
      filterQuery,
    );
    return sortSftpEntriesByDirectoryListView(filteredEntries, sftpDirectoryListView.sort);
  }, [entries, filterQuery, sftpDirectoryListView.sort, sftpShowHiddenEntries]);

  const breadcrumbs = React.useMemo(() => buildBreadcrumbs(addressPath), [addressPath]);
  const addressBreadcrumbRenderState = React.useMemo(
    () => resolveAddressBreadcrumbRenderState(breadcrumbs),
    [breadcrumbs],
  );
  const shortcutModifier = React.useMemo(() => resolveShortcutModifier(), []);
  const canGoBack = navigationState.index > 0;
  const canGoForward = navigationState.index >= 0 && navigationState.index < navigationState.paths.length - 1;
  const backNavigationHistoryItems = React.useMemo(
    () => buildNavigationHistoryMenuItems(navigationState, 'back'),
    [navigationState],
  );
  const forwardNavigationHistoryItems = React.useMemo(
    () => buildNavigationHistoryMenuItems(navigationState, 'forward'),
    [navigationState],
  );
  const canUploadLocalFiles = Boolean(window.electron?.selectSftpUploadFiles);
  const hasParentDirectoryListEntry = sftpShowParentDirectoryEntry;
  const canActivateParentDirectoryListEntry = Boolean(parentPath);
  const activeTextPreview = previewState?.status === 'text' ? previewState : null;
  const hasTextPreview = Boolean(activeTextPreview);
  const isPreviewDirty = Boolean(activeTextPreview && activeTextPreview.content !== activeTextPreview.savedContent);
  const isPreviewSaving = Boolean(activeTextPreview?.isSaving);
  const sftpWorkbenchGridClassName =
    sftpAuxiliarySidebarMode === 'off'
      ? 'grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] gap-2.5 overflow-hidden'
      : sftpAuxiliarySidebarMode === 'preview'
        ? 'grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)_minmax(320px,420px)] gap-2.5 overflow-hidden'
        : 'grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)_minmax(240px,320px)] gap-2.5 overflow-hidden';

  React.useEffect(() => {
    setTreeNodes((previous) => {
      let next = previous;
      Object.values(directoryCacheRef.current).forEach((cacheEntry) => {
        next = mergeResolvedDirectoryIntoTree(
          next,
          cacheEntry.path,
          cacheEntry.path,
          cacheEntry.entries,
          sftpShowHiddenEntries,
        );
      });

      return next;
    });
  }, [sftpShowHiddenEntries]);

  /**
   * Blocks selection changes that would silently drop unsaved preview edits.
   *
   * @returns Whether the caller should keep the current selection and preview state.
   */
  const shouldPreserveDirtyPreviewState = React.useCallback((): boolean => {
    if (!isDirtySftpTextPreviewState(previewStateRef.current)) {
      return false;
    }

    notifyError(t('sftp.previewUnsavedChanges'));
    return true;
  }, [notifyError]);

  /**
   * Clears preview state unless doing so would discard local editor edits.
   *
   * @param options Clear behavior options.
   * @returns Whether the preview state was cleared.
   */
  const clearPreviewState = React.useCallback(
    (options: { force?: boolean } = {}): boolean => {
      if (!options.force && shouldPreserveDirtyPreviewState()) {
        return false;
      }

      previewLoadGenerationRef.current += 1;
      previewEditorRef.current = null;
      previewStateRef.current = null;
      setPreviewState(null);
      return true;
    },
    [shouldPreserveDirtyPreviewState],
  );

  /**
   * Clears preview state for a new single-entry selection when needed.
   *
   * @param nextEntry Entry that will become the single selection.
   * @returns Whether selection may proceed.
   */
  const clearPreviewStateForSelection = React.useCallback(
    (nextEntry: ApiSftpEntry | null): boolean => {
      const currentPreviewPath = resolvePreviewStatePath(previewStateRef.current);
      if (nextEntry && currentPreviewPath === nextEntry.path) {
        return true;
      }

      return clearPreviewState();
    },
    [clearPreviewState],
  );

  /**
   * Clears preview state for hard runtime resets where preserving local state is unsafe.
   *
   * @returns void.
   */
  const forceClearPreviewState = React.useCallback((): void => {
    void clearPreviewState({ force: true });
  }, [clearPreviewState]);

  const {
    selectedPathSet,
    selectedEntries,
    selectedEntry,
    primarySelectedEntry,
    selectedCount,
    hasSelection,
    hasSingleSelection,
    selectionAnchorPath,
    setSelectedPaths,
    setSelectionAnchorPath,
    resetSelection,
    selectSingleEntry,
    selectEntryWithModifiers,
    selectEntriesByPaths,
    pruneSelectionToEntries,
  } = useSftpSelectionModel({
    visibleEntries,
    clearPreviewState,
    clearPreviewStateForSelection,
  });

  const fileNavigationRows = React.useMemo<SftpFileNavigationRow[]>(() => {
    const rows: SftpFileNavigationRow[] = [];

    if (canActivateParentDirectoryListEntry) {
      rows.push({ kind: 'parent', key: PARENT_DIRECTORY_ROW_KEY });
    }

    visibleEntries.forEach((entry) => {
      rows.push({ kind: 'entry', key: entry.path, entry });
    });

    return rows;
  }, [canActivateParentDirectoryListEntry, visibleEntries]);

  const resolvedActiveFileRowKey = activeFileRowKey || fileNavigationRows[0]?.key || '';
  const clipboardPaths = React.useMemo(() => {
    return new Set(clipboardState?.entries.map((entry) => entry.path) ?? []);
  }, [clipboardState]);

  /**
   * Detects opened-file upload conflicts that should ask for explicit overwrite confirmation.
   *
   * @param error Error thrown by the renderer backend client.
   * @returns Whether this failure represents a remote file conflict.
   */
  const isSftpUploadConflictError = React.useCallback((error: unknown): boolean => {
    return (isBackendApiError(error) || isBackendSftpTaskError(error)) && error.code === 'SFTP_UPLOAD_CONFLICT';
  }, []);

  /**
   * Creates a replacement SFTP session for the current tab after the old one expires.
   *
   * @param preferredPath Current remote path that should be restored when possible.
   * @returns New active backend session id.
   */
  const reconnectSftpSession = React.useCallback(
    async (preferredPath: string): Promise<string> => {
      if (!connectionIntent?.serverId) {
        throw new Error(t('sftp.noSession'));
      }

      const fallbackPath = connectionIntent.initialPath ?? '.';
      const candidatePaths = Array.from(new Set([preferredPath.trim() || fallbackPath, fallbackPath]));
      const trustRejectedMessage = t('ssh.hostFingerprintNotTrusted');
      const systemProxyRules = await resolveSystemProxyRulesForServerId(connectionIntent.serverId);

      for (const initialPath of candidatePaths) {
        try {
          let shouldRetryTrust = true;
          while (shouldRetryTrust) {
            shouldRetryTrust = false;
            const response = await createSftpSession({
              serverId: connectionIntent.serverId,
              initialPath,
              connectTimeoutSec: 45,
              systemProxyRules,
            });

            if (!response.success && response.code === 'SSH_HOST_UNTRUSTED') {
              const accepted = await requestHostFingerprintTrust({
                serverId: response.data.serverId,
                host: response.data.host,
                port: response.data.port,
                algorithm: response.data.algorithm,
                fingerprint: response.data.fingerprint,
              });

              if (!accepted) {
                throw new Error(trustRejectedMessage);
              }

              await trustSshFingerprint({
                serverId: response.data.serverId,
                fingerprintSha256: response.data.fingerprint,
                algorithm: response.data.algorithm,
              });
              shouldRetryTrust = true;
              continue;
            }

            const nextSessionId = response.data.sessionId;
            sessionIdRef.current = nextSessionId;
            setSessionId(nextSessionId);
            return nextSessionId;
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.message === trustRejectedMessage) {
            throw error;
          }

          if (initialPath === candidatePaths[candidatePaths.length - 1]) {
            throw error;
          }
        }
      }

      throw new Error(t('sftp.reconnectFailed'));
    },
    [connectionIntent?.initialPath, connectionIntent?.serverId, requestHostFingerprintTrust],
  );

  /**
   * Ensures one reconnect attempt is shared by every operation that observes the same stale session.
   *
   * @returns New active backend session id.
   */
  const ensureSftpSessionForOperation = React.useCallback(async (): Promise<string> => {
    return ensureSharedSftpReconnect(reconnectPromiseRef, () =>
      runSftpReconnectTask(async ({ update }) => {
        update({ detail: t('sftp.tasks.reconnecting'), progress: { completed: 0, total: 1 } });
        const nextSessionId = await reconnectSftpSession(currentPathRef.current);
        update({ progress: { completed: 1, total: 1 } });
        return nextSessionId;
      }),
    );
  }, [reconnectSftpSession, runSftpReconnectTask]);

  /**
   * Runs one SFTP backend request with impact-aware passive session recovery.
   *
   * @param impact Whether replaying the request could change remote state.
   * @param operation Operation that receives the session id to call.
   * @returns Operation result, including at most one safe read replay.
   */
  const runWithSftpReconnect = React.useCallback(
    function runWithSftpReconnectRequest<TResult>(
      impact: SftpOperationImpact,
      operation: (activeSessionId: string) => Promise<TResult>,
    ): Promise<TResult> {
      return runSftpOperationWithReconnect({
        impact,
        getActiveSessionId: getActiveSftpSessionId,
        createNoSessionError: () => new Error(t('sftp.noSession')),
        isReconnectableError: (error) => sftpReconnectMode !== 'off' && isSftpSessionNotFoundError(error),
        ensureSession: ensureSftpSessionForOperation,
        operation,
      });
    },
    [ensureSftpSessionForOperation, getActiveSftpSessionId, sftpReconnectMode],
  );

  const setTreeNodeLoading = React.useCallback((directoryPath: string, isLoading: boolean): void => {
    setTreeNodes((previous) => {
      const existing = previous[directoryPath];
      if (!existing) {
        return previous;
      }

      return {
        ...previous,
        [directoryPath]: {
          ...existing,
          isExpanded: isLoading ? true : existing.isExpanded,
          isLoading,
        },
      };
    });
  }, []);

  const syncAncestorDirectories = React.useCallback(
    async (directoryPath: string, isCancelled?: () => boolean): Promise<void> => {
      const ancestorPaths = resolveAncestorDirectoryPaths(directoryPath);

      for (const ancestorPath of ancestorPaths) {
        if (isCancelled?.()) {
          return;
        }

        const cachedDirectory = directoryCacheRef.current[ancestorPath];
        if (cachedDirectory) {
          setTreeNodes((previous) =>
            mergeResolvedDirectoryIntoTree(
              previous,
              ancestorPath,
              cachedDirectory.path,
              cachedDirectory.entries,
              sftpShowHiddenEntriesRef.current,
            ),
          );
          continue;
        }

        setTreeNodeLoading(ancestorPath, true);

        try {
          const response = await runWithSftpReconnect('read', (activeSessionId) =>
            listSftpDirectory(activeSessionId, { path: ancestorPath }),
          );
          if (isCancelled?.()) {
            return;
          }

          const sortedEntries = sortSftpEntries(response.data.entries);
          directoryCacheRef.current = {
            ...directoryCacheRef.current,
            [ancestorPath]: {
              path: response.data.path,
              parentPath: response.data.parentPath,
              entries: sortedEntries,
            },
            [response.data.path]: {
              path: response.data.path,
              parentPath: response.data.parentPath,
              entries: sortedEntries,
            },
          };
          setTreeNodes((previous) =>
            mergeResolvedDirectoryIntoTree(
              previous,
              ancestorPath,
              response.data.path,
              sortedEntries,
              sftpShowHiddenEntriesRef.current,
            ),
          );
        } catch {
          setTreeNodeLoading(ancestorPath, false);
        }
      }
    },
    [runWithSftpReconnect, setTreeNodeLoading],
  );

  const applyDirectoryCacheEntry = React.useCallback(
    (cacheEntry: DirectoryCacheEntry): void => {
      setAddressPath(cacheEntry.path);
      setCurrentPath(cacheEntry.path);
      setParentPath(cacheEntry.parentPath);
      setEntries(cacheEntry.entries);
      resetSelection();
      setFilterQuery('');
      setTreeNodes((previous) =>
        mergeResolvedDirectoryIntoTree(
          previous,
          cacheEntry.path,
          cacheEntry.path,
          cacheEntry.entries,
          sftpShowHiddenEntriesRef.current,
        ),
      );
      setStatus('ready');
      setErrorMessage('');
    },
    [resetSelection],
  );

  const invalidateDirectoryCache = React.useCallback((directoryPath?: string): void => {
    if (!directoryPath) {
      directoryCacheRef.current = {};
      return;
    }

    const nextCache = { ...directoryCacheRef.current };
    delete nextCache[directoryPath];
    directoryCacheRef.current = nextCache;
  }, []);

  const loadDirectory = React.useCallback(
    async (directoryPath: string, options?: DirectoryLoadOptions): Promise<string | null> => {
      const loadGeneration = ++directoryLoadGenerationRef.current;
      setAddressPath(directoryPath);
      const cachedDirectory = directoryCacheRef.current[directoryPath];
      if (cachedDirectory && !options?.forceRefresh) {
        applyDirectoryCacheEntry(cachedDirectory);
        void syncAncestorDirectories(cachedDirectory.path, options?.isCancelled);
        return cachedDirectory.path;
      }

      const shouldPreserveCurrentView = options?.preserveCurrentView === true;
      if (shouldPreserveCurrentView) {
        setIsRefreshingDirectory(true);
      } else {
        setStatus((previous) => (previous === 'connecting' ? 'connecting' : 'loading'));
      }

      setErrorMessage('');
      setTreeNodeLoading(directoryPath, true);

      try {
        const response = await runWithSftpReconnect('read', (activeSessionId) =>
          listSftpDirectory(activeSessionId, { path: directoryPath }),
        );
        if (options?.isCancelled?.()) {
          setIsRefreshingDirectory(false);
          return null;
        }
        if (loadGeneration !== directoryLoadGenerationRef.current) {
          return null;
        }

        const sortedEntries = sortSftpEntries(response.data.entries);
        setAddressPath(response.data.path);
        setCurrentPath(response.data.path);
        setParentPath(response.data.parentPath);
        setEntries(sortedEntries);
        if (!shouldPreserveCurrentView) {
          resetSelection();
          setFilterQuery('');
        } else {
          pruneSelectionToEntries(sortedEntries);
        }
        setTreeNodes((previous) =>
          mergeResolvedDirectoryIntoTree(
            previous,
            directoryPath,
            response.data.path,
            sortedEntries,
            sftpShowHiddenEntriesRef.current,
          ),
        );
        setIsRefreshingDirectory(false);
        directoryCacheRef.current = {
          ...directoryCacheRef.current,
          [directoryPath]: {
            path: response.data.path,
            parentPath: response.data.parentPath,
            entries: sortedEntries,
          },
          [response.data.path]: {
            path: response.data.path,
            parentPath: response.data.parentPath,
            entries: sortedEntries,
          },
        };
        setStatus('ready');
        void syncAncestorDirectories(response.data.path, options?.isCancelled);
        return response.data.path;
      } catch (error: unknown) {
        if (options?.isCancelled?.()) {
          setIsRefreshingDirectory(false);
          return null;
        }
        if (loadGeneration !== directoryLoadGenerationRef.current) {
          return null;
        }

        const message = error instanceof Error ? error.message : t('sftp.loadFailed');
        setIsRefreshingDirectory(false);
        setTreeNodeLoading(directoryPath, false);
        void syncAncestorDirectories(directoryPath, options?.isCancelled);
        setErrorMessage(message);
        if (!shouldPreserveCurrentView) {
          setStatus('error');
        }

        notifyError(message);
        return null;
      }
    },
    [
      applyDirectoryCacheEntry,
      notifyError,
      pruneSelectionToEntries,
      resetSelection,
      runWithSftpReconnect,
      setTreeNodeLoading,
      syncAncestorDirectories,
    ],
  );

  const loadTreeDirectoryChildren = React.useCallback(
    async (directoryPath: string): Promise<void> => {
      const cachedDirectory = directoryCacheRef.current[directoryPath];
      if (cachedDirectory) {
        setTreeNodes((previous) =>
          mergeResolvedDirectoryIntoTree(
            previous,
            directoryPath,
            cachedDirectory.path,
            cachedDirectory.entries,
            sftpShowHiddenEntriesRef.current,
          ),
        );
        return;
      }

      setTreeNodeLoading(directoryPath, true);

      try {
        const response = await runWithSftpReconnect('read', (activeSessionId) =>
          listSftpDirectory(activeSessionId, { path: directoryPath }),
        );
        const sortedEntries = sortSftpEntries(response.data.entries);
        directoryCacheRef.current = {
          ...directoryCacheRef.current,
          [directoryPath]: {
            path: response.data.path,
            parentPath: response.data.parentPath,
            entries: sortedEntries,
          },
          [response.data.path]: {
            path: response.data.path,
            parentPath: response.data.parentPath,
            entries: sortedEntries,
          },
        };
        setTreeNodes((previous) =>
          mergeResolvedDirectoryIntoTree(
            previous,
            directoryPath,
            response.data.path,
            sortedEntries,
            sftpShowHiddenEntriesRef.current,
          ),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : t('sftp.loadFailed');
        setTreeNodeLoading(directoryPath, false);
        notifyError(message);
      }
    },
    [notifyError, runWithSftpReconnect, setTreeNodeLoading],
  );

  const createSessionForIntent = React.useCallback(
    async (isCancelled = (): boolean => false): Promise<void> => {
      if (!connectionIntent?.serverId) {
        setStatus('idle');
        return;
      }

      setStatus('connecting');
      setErrorMessage('');
      const systemProxyRules = await resolveSystemProxyRulesForServerId(connectionIntent.serverId);

      let shouldRetry = true;
      while (shouldRetry) {
        shouldRetry = false;
        const response = await createSftpSession({
          serverId: connectionIntent.serverId,
          initialPath: connectionIntent.initialPath ?? '.',
          connectTimeoutSec: 45,
          systemProxyRules,
        });

        if (!response.success && response.code === 'SSH_HOST_UNTRUSTED') {
          const accepted = await requestHostFingerprintTrust({
            serverId: response.data.serverId,
            host: response.data.host,
            port: response.data.port,
            algorithm: response.data.algorithm,
            fingerprint: response.data.fingerprint,
          });

          if (!accepted) {
            throw new Error(t('ssh.hostFingerprintNotTrusted'));
          }

          await trustSshFingerprint({
            serverId: response.data.serverId,
            fingerprintSha256: response.data.fingerprint,
            algorithm: response.data.algorithm,
          });
          shouldRetry = true;
          continue;
        }

        const nextSessionId = response.data.sessionId;
        if (isCancelled()) {
          await closeSftpSession(nextSessionId).catch(() => undefined);
          return;
        }

        sessionIdRef.current = nextSessionId;
        setSessionId(nextSessionId);
        const loadedPath = await loadDirectory(response.data.currentPath, { isCancelled });

        if (!isCancelled() && loadedPath) {
          setNavigationState({ paths: [loadedPath], index: 0 });
        }

        if (isCancelled()) {
          await closeSftpSession(nextSessionId).catch(() => undefined);
        }
      }
    },
    [connectionIntent?.initialPath, connectionIntent?.serverId, loadDirectory, requestHostFingerprintTrust],
  );

  React.useEffect(() => {
    let isCancelled = false;

    const run = async (): Promise<void> => {
      if (!connectionIntent?.serverId) {
        return;
      }

      const previousSessionId = sessionIdRef.current;
      if (previousSessionId) {
        await closeSftpSession(previousSessionId).catch(() => undefined);
        if (!isCancelled) {
          setSessionId('');
        }
      }

      if (!isCancelled) {
        setEntries([]);
        setSelectedPaths([]);
        setSelectionAnchorPath('');
        forceClearPreviewState();
        setTreeNodes({});
        setClipboardState(null);
        stopAllWatchedOpenFiles();
        cleanupAllStagedUploadFiles();
        temporaryOpenFilePathsRef.current = {};
        imagePreviewTempFilesRef.current = {};
        setOpenWithApplicationsByPath({});
        setLoadingOpenWithPath('');
        setPendingCreate(null);
        setRenamingEntryPath('');
        resetTaskQueue();
        directoryCacheRef.current = {};
        setAddressPath(connectionIntent.initialPath ?? '.');
        setCurrentPath(connectionIntent.initialPath ?? '.');
        setParentPath(undefined);
        setNavigationState({ paths: [], index: -1 });
        setFilterQuery('');
      }

      try {
        await createSessionForIntent(() => isCancelled);
      } catch (error: unknown) {
        if (isCancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : t('sftp.sessionInitFailed');
        setErrorMessage(message);
        setStatus('error');
        notifyError(message);
      }
    };

    void run();

    return () => {
      isCancelled = true;
      resolveHostFingerprintPrompt(false);
    };
  }, [
    connectionIntent?.createdAt,
    connectionIntent?.initialPath,
    connectionIntent?.serverId,
    cleanupAllStagedUploadFiles,
    createSessionForIntent,
    forceClearPreviewState,
    notifyError,
    resetTaskQueue,
    resolveHostFingerprintPrompt,
    setSelectedPaths,
    setSelectionAnchorPath,
    stopAllWatchedOpenFiles,
  ]);

  React.useEffect(() => {
    return () => {
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) {
        void closeSftpSession(activeSessionId);
      }
    };
  }, []);

  const handleHistoryJump = React.useCallback(
    async (nextIndex: number): Promise<void> => {
      if (!hasSftpSession || nextIndex < 0 || nextIndex >= navigationState.paths.length) {
        return;
      }

      const targetPath = navigationState.paths[nextIndex];
      if (!targetPath) {
        return;
      }

      const loadedPath = await loadDirectory(targetPath);
      if (!loadedPath) {
        return;
      }

      setNavigationState((previous) => {
        const nextPaths = [...previous.paths];
        nextPaths[nextIndex] = loadedPath;
        return { paths: nextPaths, index: nextIndex };
      });
    },
    [hasSftpSession, loadDirectory, navigationState.paths],
  );

  /**
   * Renders direct SFTP history jump choices for a toolbar navigation button.
   *
   * @param items Reachable history targets for the button direction.
   * @returns Context-menu items that jump directly to the selected history entry.
   */
  const renderNavigationHistoryMenuItems = React.useCallback(
    (items: NavigationHistoryMenuItem[]): React.ReactNode => {
      return items.map((item) => (
        <ContextMenuItem
          key={`${item.index}:${item.path}`}
          aria-label={t('sftp.actions.historyJump', { path: item.path })}
          disabled={isBusy}
          onSelect={() => {
            void handleHistoryJump(item.index);
          }}
        >
          <span
            className="min-w-0 flex-1 truncate"
            title={t('sftp.actions.historyJump', { path: item.path })}
          >
            {item.path}
          </span>
        </ContextMenuItem>
      ));
    },
    [handleHistoryJump, isBusy],
  );

  /**
   * Renders a toolbar history button, only mounting its context menu when it has jump targets.
   *
   * @param options Button label, icon, enabled state, step handler, and direct jump targets.
   * @returns Toolbar navigation control with optional history context menu.
   */
  const renderNavigationHistoryControl = ({
    label,
    icon,
    items,
    disabled,
    onStep,
  }: NavigationHistoryControlOptions): React.ReactNode => {
    if (items.length === 0) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={label}
              variant="ghostIcon"
              disabled={disabled}
              onClick={onStep}
            >
              {icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      );
    }

    return (
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              <Button
                aria-label={label}
                variant="ghostIcon"
                disabled={disabled}
                onClick={onStep}
              >
                {icon}
              </Button>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <ContextMenuContent className="min-w-[220px]">{renderNavigationHistoryMenuItems(items)}</ContextMenuContent>
      </ContextMenu>
    );
  };

  const navigateToPath = React.useCallback(
    async (directoryPath: string): Promise<boolean> => {
      const trimmedPath = directoryPath.trim();
      if (!hasSftpSession || !trimmedPath) {
        return false;
      }

      const loadedPath = await loadDirectory(trimmedPath);
      if (!loadedPath) {
        return false;
      }

      setNavigationState((previous) => {
        const currentHistoryPath = previous.paths[previous.index];
        if (currentHistoryPath === loadedPath) {
          return previous;
        }

        const retainedPaths = previous.index >= 0 ? previous.paths.slice(0, previous.index + 1) : [];
        const nextPaths = [...retainedPaths, loadedPath];
        return { paths: nextPaths, index: nextPaths.length - 1 };
      });
      return true;
    },
    [hasSftpSession, loadDirectory],
  );

  const {
    addressInputContextMenuItems,
    addressInputRef,
    isAddressInputEditing,
    pathInput,
    keepAddressInputDuringContextMenu,
    handleAddressInputPointerDown,
    handleEditCurrentPath,
    handlePathInputBlur,
    handlePathInputKeyDown,
    handlePathSubmit,
    handleShowAddressAsText,
    setPathInput,
  } = useSftpAddressInputController({
    addressPath,
    sftpShowAddressAsText,
    navigateToPath,
    setSftpAddressDisplayMode,
  });

  const handleRefresh = React.useCallback(() => {
    if (!hasSftpSession) {
      return;
    }

    void loadDirectory(currentPath, { forceRefresh: true, preserveCurrentView: true });
  }, [currentPath, hasSftpSession, loadDirectory]);

  const handleTreeDirectoryRefresh = React.useCallback(
    (directoryPath: string): void => {
      if (!hasSftpSession) {
        return;
      }

      invalidateDirectoryCache(directoryPath);
      if (directoryPath === currentPath) {
        void loadDirectory(directoryPath, { forceRefresh: true, preserveCurrentView: true });
        return;
      }

      void loadTreeDirectoryChildren(directoryPath);
    },
    [currentPath, hasSftpSession, invalidateDirectoryCache, loadDirectory, loadTreeDirectoryChildren],
  );

  const refreshCurrentDirectoryAfterOperation = React.useCallback(
    async (affectedDirectoryPaths: readonly string[] = []): Promise<void> => {
      affectedDirectoryPaths.forEach((directoryPath) => {
        pendingDirectoryRefreshPathsRef.current.add(directoryPath);
      });
      const existingRefresh = currentDirectoryRefreshPromiseRef.current;
      if (existingRefresh) {
        await existingRefresh;
        return;
      }

      const refreshPromise = (async (): Promise<void> => {
        while (sessionIdRef.current) {
          const activePath = currentPathRef.current;
          const pathsToInvalidate = Array.from(new Set([activePath, ...pendingDirectoryRefreshPathsRef.current]));
          pendingDirectoryRefreshPathsRef.current.clear();
          pathsToInvalidate.forEach((directoryPath) => {
            invalidateDirectoryCache(directoryPath);
          });
          pathsToInvalidate
            .filter((directoryPath) => directoryPath !== activePath)
            .forEach((directoryPath) => {
              void loadTreeDirectoryChildren(directoryPath);
            });

          await loadDirectory(activePath, {
            forceRefresh: true,
            preserveCurrentView: true,
          });
          if (pendingDirectoryRefreshPathsRef.current.size === 0) {
            return;
          }
        }
      })();
      currentDirectoryRefreshPromiseRef.current = refreshPromise;
      try {
        await refreshPromise;
      } finally {
        if (currentDirectoryRefreshPromiseRef.current === refreshPromise) {
          currentDirectoryRefreshPromiseRef.current = null;
        }
      }
    },
    [invalidateDirectoryCache, loadDirectory, loadTreeDirectoryChildren],
  );

  /**
   * Updates an opened-file watcher with fresh remote metadata from the directory cache.
   *
   * @param remotePath Remote file path to refresh.
   * @returns void.
   */
  const syncWatchedOpenFileSnapshotFromCache = React.useCallback((remotePath: string): void => {
    const parentDirectoryPath = resolveEntryParentPath(remotePath);
    const cacheEntry = parentDirectoryPath ? directoryCacheRef.current[parentDirectoryPath] : undefined;
    const refreshedEntry = cacheEntry?.entries.find((entry) => entry.path === remotePath && entry.type === 'file');
    const watchedFile = watchedOpenFilesRef.current[remotePath];
    if (!watchedFile || !refreshedEntry) {
      return;
    }

    watchedOpenFilesRef.current = {
      ...watchedOpenFilesRef.current,
      [remotePath]: {
        ...watchedFile,
        remoteSnapshot: {
          size: refreshedEntry.size,
          modifiedAt: refreshedEntry.modifiedAt,
        },
      },
    };
  }, []);

  const beginRenameEntry = React.useCallback(
    (entry: ApiSftpEntry): void => {
      setPendingCreate(null);
      selectSingleEntry(entry);
      setRenamingEntryPath(entry.path);
      setRenameInput(entry.name);
    },
    [selectSingleEntry],
  );

  const cancelInlineEdit = React.useCallback((): void => {
    setRenamingEntryPath('');
    setRenameInput('');
    setPendingCreate(null);
  }, []);

  const commitRenameEntry = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      const nextName = renameInput.trim();
      cancelInlineEdit();
      if (!nextName || nextName === entry.name || !hasSftpSession) {
        return;
      }

      const targetPath = resolveRenameTargetPath(entry, nextName);
      runSftpOperation(
        {
          label: t('sftp.tasks.rename'),
          detail: entry.name,
          progress: { completed: 0, total: 1 },
        },
        async ({ isCurrent, update }) => {
          update({ detail: `${entry.name} -> ${nextName}`, progress: { completed: 0, total: 1 } });
          await runWithSftpReconnect('mutation', (activeSessionId) =>
            renameSftpEntry(activeSessionId, {
              sourcePath: entry.path,
              targetPath,
            }),
          );
          update({ progress: { completed: 1, total: 1 } });
          if (!isCurrent()) {
            return;
          }

          notifySuccess(t('sftp.feedback.renamed'));
          await refreshCurrentDirectoryAfterOperation([
            resolveEntryParentPath(entry.path),
            resolveEntryParentPath(targetPath),
          ]);
          if (currentPathRef.current === resolveEntryParentPath(targetPath)) {
            setSelectedPaths([targetPath]);
            setSelectionAnchorPath(targetPath);
          }
        },
      );
    },
    [
      cancelInlineEdit,
      notifySuccess,
      hasSftpSession,
      refreshCurrentDirectoryAfterOperation,
      renameInput,
      runSftpOperation,
      runWithSftpReconnect,
      setSelectedPaths,
      setSelectionAnchorPath,
    ],
  );

  const commitPendingCreate = React.useCallback(async (): Promise<void> => {
    const draft = pendingCreate;
    const nextName = renameInput.trim();
    cancelInlineEdit();
    if (!draft || !nextName || !hasSftpSession) {
      return;
    }

    const targetPath = joinRemotePath(currentPath, nextName);
    runSftpOperation(
      {
        label: draft.type === 'directory' ? t('sftp.tasks.createFolder') : t('sftp.tasks.createFile'),
        detail: nextName,
        progress: { completed: 0, total: 1 },
      },
      async ({ isCurrent, update }) => {
        await runWithSftpReconnect('mutation', (activeSessionId) =>
          draft.type === 'directory'
            ? createSftpDirectory(activeSessionId, { path: targetPath })
            : createSftpFile(activeSessionId, { path: targetPath }),
        );

        update({ progress: { completed: 1, total: 1 } });
        if (!isCurrent()) {
          return;
        }

        notifySuccess(
          draft.type === 'directory' ? t('sftp.feedback.directoryCreated') : t('sftp.feedback.fileCreated'),
        );
        await refreshCurrentDirectoryAfterOperation([resolveEntryParentPath(targetPath)]);
        if (currentPathRef.current === resolveEntryParentPath(targetPath)) {
          setSelectedPaths([targetPath]);
          setSelectionAnchorPath(targetPath);
        }
      },
    );
  }, [
    cancelInlineEdit,
    currentPath,
    hasSftpSession,
    notifySuccess,
    pendingCreate,
    refreshCurrentDirectoryAfterOperation,
    renameInput,
    runSftpOperation,
    runWithSftpReconnect,
    setSelectedPaths,
    setSelectionAnchorPath,
  ]);

  const beginCreateEntry = React.useCallback(
    (type: PendingCreateState['type']): void => {
      if (!canUseFileActions) {
        return;
      }

      setRenamingEntryPath('');
      resetSelection();
      setPendingCreate({
        type,
        name: type === 'directory' ? NEW_DIRECTORY_NAME : NEW_FILE_NAME,
      });
      setRenameInput(type === 'directory' ? NEW_DIRECTORY_NAME : NEW_FILE_NAME);
    },
    [canUseFileActions, resetSelection],
  );

  const beginCreateEntryInDirectory = React.useCallback(
    async (type: PendingCreateState['type'], directoryPath = currentPath): Promise<void> => {
      if (!canUseFileActions) {
        return;
      }

      if (directoryPath !== currentPath) {
        const didNavigate = await navigateToPath(directoryPath);
        if (!didNavigate) {
          return;
        }
      }

      beginCreateEntry(type);
    },
    [beginCreateEntry, canUseFileActions, currentPath, navigateToPath],
  );

  const handleOpenDirectoryInNewTab = React.useCallback(
    (entry: ApiSftpEntry): void => {
      if (entry.type !== 'directory') {
        return;
      }

      onOpenDirectoryInNewTab(entry.path);
    },
    [onOpenDirectoryInNewTab],
  );

  const handleOpenSshAtEntryLocation = React.useCallback(
    (entry: ApiSftpEntry | null, targetDirectoryPath = currentPath): void => {
      const sshPath = entry
        ? entry.type === 'directory'
          ? entry.path
          : resolveRemoteParentPath(entry.path)
        : targetDirectoryPath;
      onOpenSshAtPath(sshPath);
    },
    [currentPath, onOpenSshAtPath],
  );

  /**
   * Opens the containing directory for a symbolic link target.
   *
   * @param entry Symlink entry selected from the SFTP list.
   * @returns Promise resolved after target details are fetched and navigation completes.
   */
  const handleOpenSymlinkTargetLocation = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      if (!hasSftpSession || entry.type !== 'symlink') {
        notifyError(t('sftp.symlinkTargetLocationUnavailable'));
        return;
      }

      try {
        const response = await runWithSftpReconnect('read', (activeSessionId) =>
          getSftpEntryDetails(activeSessionId, { paths: [entry.path] }),
        );
        const detailItem = response.data.entries[0];
        if (detailItem?.status !== 'success' || !detailItem.entry) {
          notifyError(detailItem?.message ?? t('sftp.symlinkTargetLocationUnavailable'));
          return;
        }

        const target = detailItem.entry.symlinkTarget;
        const targetPath = target?.resolvedPath?.trim() ?? '';
        if (!target || !targetPath || target.status !== 'exists') {
          notifyError(t('sftp.symlinkTargetLocationUnavailable'));
          return;
        }

        const targetDirectoryPath = targetPath === '/' ? '/' : resolveEntryParentPath(targetPath);
        const didNavigate = await navigateToPath(targetDirectoryPath);
        if (didNavigate) {
          setSelectedPaths([targetPath]);
          setSelectionAnchorPath(targetPath);
        }
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.symlinkTargetLocationUnavailable'));
      }
    },
    [hasSftpSession, navigateToPath, notifyError, runWithSftpReconnect, setSelectedPaths, setSelectionAnchorPath],
  );

  const copyTextToClipboard = React.useCallback(
    async (value: string, successMessage: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value);
        notifySuccess(successMessage);
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.feedback.copyPathFailed'));
      }
    },
    [notifyError, notifySuccess],
  );

  const handleCopyRemotePath = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      await copyTextToClipboard(entry.path, t('sftp.feedback.pathCopied'));
    },
    [copyTextToClipboard],
  );

  const handleCopyCurrentPath = React.useCallback(async (): Promise<void> => {
    await copyTextToClipboard(addressPath, t('sftp.feedback.pathCopied'));
  }, [addressPath, copyTextToClipboard]);

  const handleCopyRelativeRemotePath = React.useCallback(
    async (relativePath: string): Promise<void> => {
      await copyTextToClipboard(relativePath, t('sftp.feedback.relativePathCopied'));
    },
    [copyTextToClipboard],
  );

  const canUseSftpOpenWith = React.useMemo(() => {
    return window.electron?.platform === 'win32' || window.electron?.platform === 'darwin';
  }, []);

  const resolveDefaultLocalDownloadPath = React.useCallback(async (entry: ApiSftpEntry): Promise<string | null> => {
    return (await window.electron?.createSftpDownloadsFile(sanitizeLocalFileName(entry.name))) ?? null;
  }, []);

  const downloadEntryToLocalPath = React.useCallback(
    async (entry: ApiSftpEntry, localPath: string, transferId?: string): Promise<void> => {
      if (!hasSftpSession || entry.type !== 'file') {
        throw new Error(t('sftp.downloadUnsupported'));
      }

      await runWithSftpReconnect('read', (activeSessionId) =>
        downloadSftpFile(activeSessionId, {
          path: entry.path,
          localPath,
          ...(transferId ? { transferId } : {}),
        }),
      );
    },
    [hasSftpSession, runWithSftpReconnect],
  );

  const downloadEntryToTemporaryPath = React.useCallback(
    async (
      entry: ApiSftpEntry,
      options: { reuseCached?: boolean; shouldCache?: () => boolean } = {},
    ): Promise<string> => {
      const cachedLocalPath = temporaryOpenFilePathsRef.current[entry.path];
      if (cachedLocalPath && options.reuseCached) {
        return cachedLocalPath;
      }

      const localPath =
        cachedLocalPath ?? (await window.electron?.createSftpTemporaryFile(sanitizeLocalFileName(entry.name)));
      if (!localPath) {
        throw new Error(t('sftp.temporaryPathUnavailable'));
      }

      await downloadEntryToLocalPath(entry, localPath);
      if (options.shouldCache?.() ?? true) {
        temporaryOpenFilePathsRef.current[entry.path] = localPath;
      }
      return localPath;
    },
    [downloadEntryToLocalPath],
  );

  /**
   * Downloads one image preview into a renderer-owned temp cache.
   *
   * @param entry Remote image entry to preview.
   * @param options Cache write options.
   * @returns Validated local temp path for main-process data URL loading.
   */
  const downloadEntryToImagePreviewPath = React.useCallback(
    async (entry: ApiSftpEntry, options: { shouldCache?: () => boolean } = {}): Promise<string> => {
      const cachedPreview = imagePreviewTempFilesRef.current[entry.path];
      if (cachedPreview && doesSftpEntryMatchRemoteSnapshot(entry, cachedPreview.remoteSnapshot)) {
        return cachedPreview.localPath;
      }

      const localPath =
        cachedPreview?.localPath ?? (await window.electron?.createSftpTemporaryFile(sanitizeLocalFileName(entry.name)));
      if (!localPath) {
        throw new Error(t('sftp.temporaryPathUnavailable'));
      }

      await downloadEntryToLocalPath(entry, localPath);
      if (options.shouldCache?.() ?? true) {
        imagePreviewTempFilesRef.current[entry.path] = {
          localPath,
          remoteSnapshot: createSftpEntryRemoteSnapshot(entry),
        };
      }

      return localPath;
    },
    [downloadEntryToLocalPath],
  );

  const {
    handleConfirmLargePreview,
    handlePreviewContentChange,
    handlePreviewEditorMount,
    handlePreviewRedo,
    handlePreviewSave,
    handlePreviewUndo,
  } = useSftpPreviewActions({
    activeTextPreview,
    canUseFileActions,
    downloadEntryToImagePreviewPath,
    forceClearPreviewState,
    hasSftpSession,
    isSftpUploadConflictError,
    notifyError,
    notifySuccess,
    previewEditorRef,
    previewLoadGenerationRef,
    previewStateRef,
    refreshCurrentDirectoryAfterOperation,
    requestUploadConflictConfirmation,
    runSftpOperation,
    runWithSftpReconnect,
    selectedCount,
    selectedEntry,
    setPreviewState,
    sftpAuxiliarySidebarMode,
    sftpImagePreviewWarningThresholdBytes,
    sftpTextPreviewWarningThresholdBytes,
  });

  /**
   * Starts watching a temp file opened through SFTP so later local saves can be uploaded.
   *
   * @param entry Remote file entry that produced the temp file.
   * @param localPath Local temp file path controlled by Cosmosh.
   * @returns Promise resolved when the watcher is registered or skipped.
   */
  const registerWatchedOpenFile = React.useCallback(async (entry: ApiSftpEntry, localPath: string): Promise<void> => {
    const electronBridge = window.electron;
    if (!electronBridge?.startSftpTemporaryFileWatch || entry.type !== 'file') {
      return;
    }

    const existing = watchedOpenFilesRef.current[entry.path];
    if (existing) {
      void electronBridge.stopSftpTemporaryFileWatch(existing.watchId);
    }

    const watchId = await electronBridge.startSftpTemporaryFileWatch(localPath);
    watchedOpenFilesRef.current = {
      ...watchedOpenFilesRef.current,
      [entry.path]: {
        remotePath: entry.path,
        name: entry.name,
        localPath,
        watchId,
        openedSessionId: sessionIdRef.current,
        remoteSnapshot: {
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        },
        isPromptOpen: false,
      },
    };
  }, []);

  const handleOpenEntryWithDefaultApplication = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      if (entry.type !== 'file') {
        notifyError(t('sftp.openUnsupported'));
        return;
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.open'),
          detail: entry.name,
          progress: { completed: 0, total: 1 },
        },
        async ({ isCurrent, update }) => {
          const localPath = await downloadEntryToTemporaryPath(entry, { shouldCache: isCurrent });
          update({ progress: { completed: 1, total: 1 } });
          if (!isCurrent()) {
            return;
          }

          const didOpen = await window.electron?.openSftpTemporaryFile(localPath);
          if (!didOpen) {
            throw new Error(t('sftp.openLocalFileFailed'));
          }

          await registerWatchedOpenFile(entry, localPath);
        },
      );
    },
    [downloadEntryToTemporaryPath, notifyError, registerWatchedOpenFile, runSftpOperation],
  );

  const handleOpenEntryWithPicker = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      if (!canUseSftpOpenWith || entry.type !== 'file') {
        notifyError(t('sftp.openWithUnsupported'));
        return;
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.openWith'),
          detail: entry.name,
          progress: { completed: 0, total: 1 },
        },
        async ({ isCurrent, update }) => {
          const localPath = await downloadEntryToTemporaryPath(entry, { shouldCache: isCurrent });
          update({ progress: { completed: 1, total: 1 } });
          if (!isCurrent()) {
            return;
          }

          const didOpen = await window.electron?.showSftpOpenWithDialog(localPath);
          if (!didOpen) {
            throw new Error(t('sftp.openWithFailed'));
          }

          await registerWatchedOpenFile(entry, localPath);
        },
      );
    },
    [canUseSftpOpenWith, downloadEntryToTemporaryPath, notifyError, registerWatchedOpenFile, runSftpOperation],
  );

  const handleOpenEntryWithApplication = React.useCallback(
    async (entry: ApiSftpEntry, application: SftpOpenWithApplication): Promise<void> => {
      if (entry.type !== 'file') {
        notifyError(t('sftp.openWithUnsupported'));
        return;
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.openWith'),
          detail: `${entry.name} - ${application.name}`,
          progress: { completed: 0, total: 1 },
        },
        async ({ isCurrent, update }) => {
          const localPath = await downloadEntryToTemporaryPath(entry, { shouldCache: isCurrent });
          update({ progress: { completed: 1, total: 1 } });
          if (!isCurrent()) {
            return;
          }

          const didOpen = await window.electron?.openSftpFileWithApplication(localPath, application.path);
          if (!didOpen) {
            throw new Error(t('sftp.openWithFailed'));
          }

          await registerWatchedOpenFile(entry, localPath);
        },
      );
    },
    [downloadEntryToTemporaryPath, notifyError, registerWatchedOpenFile, runSftpOperation],
  );

  const loadOpenWithApplications = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      if (window.electron?.platform !== 'darwin' || entry.type !== 'file') {
        return;
      }

      setLoadingOpenWithPath(entry.path);
      try {
        const localPath = await downloadEntryToTemporaryPath(entry, { reuseCached: true });
        const applications = (await window.electron?.listSftpOpenWithApplications(localPath)) ?? [];
        setOpenWithApplicationsByPath((previous) => ({
          ...previous,
          [entry.path]: applications,
        }));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.openWithApplicationsUnavailable'));
      } finally {
        setLoadingOpenWithPath((previous) => (previous === entry.path ? '' : previous));
      }
    },
    [downloadEntryToTemporaryPath, notifyError],
  );

  const handleOpenEntry = React.useCallback(
    async (entry: ApiSftpEntry): Promise<void> => {
      selectSingleEntry(entry);
      if (entry.type === 'directory') {
        await navigateToPath(entry.path);
        return;
      }

      if (entry.type !== 'file' || !hasSftpSession) {
        notifyError(t('sftp.openUnsupported'));
        return;
      }

      handleOpenEntryWithDefaultApplication(entry);
    },
    [handleOpenEntryWithDefaultApplication, hasSftpSession, navigateToPath, notifyError, selectSingleEntry],
  );

  const handleDownloadEntry = React.useCallback(
    async (entry: ApiSftpEntry, mode: 'downloads' | 'choose'): Promise<void> => {
      if (!hasSftpSession || entry.type !== 'file') {
        notifyError(t('sftp.downloadUnsupported'));
        return;
      }

      const defaultLocalPath = await resolveDefaultLocalDownloadPath(entry);
      if (!defaultLocalPath) {
        notifyError(t('sftp.downloadPathUnavailable'));
        return;
      }

      const localPath =
        mode === 'downloads'
          ? defaultLocalPath
          : (await window.electron?.showSaveFileDialog(defaultLocalPath))?.filePath;

      if (!localPath) {
        return;
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.download'),
          detail: entry.name,
          progress: { completed: 0, total: entry.size, unit: 'bytes', bytesPerSecond: 0 },
        },
        async ({ isCurrent, update }) => {
          const transferId = crypto.randomUUID();
          await runTrackedSftpTransfer(transferId, { isCurrent, update }, () =>
            downloadEntryToLocalPath(entry, localPath, transferId),
          );
          if (!isCurrent()) {
            return;
          }

          notifySuccess(t('sftp.feedback.downloaded', { path: localPath }));
        },
      );
    },
    [
      downloadEntryToLocalPath,
      notifyError,
      notifySuccess,
      resolveDefaultLocalDownloadPath,
      runTrackedSftpTransfer,
      runSftpOperation,
      hasSftpSession,
    ],
  );

  /**
   * Removes one native-picker upload staging file after its queued task settles.
   *
   * @param localPath Controlled SFTP temp file path.
   * @returns Promise resolved after best-effort cleanup.
   */
  const cleanupStagedUploadFile = React.useCallback(async (localPath: string): Promise<void> => {
    stagedUploadPathsRef.current.delete(localPath);
    try {
      await window.electron?.cleanupSftpTemporaryFiles([localPath]);
    } catch {
      // Staging cleanup must not hide the upload result from the task queue.
    }
  }, []);

  /**
   * Shows a warning for dropped local entries that cannot enter the current upload pipeline.
   *
   * @param rejectedEntries Local entries rejected by preload/main staging.
   * @returns void.
   */
  const notifyRejectedDroppedUploadEntries = React.useCallback(
    (rejectedEntries: readonly SftpUploadRejectedLocalEntry[] = []): void => {
      if (rejectedEntries.length === 0) {
        return;
      }

      const rejectedDirectoryCount = rejectedEntries.filter((entry) => entry.reason === 'directory-unsupported').length;
      if (rejectedDirectoryCount === rejectedEntries.length) {
        notifyWarning(t('sftp.uploadDropDirectoriesUnsupported', { count: rejectedDirectoryCount }));
        return;
      }

      notifyWarning(t('sftp.uploadDropSomeItemsSkipped', { count: rejectedEntries.length }));
    },
    [notifyWarning],
  );

  /**
   * Queues staged local files for upload into one remote directory.
   *
   * @param files Main-staged local files under the controlled SFTP temp root.
   * @param targetDirectoryPath Remote destination directory, defaulting to the visible directory.
   * @returns void.
   */
  const queueStagedSftpUploadFiles = React.useCallback(
    (files: readonly SftpUploadLocalFile[], targetDirectoryPath = currentPath): void => {
      if (files.length === 0) {
        return;
      }

      files.forEach((file: SftpUploadLocalFile) => {
        stagedUploadPathsRef.current.add(file.localPath);
        const remotePath = joinRemotePath(targetDirectoryPath, file.name);
        runSftpOperation(
          {
            label: t('sftp.tasks.upload'),
            detail: file.name,
            progress: { completed: 0, total: file.size, unit: 'bytes', bytesPerSecond: 0 },
          },
          async ({ isCurrent, update }) => {
            const transferId = crypto.randomUUID();
            const uploadPayload: ApiSftpUploadFileRequest = {
              path: remotePath,
              localPath: file.localPath,
              transferId,
            };

            try {
              try {
                await runTrackedSftpTransfer(transferId, { isCurrent, update }, () =>
                  runWithSftpReconnect('mutation', (activeSessionId) => uploadSftpFile(activeSessionId, uploadPayload)),
                );
              } catch (error: unknown) {
                if (!isSftpUploadConflictError(error) || !isCurrent()) {
                  throw error;
                }

                const shouldOverwrite = await requestUploadConflictConfirmation({
                  remotePath,
                  name: file.name,
                  localPath: file.localPath,
                  size: file.size,
                  modifiedAt: file.modifiedAt,
                });
                if (!shouldOverwrite || !isCurrent()) {
                  update({
                    detail: t('sftp.tasks.uploadSkipped'),
                    errorMessage: undefined,
                    progress: undefined,
                  });
                  return;
                }

                await runTrackedSftpTransfer(transferId, { isCurrent, update }, () =>
                  runWithSftpReconnect('mutation', (activeSessionId) =>
                    uploadSftpFile(activeSessionId, {
                      ...uploadPayload,
                      overwrite: true,
                    }),
                  ),
                );
              }

              if (!isCurrent()) {
                return;
              }

              notifySuccess(t('sftp.feedback.uploadedFile', { name: file.name }));
              await refreshCurrentDirectoryAfterOperation([targetDirectoryPath]);
            } finally {
              await cleanupStagedUploadFile(file.localPath);
            }
          },
        );
      });
    },
    [
      cleanupStagedUploadFile,
      currentPath,
      isSftpUploadConflictError,
      notifySuccess,
      refreshCurrentDirectoryAfterOperation,
      requestUploadConflictConfirmation,
      runTrackedSftpTransfer,
      runSftpOperation,
      runWithSftpReconnect,
    ],
  );

  /**
   * Opens the native file picker and queues each selected file for upload.
   *
   * @param targetDirectoryPath Remote destination directory, defaulting to the visible directory.
   * @returns Promise resolved after selected files are staged and queued.
   */
  const handleUploadFiles = React.useCallback(
    async (targetDirectoryPath = currentPath): Promise<void> => {
      const electronBridge = window.electron;
      if (!canUseFileActions || !electronBridge?.selectSftpUploadFiles) {
        notifyError(t('sftp.uploadUnsupported'));
        return;
      }

      let selection: Awaited<ReturnType<typeof electronBridge.selectSftpUploadFiles>>;
      try {
        selection = await electronBridge.selectSftpUploadFiles();
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.uploadSelectionFailed'));
        return;
      }

      if (selection.canceled) {
        return;
      }

      queueStagedSftpUploadFiles(selection.files, targetDirectoryPath);
    },
    [canUseFileActions, currentPath, notifyError, queueStagedSftpUploadFiles],
  );

  /**
   * Stages and uploads files dropped from the host OS onto an SFTP directory target.
   *
   * @param files Browser File objects from the drop event.
   * @param targetDirectoryPath Remote destination directory.
   * @returns Promise resolved after dropped files are staged and queued.
   */
  const handleDroppedLocalFilesUpload = React.useCallback(
    async (files: File[], targetDirectoryPath: string): Promise<void> => {
      const electronBridge = window.electron;
      if (!canUseFileActions || !electronBridge?.stageDroppedSftpUploadFiles) {
        notifyError(t('sftp.uploadUnsupported'));
        return;
      }

      try {
        const selection = await electronBridge.stageDroppedSftpUploadFiles(files);
        notifyRejectedDroppedUploadEntries(selection.rejectedEntries ?? []);
        queueStagedSftpUploadFiles(selection.files, targetDirectoryPath);
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.uploadDropStagingFailed'));
      }
    },
    [canUseFileActions, notifyError, notifyRejectedDroppedUploadEntries, queueStagedSftpUploadFiles],
  );

  const {
    activeDropTarget,
    handleCreateLinkFromClipboard,
    handleDirectoryDropTargetDragEnter,
    handleDirectoryDropTargetDragLeave,
    handleDirectoryDropTargetDragOver,
    handleDirectoryDropTargetDrop,
    handleDirectoryDropTargetReject,
    handlePendingDropOperationSelect,
    handleSftpEntryDragEnd,
    handleSftpEntryDragStart,
    pendingDropOperationMenu,
    setPendingDropOperationMenu,
  } = useSftpDragDropController({
    canUseFileActions,
    clipboardState,
    currentPath,
    hasSftpSession,
    imagePreviewTempFilesRef,
    notifyError,
    notifySuccess,
    onUploadDroppedLocalFiles: handleDroppedLocalFilesUpload,
    refreshCurrentDirectoryAfterOperation,
    runSftpOperation,
    runWithSftpReconnect,
    selectedEntries,
    selectedPathSet,
    sessionId,
    setOpenWithApplicationsByPath,
    setPreviewState,
    setSelectedPaths,
    setSelectionAnchorPath,
    sftpInternalDragDefaultAction,
    sftpInternalDragModifierAction,
    temporaryOpenFilePathsRef,
  });

  /**
   * Resolves the upload prompt raised by an edited temp file.
   *
   * @param accepted Whether the user wants to upload the changed temp file.
   * @returns void.
   */
  const resolveUploadConfirmationPrompt = React.useCallback(
    (accepted: boolean): void => {
      const prompt = uploadConfirmationPrompt;
      if (!prompt) {
        return;
      }

      const watchedFile = watchedOpenFilesRef.current[prompt.remotePath];
      if (!watchedFile) {
        setUploadConfirmationPrompt(null);
        return;
      }

      watchedOpenFilesRef.current = {
        ...watchedOpenFilesRef.current,
        [prompt.remotePath]: {
          ...watchedFile,
          isPromptOpen: false,
          pendingChange: undefined,
        },
      };
      setUploadConfirmationPrompt(null);

      if (!accepted) {
        return;
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.upload'),
          detail: watchedFile.name,
          progress: { completed: 0, total: prompt.size, unit: 'bytes', bytesPerSecond: 0 },
        },
        async ({ isCurrent, update }) => {
          const transferId = crypto.randomUUID();
          const uploadPayload: ApiSftpUploadFileRequest = {
            path: watchedFile.remotePath,
            localPath: watchedFile.localPath,
            transferId,
            expectedSize: watchedFile.remoteSnapshot.size,
            expectedModifiedAt: watchedFile.remoteSnapshot.modifiedAt,
          };
          let response: ApiSftpUploadFileResponse;
          try {
            response = await runTrackedSftpTransfer(transferId, { isCurrent, update }, () =>
              runWithSftpReconnect('mutation', (activeSessionId) => uploadSftpFile(activeSessionId, uploadPayload)),
            );
          } catch (error: unknown) {
            if (!isSftpUploadConflictError(error) || !isCurrent()) {
              throw error;
            }

            const shouldOverwrite = await requestUploadConflictConfirmation({
              remotePath: watchedFile.remotePath,
              name: watchedFile.name,
              localPath: watchedFile.localPath,
              size: prompt.size,
              modifiedAt: prompt.modifiedAt,
            });
            if (!shouldOverwrite || !isCurrent()) {
              update({
                detail: t('sftp.tasks.uploadSkipped'),
                errorMessage: undefined,
                progress: undefined,
              });
              return;
            }

            response = await runTrackedSftpTransfer(transferId, { isCurrent, update }, () =>
              runWithSftpReconnect('mutation', (activeSessionId) =>
                uploadSftpFile(activeSessionId, {
                  ...uploadPayload,
                  overwrite: true,
                }),
              ),
            );
          }

          if (!isCurrent()) {
            return;
          }

          watchedOpenFilesRef.current = {
            ...watchedOpenFilesRef.current,
            [watchedFile.remotePath]: {
              ...watchedFile,
              remoteSnapshot: {
                size: response.data.size ?? prompt.size,
                modifiedAt: response.data.modifiedAt ?? prompt.modifiedAt,
              },
              pendingChange: undefined,
              isPromptOpen: false,
            },
          };

          notifySuccess(t('sftp.feedback.uploaded'));
          await refreshCurrentDirectoryAfterOperation([resolveEntryParentPath(watchedFile.remotePath)]);
          syncWatchedOpenFileSnapshotFromCache(watchedFile.remotePath);
        },
      );
    },
    [
      isSftpUploadConflictError,
      notifySuccess,
      refreshCurrentDirectoryAfterOperation,
      requestUploadConflictConfirmation,
      runTrackedSftpTransfer,
      runSftpOperation,
      runWithSftpReconnect,
      setUploadConfirmationPrompt,
      syncWatchedOpenFileSnapshotFromCache,
      uploadConfirmationPrompt,
    ],
  );

  const handleCopyEntries = React.useCallback(
    (targetEntries: ApiSftpEntry[]): void => {
      const entriesToCopy = dedupeSftpEntries(targetEntries);
      if (entriesToCopy.length === 0) {
        return;
      }

      setClipboardState({ mode: 'copy', entries: entriesToCopy });
      setSelectedPaths(entriesToCopy.map((entry) => entry.path));
      setSelectionAnchorPath(entriesToCopy[entriesToCopy.length - 1]?.path ?? '');
    },
    [setSelectedPaths, setSelectionAnchorPath],
  );

  const handleCutEntries = React.useCallback(
    (targetEntries: ApiSftpEntry[]): void => {
      const entriesToCut = dedupeSftpEntries(targetEntries);
      if (entriesToCut.length === 0) {
        return;
      }

      setClipboardState({ mode: 'cut', entries: entriesToCut });
      setSelectedPaths(entriesToCut.map((entry) => entry.path));
      setSelectionAnchorPath(entriesToCut[entriesToCut.length - 1]?.path ?? '');
    },
    [setSelectedPaths, setSelectionAnchorPath],
  );

  const handlePasteEntry = React.useCallback(
    async (targetDirectoryPath = currentPath): Promise<void> => {
      if (!clipboardState || !hasSftpSession || clipboardState.entries.length === 0) {
        return;
      }

      const entriesToPaste = clipboardState.entries;
      const operationLabel = clipboardState.mode === 'copy' ? t('sftp.tasks.copy') : t('sftp.tasks.move');
      const operationMode = clipboardState.mode;
      runSftpOperation(
        {
          label: operationLabel,
          detail: targetDirectoryPath,
          progress: { completed: 0, total: entriesToPaste.length },
        },
        async ({ isCurrent, update }) => {
          const response = await runWithSftpReconnect('mutation', (activeSessionId) =>
            runSftpBatchOperation(activeSessionId, {
              operation: operationMode === 'copy' ? 'copy' : 'move',
              targetDirectoryPath,
              entries: entriesToPaste.map((entry) => ({
                path: entry.path,
                type: entry.type,
              })),
            }),
          );
          update({ progress: { completed: response.data.completedCount, total: response.data.totalCount } });
          if (!isCurrent()) {
            return;
          }

          const partialFailureMessage =
            response.data.failedCount > 0 ? formatBatchPartialFailureFeedback(response.data) : null;
          if (operationMode === 'copy') {
            if (!partialFailureMessage) {
              notifySuccess(
                formatBatchFeedback(response.data.completedCount, 'sftp.feedback.copied', 'sftp.feedback.copiedMany'),
              );
            }
          } else {
            setClipboardState((previous) =>
              isSameClipboardSnapshot(previous, operationMode, entriesToPaste) ? null : previous,
            );
            if (!partialFailureMessage) {
              notifySuccess(
                formatBatchFeedback(response.data.completedCount, 'sftp.feedback.moved', 'sftp.feedback.movedMany'),
              );
            }
          }

          await refreshCurrentDirectoryAfterOperation([
            ...entriesToPaste.map((entry) => resolveEntryParentPath(entry.path)),
            targetDirectoryPath,
          ]);
          if (partialFailureMessage) {
            throw new Error(partialFailureMessage);
          }
        },
      );
    },
    [
      clipboardState,
      currentPath,
      hasSftpSession,
      notifySuccess,
      refreshCurrentDirectoryAfterOperation,
      runSftpOperation,
      runWithSftpReconnect,
    ],
  );

  const handleDeleteEntries = React.useCallback(
    async (targetEntries: ApiSftpEntry[], source: SftpDeleteInvocationSource = 'action'): Promise<void> => {
      const entriesToDelete = dedupeSftpEntries(targetEntries);
      if (!hasSftpSession || entriesToDelete.length === 0) {
        return;
      }

      if (shouldConfirmSftpDelete(sftpDeleteConfirmationMode, entriesToDelete.length, source)) {
        const accepted = await requestDeleteConfirmation(entriesToDelete, source);
        if (!accepted) {
          return;
        }
      }

      runSftpOperation(
        {
          label: t('sftp.tasks.delete'),
          detail: formatBatchFeedback(entriesToDelete.length, 'sftp.tasks.entryCountOne', 'sftp.tasks.entryCountMany'),
          progress: { completed: 0, total: entriesToDelete.length },
        },
        async ({ isCurrent, update }) => {
          const response = await runWithSftpReconnect('mutation', (activeSessionId) =>
            runSftpBatchOperation(activeSessionId, {
              operation: 'delete',
              entries: entriesToDelete.map((entry) => ({
                path: entry.path,
                type: entry.type,
              })),
            }),
          );
          update({ progress: { completed: response.data.completedCount, total: response.data.totalCount } });
          if (!isCurrent()) {
            return;
          }

          const deletedPaths = new Set(
            response.data.results.filter((result) => result.status === 'success').map((result) => result.path),
          );

          const partialFailureMessage =
            response.data.failedCount > 0 ? formatBatchPartialFailureFeedback(response.data) : null;
          if (!partialFailureMessage) {
            notifySuccess(
              formatBatchFeedback(response.data.completedCount, 'sftp.feedback.deleted', 'sftp.feedback.deletedMany'),
            );
          }

          setSelectedPaths((previous) => previous.filter((path) => !deletedPaths.has(path)));
          setSelectionAnchorPath((previous) => (deletedPaths.has(previous) ? '' : previous));
          setPreviewState((previous) => (deletedPaths.has(resolvePreviewStatePath(previous)) ? null : previous));
          deletedPaths.forEach((path) => {
            delete temporaryOpenFilePathsRef.current[path];
            delete imagePreviewTempFilesRef.current[path];
          });
          setOpenWithApplicationsByPath((previous) => {
            const next = { ...previous };
            deletedPaths.forEach((path) => {
              delete next[path];
            });
            return next;
          });
          await refreshCurrentDirectoryAfterOperation(
            entriesToDelete.map((entry) => resolveEntryParentPath(entry.path)),
          );
          if (partialFailureMessage) {
            throw new Error(partialFailureMessage);
          }
        },
      );
    },
    [
      hasSftpSession,
      notifySuccess,
      refreshCurrentDirectoryAfterOperation,
      requestDeleteConfirmation,
      runSftpOperation,
      runWithSftpReconnect,
      setSelectedPaths,
      setSelectionAnchorPath,
      sftpDeleteConfirmationMode,
    ],
  );

  /**
   * Opens a standalone metadata window for one or more remote SFTP entries.
   *
   * @param entries Entries whose properties should be shown.
   * @returns void.
   */
  const handleOpenProperties = React.useCallback(
    (entries: ApiSftpEntry[]): void => {
      if (!hasSftpSession) {
        notifyError(t('sftp.noSession'));
        return;
      }

      if (entries.length === 0) {
        return;
      }

      try {
        const windowName =
          entries.length === 1
            ? `cosmosh-sftp-properties:${sessionId}:${entries[0]?.path ?? ''}`
            : `cosmosh-sftp-properties:${sessionId}:selection:${entries.map((entry) => entry.path).join('|')}`;
        const propertiesWindow = window.open(
          buildSftpEntryPropertiesWindowUrl(sessionId, entries),
          windowName,
          'popup,width=520,height=680,resizable=yes,scrollbars=yes',
        );

        if (!propertiesWindow) {
          notifyError(t('sftp.properties.openFailed'));
          return;
        }

        propertiesWindow.opener = null;
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('sftp.properties.openFailed'));
      }
    },
    [hasSftpSession, notifyError, sessionId],
  );

  const {
    canCreateArchives,
    canExtractArchives,
    closeCompressionPrompt,
    closeDestinationPrompt,
    compressionPrompt,
    conflictPrompt,
    destinationPrompt,
    extractArchives,
    openCustomExtraction,
    openCompression,
    resolveConflict,
    startCustomExtraction,
    startCompression,
  } = useSftpArchiveActions({
    canProbeCapabilities: canUseFileActions && activeTaskCount === 0,
    currentPath,
    directoryEntries: entries,
    getActiveSessionId: getActiveSftpSessionId,
    notifyError,
    onOperationCompleted: handleRefresh,
    runSftpOperation,
    sessionId,
  });

  const renderSftpActionMenuItems = React.useCallback(
    ({
      contextEntry,
      menuSurface,
      scope,
      showShortcuts,
      targetDirectoryPath = currentPath,
    }: SftpActionMenuOptions): React.ReactNode => {
      return (
        <SftpActionMenuItems
          withIconSlot
          beginCreateEntryInDirectory={beginCreateEntryInDirectory}
          beginRenameEntry={beginRenameEntry}
          canUploadLocalFiles={canUploadLocalFiles}
          canCreateArchives={canCreateArchives}
          canExtractArchives={canExtractArchives}
          canUseFileActions={canUseFileActions}
          canUseSftpOpenWith={canUseSftpOpenWith}
          clipboardState={clipboardState}
          contextEntry={contextEntry}
          currentPath={currentPath}
          handleCreateLinkFromClipboard={handleCreateLinkFromClipboard}
          handleCopyEntries={handleCopyEntries}
          handleCopyRelativeRemotePath={handleCopyRelativeRemotePath}
          handleCopyRemotePath={handleCopyRemotePath}
          handleCutEntries={handleCutEntries}
          handleDeleteEntries={handleDeleteEntries}
          handleCompressEntries={openCompression}
          handleExtractEntries={extractArchives}
          handleExtractEntriesToCustomDirectory={openCustomExtraction}
          handleDownloadEntry={handleDownloadEntry}
          handleOpenDirectoryInNewTab={handleOpenDirectoryInNewTab}
          handleOpenEntry={handleOpenEntry}
          handleOpenEntryWithApplication={handleOpenEntryWithApplication}
          handleOpenEntryWithPicker={handleOpenEntryWithPicker}
          handleOpenProperties={handleOpenProperties}
          handleOpenSshAtEntryLocation={handleOpenSshAtEntryLocation}
          handleOpenSymlinkTargetLocation={handleOpenSymlinkTargetLocation}
          handlePasteEntry={handlePasteEntry}
          handleTreeDirectoryRefresh={handleTreeDirectoryRefresh}
          handleUploadFiles={handleUploadFiles}
          loadOpenWithApplications={loadOpenWithApplications}
          loadingOpenWithPath={loadingOpenWithPath}
          menuSurface={menuSurface}
          openWithApplicationsByPath={openWithApplicationsByPath}
          runInlineEditMenuActionAfterClose={runInlineEditMenuActionAfterClose}
          scope={scope}
          selectedEntries={selectedEntries}
          selectedPathSet={selectedPathSet}
          shortcutModifier={shortcutModifier}
          showShortcuts={showShortcuts}
          targetDirectoryPath={targetDirectoryPath}
        />
      );
    },
    [
      beginCreateEntryInDirectory,
      beginRenameEntry,
      canUploadLocalFiles,
      canCreateArchives,
      canExtractArchives,
      canUseFileActions,
      canUseSftpOpenWith,
      clipboardState,
      currentPath,
      handleCreateLinkFromClipboard,
      handleCopyEntries,
      handleCopyRelativeRemotePath,
      handleCopyRemotePath,
      handleCutEntries,
      handleDeleteEntries,
      extractArchives,
      openCustomExtraction,
      handleDownloadEntry,
      handleOpenDirectoryInNewTab,
      handleOpenEntry,
      handleOpenEntryWithApplication,
      handleOpenEntryWithPicker,
      handleOpenProperties,
      handleOpenSshAtEntryLocation,
      handleOpenSymlinkTargetLocation,
      openCompression,
      handlePasteEntry,
      handleUploadFiles,
      loadOpenWithApplications,
      loadingOpenWithPath,
      openWithApplicationsByPath,
      handleTreeDirectoryRefresh,
      runInlineEditMenuActionAfterClose,
      selectedEntries,
      selectedPathSet,
      shortcutModifier,
    ],
  );

  const handleParentDirectory = React.useCallback((): void => {
    if (!parentPath) {
      return;
    }

    void navigateToPath(parentPath);
  }, [navigateToPath, parentPath]);

  const resolveBreadcrumbMenuDirectories = React.useCallback(
    (breadcrumbPath: string): TreeDirectoryNode[] => {
      const treeNode = treeNodes[breadcrumbPath];
      const directoryEntries =
        directoryCacheRef.current[breadcrumbPath]?.entries
          .filter((entry) => sftpShowHiddenEntries || !entry.isHidden)
          .filter((entry) => entry.type === 'directory')
          .map((entry) => ({
            path: entry.path,
            name: entry.name,
            parentPath: breadcrumbPath,
            isHidden: entry.isHidden,
            children: treeNodes[entry.path]?.children ?? [],
            isExpanded: treeNodes[entry.path]?.isExpanded ?? false,
            isLoaded: treeNodes[entry.path]?.isLoaded ?? false,
            isLoading: treeNodes[entry.path]?.isLoading ?? false,
          })) ?? [];
      const treeChildren =
        treeNode?.children
          .map((childPath) => treeNodes[childPath])
          .filter((node): node is TreeDirectoryNode => Boolean(node) && (sftpShowHiddenEntries || !node.isHidden)) ??
        [];

      return [...directoryEntries, ...treeChildren]
        .filter((node, index, nodes) => nodes.findIndex((candidate) => candidate.path === node.path) === index)
        .sort(compareSftpEntryNames);
    },
    [sftpShowHiddenEntries, treeNodes],
  );

  const loadBreadcrumbMenuDirectories = React.useCallback(
    (breadcrumbPath: string): void => {
      if (!hasSftpSession || directoryCacheRef.current[breadcrumbPath] || treeNodes[breadcrumbPath]?.isLoading) {
        return;
      }

      void loadTreeDirectoryChildren(breadcrumbPath);
    },
    [hasSftpSession, loadTreeDirectoryChildren, treeNodes],
  );

  const isBreadcrumbLoading = React.useCallback(
    (breadcrumbPath: string): boolean => {
      return Boolean(treeNodes[breadcrumbPath]?.isLoading);
    },
    [treeNodes],
  );

  const handleEntrySelect = React.useCallback(
    (entry: ApiSftpEntry, event: SftpSelectionClickEvent): void => {
      selectEntryWithModifiers(entry, event);
    },
    [selectEntryWithModifiers],
  );

  const handleEntryContextMenu = React.useCallback(
    (entry: ApiSftpEntry): void => {
      if (!selectedPathSet.has(entry.path)) {
        selectSingleEntry(entry);
      }
    },
    [selectSingleEntry, selectedPathSet],
  );

  const handleEntryOpen = React.useCallback(
    (entry: ApiSftpEntry): void => {
      void handleOpenEntry(entry);
    },
    [handleOpenEntry],
  );

  const focusFileRow = React.useCallback((rowKey: string): void => {
    setActiveFileRowKey(rowKey);
    directoryPanelRef.current?.focusRow(rowKey);
  }, []);

  const handleFileNavigationRowKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>, row: SftpFileNavigationRow): void => {
      if (event.currentTarget !== event.target) {
        return;
      }

      const hasSelectionModifier = window.electron?.platform === 'darwin' ? event.metaKey : event.ctrlKey;

      if ((event.key === ' ' || event.key === 'Spacebar') && row.kind === 'entry') {
        event.preventDefault();
        event.stopPropagation();
        selectEntryWithModifiers(row.entry, {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (row.kind === 'parent') {
          handleParentDirectory();
          return;
        }

        handleEntryOpen(row.entry);
        return;
      }

      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const currentIndex = fileNavigationRows.findIndex((candidate) => candidate.key === row.key);
      if (currentIndex < 0) {
        return;
      }

      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? fileNavigationRows.length - 1
            : event.key === 'ArrowDown'
              ? Math.min(currentIndex + 1, fileNavigationRows.length - 1)
              : Math.max(currentIndex - 1, 0);
      const nextRow = fileNavigationRows[nextIndex];
      if (!nextRow || nextRow.key === row.key) {
        return;
      }

      focusFileRow(nextRow.key);
      if (nextRow.kind === 'entry') {
        const rangeAnchorPath =
          event.shiftKey && row.kind === 'entry' && !selectionAnchorPath ? row.entry.path : undefined;
        if (!hasSelectionModifier || event.shiftKey) {
          selectEntryWithModifiers(
            nextRow.entry,
            {
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            },
            { rangeAnchorPath },
          );
        }
      }
    },
    [
      fileNavigationRows,
      focusFileRow,
      handleEntryOpen,
      handleParentDirectory,
      selectEntryWithModifiers,
      selectionAnchorPath,
    ],
  );

  React.useEffect(() => {
    setActiveFileRowKey((previous) => {
      if (previous && fileNavigationRows.some((row) => row.key === previous)) {
        return previous;
      }

      const selectedVisibleRow = selectedEntry
        ? fileNavigationRows.find((row) => row.kind === 'entry' && row.key === selectedEntry.path)
        : undefined;

      return selectedVisibleRow?.key ?? fileNavigationRows[0]?.key ?? '';
    });
  }, [fileNavigationRows, selectedEntry]);

  useSftpKeyboardShortcuts({
    beginCreateEntry,
    beginRenameEntry,
    canUseFileActions,
    clearPreviewState,
    clipboardState,
    handleCopyEntries,
    handleCutEntries,
    handleDeleteEntries,
    handleOpenDirectoryInNewTab,
    handleOpenEntry,
    handlePasteEntry,
    hasSelection,
    selectedEntry,
    selectedEntries,
    visibleEntries,
    setSelectedPaths,
    setSelectionAnchorPath,
  });

  const handleTreeNodeToggle = React.useCallback(
    (nodePath: string): void => {
      const node = treeNodes[nodePath];
      if (!node || node.isLoading) {
        return;
      }

      const shouldExpand = !node.isExpanded;
      setTreeNodes((previous) => {
        const previousNode = previous[nodePath];
        if (!previousNode) {
          return previous;
        }

        return {
          ...previous,
          [nodePath]: {
            ...previousNode,
            isExpanded: shouldExpand,
          },
        };
      });

      if (shouldExpand && !node.isLoaded && hasSftpSession) {
        void loadTreeDirectoryChildren(nodePath);
      }
    },
    [hasSftpSession, loadTreeDirectoryChildren, treeNodes],
  );

  const treeRootPaths = React.useMemo(() => {
    const rootPaths = Object.values(treeNodes)
      .filter((node) => !node.parentPath)
      .map((node) => node.path)
      .sort(compareSftpNames);

    if (rootPaths.length > 0) {
      return rootPaths;
    }

    return breadcrumbs[0]?.path ? [breadcrumbs[0].path] : [];
  }, [breadcrumbs, treeNodes]);

  const visibleTreeRows = React.useMemo(() => {
    return flattenVisibleSftpTreeRows(treeNodes, treeRootPaths);
  }, [treeNodes, treeRootPaths]);
  const visibleTreePaths = React.useMemo(() => visibleTreeRows.map((row) => row.path), [visibleTreeRows]);

  const resolvedActiveTreePath =
    (activeTreePath && visibleTreePaths.includes(activeTreePath) ? activeTreePath : '') ||
    (visibleTreePaths.includes(currentPath) ? currentPath : '') ||
    visibleTreePaths[0] ||
    '';

  const focusTreePath = React.useCallback((nodePath: string): void => {
    setActiveTreePath(nodePath);
    treePanelRef.current?.focusPath(nodePath);
  }, []);

  const handleTreeRowKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, nodePath: string): void => {
      if (event.currentTarget !== event.target) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void navigateToPath(nodePath);
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();

        const currentIndex = visibleTreePaths.indexOf(nodePath);
        if (currentIndex < 0) {
          return;
        }

        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visibleTreePaths.length - 1
              : event.key === 'ArrowDown'
                ? Math.min(currentIndex + 1, visibleTreePaths.length - 1)
                : Math.max(currentIndex - 1, 0);
        const nextPath = visibleTreePaths[nextIndex];
        if (nextPath && nextPath !== nodePath) {
          focusTreePath(nextPath);
        }
        return;
      }

      const node = treeNodes[nodePath];
      const isExpandable = Boolean(node && (node.isLoading || node.children.length > 0 || !node.isLoaded));

      if (event.key === 'ArrowRight' && node && isExpandable && !node.isExpanded) {
        event.preventDefault();
        event.stopPropagation();
        handleTreeNodeToggle(node.path);
        return;
      }

      if (event.key === 'ArrowLeft' && node?.isExpanded) {
        event.preventDefault();
        event.stopPropagation();
        handleTreeNodeToggle(node.path);
      }
    },
    [focusTreePath, handleTreeNodeToggle, navigateToPath, treeNodes, visibleTreePaths],
  );

  return (
    <>
      <div className="flex h-full w-full flex-col gap-2.5 overflow-hidden">
        <SftpToolbar
          activeDropTarget={activeDropTarget}
          addressPath={addressPath}
          addressBreadcrumbRenderState={addressBreadcrumbRenderState}
          addressInputContextMenuItems={addressInputContextMenuItems}
          addressInputRef={addressInputRef}
          backNavigationHistoryItems={backNavigationHistoryItems}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          canUploadLocalFiles={canUploadLocalFiles}
          canUseFileActions={canUseFileActions}
          clipboardStateExists={Boolean(clipboardState)}
          currentPath={currentPath}
          directoryListView={sftpDirectoryListView}
          filterQuery={filterQuery}
          forwardNavigationHistoryItems={forwardNavigationHistoryItems}
          getBreadcrumbDirectories={resolveBreadcrumbMenuDirectories}
          hasSelection={hasSelection}
          hasSingleSelection={hasSingleSelection}
          isAddressInputEditing={isAddressInputEditing}
          isAddressLoading={isAddressLoading}
          isBreadcrumbLoading={isBreadcrumbLoading}
          isBusy={isBusy}
          isRefreshingDirectory={isRefreshingDirectory}
          keepAddressInputDuringContextMenu={keepAddressInputDuringContextMenu}
          navigationIndex={navigationState.index}
          parentPath={parentPath}
          pathInput={pathInput}
          primarySelectedEntry={primarySelectedEntry}
          renderActionMenuItems={renderSftpActionMenuItems}
          renderNavigationHistoryControl={renderNavigationHistoryControl}
          activeTaskCount={activeTaskCount}
          runningTaskCount={runningTaskCount}
          selectedEntries={selectedEntries}
          selectedEntry={selectedEntry}
          sessionId={sessionId}
          sftpAuxiliarySidebarMode={sftpAuxiliarySidebarMode}
          sftpShowAddressAsText={sftpShowAddressAsText}
          sftpShowHiddenEntries={sftpShowHiddenEntries}
          sortedSftpTasks={sortedSftpTasks}
          hasTextPreview={hasTextPreview}
          isPreviewDirty={isPreviewDirty}
          isPreviewSaving={isPreviewSaving}
          taskToolbarLabel={taskToolbarLabel}
          onAddressInputPointerDown={handleAddressInputPointerDown}
          onAuxiliarySidebarModeChange={setSftpAuxiliarySidebarMode}
          onBeginCreateEntry={beginCreateEntry}
          onBeginRenameEntry={beginRenameEntry}
          onCopyCurrentPath={handleCopyCurrentPath}
          onCopyEntries={handleCopyEntries}
          onCutEntries={handleCutEntries}
          onDeleteEntries={handleDeleteEntries}
          onDirectoryDropTargetDragEnter={handleDirectoryDropTargetDragEnter}
          onDirectoryDropTargetDragLeave={handleDirectoryDropTargetDragLeave}
          onDirectoryDropTargetDragOver={handleDirectoryDropTargetDragOver}
          onDirectoryDropTargetDrop={handleDirectoryDropTargetDrop}
          onDirectoryListColumnVisibilityChange={setSftpDirectoryListColumnVisibility}
          onDirectoryListSortChange={setSftpDirectoryListSort}
          onEditCurrentPath={handleEditCurrentPath}
          onFilterQueryChange={setFilterQuery}
          onHistoryJump={handleHistoryJump}
          onInlineEditMenuCloseAutoFocus={handleInlineEditMenuCloseAutoFocus}
          onNavigateToPath={navigateToPath}
          onParentDirectory={handleParentDirectory}
          onPasteEntry={handlePasteEntry}
          onPathInputBlur={handlePathInputBlur}
          onPathInputChange={setPathInput}
          onPathInputKeyDown={handlePathInputKeyDown}
          onPathSubmit={handlePathSubmit}
          onPreviewRedo={handlePreviewRedo}
          onPreviewSave={handlePreviewSave}
          onPreviewUndo={handlePreviewUndo}
          onTaskMenuOpenChange={onTaskMenuOpenChange}
          onRefresh={handleRefresh}
          onRequestBreadcrumbDirectories={loadBreadcrumbMenuDirectories}
          onShowAddressAsText={handleShowAddressAsText}
          onShowHiddenEntriesChange={setSftpHiddenEntriesVisibility}
          onUploadFiles={handleUploadFiles}
        />
        <div className={sftpWorkbenchGridClassName}>
          <SftpTreePanel
            ref={treePanelRef}
            activeDropTarget={activeDropTarget}
            currentPath={currentPath}
            renderActionMenuItems={renderSftpActionMenuItems}
            resolvedActiveTreePath={resolvedActiveTreePath}
            sftpDimHiddenEntries={sftpDimHiddenEntries}
            sftpShowHiddenEntries={sftpShowHiddenEntries}
            status={status}
            treeNodes={treeNodes}
            visibleTreeRows={visibleTreeRows}
            onDirectoryDropTargetDragEnter={handleDirectoryDropTargetDragEnter}
            onDirectoryDropTargetDragLeave={handleDirectoryDropTargetDragLeave}
            onDirectoryDropTargetDragOver={handleDirectoryDropTargetDragOver}
            onDirectoryDropTargetDrop={handleDirectoryDropTargetDrop}
            onInlineEditMenuCloseAutoFocus={handleInlineEditMenuCloseAutoFocus}
            onNavigateToPath={navigateToPath}
            onSetActiveTreePath={setActiveTreePath}
            onTreeNodeToggle={handleTreeNodeToggle}
            onTreeRowKeyDown={handleTreeRowKeyDown}
          />
          <SftpDirectoryPanel
            ref={directoryPanelRef}
            activeDropTarget={activeDropTarget}
            canActivateParentDirectoryListEntry={canActivateParentDirectoryListEntry}
            clipboardMode={clipboardState?.mode}
            clipboardPaths={clipboardPaths}
            currentPath={currentPath}
            directoryListView={sftpDirectoryListView}
            entries={entries}
            errorMessage={errorMessage}
            hasParentDirectoryListEntry={hasParentDirectoryListEntry}
            pendingCreate={pendingCreate}
            renameInput={renameInput}
            renameInputRef={renameInputRef}
            renamingEntryPath={renamingEntryPath}
            renderActionMenuItems={renderSftpActionMenuItems}
            resolvedActiveFileRowKey={resolvedActiveFileRowKey}
            selectedPathSet={selectedPathSet}
            sessionId={sessionId}
            sftpDimHiddenEntries={sftpDimHiddenEntries}
            sftpShowHiddenEntries={sftpShowHiddenEntries}
            status={status}
            visibleEntries={visibleEntries}
            onCancelInlineEdit={cancelInlineEdit}
            onCommitPendingCreate={commitPendingCreate}
            onCommitRenameEntry={commitRenameEntry}
            onDirectoryBlankClick={resetSelection}
            onDirectoryListColumnOrderChange={setSftpDirectoryListColumnOrder}
            onDirectoryListColumnVisibilityChange={setSftpDirectoryListColumnVisibility}
            onDirectoryListSortChange={setSftpDirectoryListSort}
            onDirectoryListSortFieldClick={handleSftpDirectoryListSortFieldClick}
            onDirectoryDropTargetDragEnter={handleDirectoryDropTargetDragEnter}
            onDirectoryDropTargetDragLeave={handleDirectoryDropTargetDragLeave}
            onDirectoryDropTargetDragOver={handleDirectoryDropTargetDragOver}
            onDirectoryDropTargetDrop={handleDirectoryDropTargetDrop}
            onDirectoryDropTargetReject={handleDirectoryDropTargetReject}
            onEntryContextMenu={handleEntryContextMenu}
            onEntryDragEnd={handleSftpEntryDragEnd}
            onEntryDragStart={handleSftpEntryDragStart}
            onEntryOpen={handleEntryOpen}
            onEntrySelect={handleEntrySelect}
            onEntriesMarqueeSelect={selectEntriesByPaths}
            onFileNavigationRowKeyDown={handleFileNavigationRowKeyDown}
            onInlineEditInputBlur={handleInlineEditInputBlur}
            onInlineEditMenuCloseAutoFocus={handleInlineEditMenuCloseAutoFocus}
            onParentDirectory={handleParentDirectory}
            onRefresh={handleRefresh}
            onRenameInputChange={setRenameInput}
            onSetActiveFileRowKey={setActiveFileRowKey}
          />
          {sftpAuxiliarySidebarMode !== 'off' ? (
            <SftpDetailPanel
              auxiliarySidebarMode={sftpAuxiliarySidebarMode}
              previewState={previewState}
              selectedCount={selectedCount}
              selectedEntry={selectedEntry}
              onConfirmLargePreview={handleConfirmLargePreview}
              onPreviewContentChange={handlePreviewContentChange}
              onPreviewEditorMount={handlePreviewEditorMount}
              onPreviewSave={handlePreviewSave}
            />
          ) : null}
        </div>
      </div>
      <SftpDropOperationMenu
        pendingDropOperationMenu={pendingDropOperationMenu}
        onDismiss={() => setPendingDropOperationMenu(null)}
        onOperationSelect={handlePendingDropOperationSelect}
      />
      <SftpHostFingerprintDialog
        prompt={hostFingerprintPrompt}
        onResolve={resolveHostFingerprintPrompt}
      />
      <SftpDeleteConfirmationDialog
        prompt={deleteConfirmationPrompt}
        onResolve={resolveDeleteConfirmationPrompt}
      />
      <SftpUploadConfirmationDialog
        prompt={uploadConfirmationPrompt}
        onResolve={resolveUploadConfirmationPrompt}
      />
      <SftpUploadConflictConfirmationDialog
        prompt={uploadConflictConfirmationPrompt}
        onResolve={resolveUploadConflictConfirmationPrompt}
      />
      <SftpArchiveCompressionDialog
        prompt={compressionPrompt}
        onCancel={closeCompressionPrompt}
        onSubmit={startCompression}
      />
      <SftpArchiveDestinationDialog
        prompt={destinationPrompt}
        onCancel={closeDestinationPrompt}
        onSubmit={startCustomExtraction}
      />
      <SftpArchiveConflictDialog
        prompt={conflictPrompt}
        onResolve={resolveConflict}
      />
    </>
  );
};

export default SFTP;
