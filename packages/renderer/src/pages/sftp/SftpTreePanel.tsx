import { useVirtualizer } from '@tanstack/react-virtual';
import classNames from 'classnames';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import React from 'react';

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../../components/ui/context-menu';
import { SftpTreeSkeleton } from '../../components/ui/skeleton';
import { t } from '../../lib/i18n';
import { SFTP_CARD_CLASS_NAME } from './sftp-constants';
import type { SftpDirectoryDropEventHandler, SftpDirectoryDropTarget } from './sftp-drag-drop';
import type { SftpActionMenuOptions, SftpConnectionStatus, TreeDirectoryNode } from './sftp-types';
import { resolveTreeDirectoryEntry, resolveTreeIndentClassName } from './sftp-utils';
import {
  extractSftpVirtualRange,
  isSftpVirtualRowContextVisible,
  resolveSftpVirtualRowScrollOffset,
  SFTP_TREE_ROW_HEIGHT_PX,
  SFTP_VIRTUAL_OVERSCAN_ROWS,
  type SftpVirtualTreeRow,
} from './sftp-virtualization';

const CURRENT_DIRECTORY_SCROLL_RATIO = 1 / 3;

/**
 * Imperative focus surface exposed by the virtualized SFTP tree.
 */
export type SftpTreePanelHandle = {
  /** Reveals and focuses the requested visible directory path. */
  focusPath: (nodePath: string) => void;
};

/**
 * Props for the SFTP directory tree panel.
 */
type SftpTreePanelProps = {
  activeDropTarget: SftpDirectoryDropTarget | null;
  currentPath: string;
  resolvedActiveTreePath: string;
  sftpDimHiddenEntries: boolean;
  sftpShowHiddenEntries: boolean;
  status: SftpConnectionStatus;
  treeNodes: Record<string, TreeDirectoryNode>;
  visibleTreeRows: SftpVirtualTreeRow[];
  onDirectoryDropTargetDragEnter: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDragLeave: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDragOver: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDrop: SftpDirectoryDropEventHandler;
  onInlineEditMenuCloseAutoFocus: (event: Event) => void;
  onNavigateToPath: (directoryPath: string) => Promise<boolean>;
  onSetActiveTreePath: (nodePath: string) => void;
  onTreeNodeToggle: (nodePath: string) => void;
  onTreeRowKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, nodePath: string) => void;
  renderActionMenuItems: (options: SftpActionMenuOptions) => React.ReactNode;
};

/**
 * Renders the expandable left-side SFTP directory tree.
 *
 * @param props Tree state and navigation handlers.
 * @param forwardedRef Imperative focus handle consumed by the tab-level keyboard controller.
 * @returns SFTP tree panel.
 */
export const SftpTreePanel = React.forwardRef<SftpTreePanelHandle, SftpTreePanelProps>(function SftpTreePanel(
  {
    activeDropTarget,
    currentPath,
    onDirectoryDropTargetDragEnter,
    onDirectoryDropTargetDragLeave,
    onDirectoryDropTargetDragOver,
    onDirectoryDropTargetDrop,
    onInlineEditMenuCloseAutoFocus,
    onNavigateToPath,
    onSetActiveTreePath,
    onTreeNodeToggle,
    onTreeRowKeyDown,
    renderActionMenuItems,
    resolvedActiveTreePath,
    sftpDimHiddenEntries,
    sftpShowHiddenEntries,
    status,
    treeNodes,
    visibleTreeRows,
  },
  forwardedRef,
) {
  const [treeViewportElement, setTreeViewportElement] = React.useState<HTMLDivElement | null>(null);
  const treeRowRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingFocusPathRef = React.useRef<string>('');
  const lastAutoScrolledPathRef = React.useRef<string>('');
  const [contextMenuPath, setContextMenuPath] = React.useState<string>('');
  const visibleTreeIndexByPath = React.useMemo(
    () => new Map(visibleTreeRows.map((row, index) => [row.path, index])),
    [visibleTreeRows],
  );
  const activeTreeRowIndex = resolvedActiveTreePath ? (visibleTreeIndexByPath.get(resolvedActiveTreePath) ?? -1) : -1;
  const contextMenuRowIndex = contextMenuPath ? (visibleTreeIndexByPath.get(contextMenuPath) ?? -1) : -1;
  const extractTreeRowRange = React.useCallback(
    (range: Parameters<typeof extractSftpVirtualRange>[0]): number[] =>
      extractSftpVirtualRange(range, [activeTreeRowIndex, contextMenuRowIndex]),
    [activeTreeRowIndex, contextMenuRowIndex],
  );
  /**
   * Resolves a stable key without invalidating virtualizer measurements on unrelated renders.
   *
   * @param index Logical tree row index.
   * @returns Remote directory path or the index fallback.
   */
  const getTreeRowKey = React.useCallback(
    (index: number): string | number => visibleTreeRows[index]?.path ?? index,
    [visibleTreeRows],
  );
  const treeVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visibleTreeRows.length,
    estimateSize: () => SFTP_TREE_ROW_HEIGHT_PX,
    getItemKey: getTreeRowKey,
    getScrollElement: () => treeViewportElement,
    overscan: SFTP_VIRTUAL_OVERSCAN_ROWS,
    rangeExtractor: extractTreeRowRange,
  });
  const virtualTreeRows = treeVirtualizer.getVirtualItems();

  /**
   * Reveals and focuses a tree row even when virtualization has not mounted it yet.
   *
   * @param nodePath Directory node path to focus.
   * @returns void.
   */
  const focusPath = React.useCallback(
    (nodePath: string): void => {
      const rowIndex = visibleTreeIndexByPath.get(nodePath);
      if (rowIndex === undefined) {
        return;
      }

      pendingFocusPathRef.current = nodePath;
      treeVirtualizer.scrollToIndex(rowIndex, { align: 'auto' });

      const mountedRow = treeRowRefs.current[nodePath];
      if (mountedRow) {
        mountedRow.focus({ preventScroll: true });
        pendingFocusPathRef.current = '';
      }
    },
    [treeVirtualizer, visibleTreeIndexByPath],
  );

  React.useImperativeHandle(forwardedRef, () => ({ focusPath }), [focusPath]);

  React.useLayoutEffect(() => {
    if (!currentPath || lastAutoScrolledPathRef.current === currentPath) {
      return;
    }

    const currentRowIndex = visibleTreeIndexByPath.get(currentPath);
    if (currentRowIndex === undefined) {
      return;
    }

    const scrollContainer = treeViewportElement;
    if (!scrollContainer || scrollContainer.clientHeight <= 0) {
      return;
    }

    const currentNode = treeNodes[currentPath];
    const contextPaths = [
      currentNode?.parentPath,
      currentPath,
      ...(currentNode?.isExpanded ? currentNode.children : []),
    ].filter((path): path is string => Boolean(path));
    const contextRowIndexes = Array.from(new Set(contextPaths))
      .map((path) => visibleTreeIndexByPath.get(path))
      .filter((index): index is number => index !== undefined);

    if (
      isSftpVirtualRowContextVisible(
        contextRowIndexes,
        SFTP_TREE_ROW_HEIGHT_PX,
        scrollContainer.scrollTop,
        scrollContainer.clientHeight,
      )
    ) {
      lastAutoScrolledPathRef.current = currentPath;
      return;
    }

    treeVirtualizer.scrollToOffset(
      resolveSftpVirtualRowScrollOffset(
        currentRowIndex,
        SFTP_TREE_ROW_HEIGHT_PX,
        visibleTreeRows.length,
        scrollContainer.clientHeight,
        CURRENT_DIRECTORY_SCROLL_RATIO,
      ),
    );
    lastAutoScrolledPathRef.current = currentPath;
  }, [currentPath, treeNodes, treeViewportElement, treeVirtualizer, visibleTreeIndexByPath, visibleTreeRows.length]);

  /**
   * Renders one mounted virtual tree row.
   *
   * @param treeRow Flattened directory row.
   * @returns Mounted directory row.
   */
  const renderTreeRow = React.useCallback(
    (treeRow: SftpVirtualTreeRow): React.ReactNode => {
      const node = treeNodes[treeRow.path];
      if (!node) {
        return null;
      }

      const isCurrent = node.path === currentPath;
      const isExpandable = node.isLoading || node.children.length > 0 || !node.isLoaded;
      const treeContextEntry = resolveTreeDirectoryEntry(node);
      const shouldDimHiddenNode = sftpShowHiddenEntries && sftpDimHiddenEntries && node.isHidden;
      const hiddenNodeVisualClassName = shouldDimHiddenNode ? 'opacity-80' : undefined;
      const isActiveDropTarget = activeDropTarget?.surface === 'tree' && activeDropTarget.path === node.path;

      return (
        <ContextMenu
          key={node.path}
          onOpenChange={(open) => setContextMenuPath(open ? node.path : '')}
        >
          <ContextMenuTrigger asChild>
            <div
              className={classNames(
                'group flex h-[30px] w-full items-center rounded-lg text-sm transition-colors hover:bg-home-card-hover',
                isCurrent ? 'bg-home-card-hover' : '',
                isActiveDropTarget ? 'bg-home-card-active' : '',
              )}
              onDragEnter={(event) =>
                onDirectoryDropTargetDragEnter(event, {
                  path: node.path,
                  surface: 'tree',
                })
              }
              onDragLeave={(event) =>
                onDirectoryDropTargetDragLeave(event, {
                  path: node.path,
                  surface: 'tree',
                })
              }
              onDragOver={(event) =>
                onDirectoryDropTargetDragOver(event, {
                  path: node.path,
                  surface: 'tree',
                })
              }
              onDrop={(event) =>
                onDirectoryDropTargetDrop(event, {
                  path: node.path,
                  surface: 'tree',
                })
              }
            >
              <div
                className={classNames(
                  'flex min-w-0 flex-1 items-center',
                  treeRow.depth > 0 ? resolveTreeIndentClassName(treeRow.depth) : '',
                )}
              >
                <button
                  type="button"
                  aria-label={t(node.isExpanded ? 'sftp.actions.collapse' : 'sftp.actions.expand')}
                  className="flex h-[30px] w-5 shrink-0 items-center justify-center rounded-sm-2 text-home-text-subtle"
                  disabled={node.isLoading}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTreeNodeToggle(node.path);
                  }}
                >
                  {node.isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isExpandable ? (
                    <ChevronRight
                      className={classNames(
                        'h-3.5 w-3.5 transition-transform',
                        node.isExpanded && node.children.length > 0 ? 'rotate-90' : '',
                      )}
                    />
                  ) : (
                    <span className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  ref={(element) => {
                    if (!element) {
                      delete treeRowRefs.current[node.path];
                    } else {
                      treeRowRefs.current[node.path] = element;
                    }
                    if (element && pendingFocusPathRef.current === node.path) {
                      element.focus({ preventScroll: true });
                      pendingFocusPathRef.current = '';
                    }
                  }}
                  type="button"
                  role="treeitem"
                  aria-expanded={isExpandable ? node.isExpanded : undefined}
                  aria-level={treeRow.depth + 1}
                  aria-posinset={treeRow.positionInSet}
                  aria-setsize={treeRow.setSize}
                  className="text-home-text flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md pr-2 text-left"
                  tabIndex={resolvedActiveTreePath === node.path ? 0 : -1}
                  onClick={() => {
                    onSetActiveTreePath(node.path);
                    void onNavigateToPath(node.path);
                  }}
                  onFocus={() => onSetActiveTreePath(node.path)}
                  onKeyDown={(event) => onTreeRowKeyDown(event, node.path)}
                >
                  <Folder className={classNames('text-home-text h-3.5 w-3.5 shrink-0', hiddenNodeVisualClassName)} />
                  <span className={classNames('truncate', hiddenNodeVisualClassName)}>{node.name}</span>
                </button>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={onInlineEditMenuCloseAutoFocus}>
            {renderActionMenuItems({
              contextEntry: treeContextEntry,
              menuSurface: 'context',
              scope: 'treeDirectory',
              showShortcuts: false,
              targetDirectoryPath: node.path,
            })}
          </ContextMenuContent>
        </ContextMenu>
      );
    },
    [
      currentPath,
      onInlineEditMenuCloseAutoFocus,
      onNavigateToPath,
      onDirectoryDropTargetDragEnter,
      onDirectoryDropTargetDragLeave,
      onDirectoryDropTargetDragOver,
      onDirectoryDropTargetDrop,
      onSetActiveTreePath,
      onTreeNodeToggle,
      onTreeRowKeyDown,
      renderActionMenuItems,
      activeDropTarget,
      resolvedActiveTreePath,
      sftpDimHiddenEntries,
      sftpShowHiddenEntries,
      treeNodes,
    ],
  );

  return (
    <aside className={SFTP_CARD_CLASS_NAME}>
      <div className="flex h-full min-h-0 flex-col">
        <div
          ref={setTreeViewportElement}
          className="min-h-0 flex-1 overflow-auto"
        >
          {status === 'connecting' && visibleTreeRows.length === 0 ? (
            <div
              className="h-full"
              role="status"
              aria-busy="true"
            >
              <span className="sr-only">{t('sftp.connecting')}</span>
              <SftpTreeSkeleton />
            </div>
          ) : (
            <div
              role="tree"
              aria-label={t('sftp.directoryTreeLabel')}
              className="relative w-full"
              style={{ height: treeVirtualizer.getTotalSize() }}
            >
              {virtualTreeRows.map((virtualRow) => {
                const treeRow = visibleTreeRows[virtualRow.index];
                if (!treeRow) {
                  return null;
                }

                return (
                  <div
                    key={virtualRow.key}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderTreeRow(treeRow)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});
