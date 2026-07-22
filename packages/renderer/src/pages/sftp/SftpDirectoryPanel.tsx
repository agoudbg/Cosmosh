import {
  type ApiSftpEntry,
  isSftpDirectoryListColumnId,
  type SftpDirectoryListColumnId,
  type SftpDirectoryListSortDirection,
  type SftpDirectoryListViewSetting,
} from '@cosmosh/api-contract';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useVirtualizer } from '@tanstack/react-virtual';
import classNames from 'classnames';
import { ArrowDown, ArrowUp, File, Folder, ShieldAlert, Undo2 } from 'lucide-react';
import React from 'react';

import { Button } from '../../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../../components/ui/context-menu';
import { Input } from '../../components/ui/input';
import { Menubar } from '../../components/ui/menubar';
import { SftpFileListSkeleton } from '../../components/ui/skeleton';
import { useDateTimeFormatter } from '../../lib/date-time-format';
import { t } from '../../lib/i18n';
import { PARENT_DIRECTORY_ROW_KEY, SFTP_CARD_CLASS_NAME } from './sftp-constants';
import {
  buildSftpDirectoryGridTemplate,
  formatSftpDirectoryColumnValue,
  resolveSftpDirectoryListMinWidth,
  resolveVisibleSftpDirectoryColumns,
  SFTP_DIRECTORY_LIST_COLUMN_GAP_PX,
  type SftpDirectoryColumnDefinition,
} from './sftp-directory-view';
import type {
  SftpDirectoryDropEventHandler,
  SftpDirectoryDropTarget,
  SftpEntryDragStartHandler,
} from './sftp-drag-drop';
import type {
  PendingCreateState,
  SftpActionMenuOptions,
  SftpConnectionStatus,
  SftpFileNavigationRow,
  SftpSelectionClickEvent,
} from './sftp-types';
import { resolveEntryIcon } from './sftp-utils';
import {
  extractSftpVirtualRange,
  resolveIntersectingSftpVirtualRowRange,
  SFTP_DIRECTORY_HEADER_HEIGHT_PX,
  SFTP_DIRECTORY_ROW_HEIGHT_PX,
  SFTP_VIRTUAL_OVERSCAN_ROWS,
} from './sftp-virtualization';
import { SftpDirectoryViewMenuItems } from './SftpDirectoryViewMenuItems';

const PENDING_CREATE_ROW_KEY = '__sftp-pending-create__';

/**
 * One logical row in the virtualized SFTP directory list.
 */
type SftpDirectoryVirtualRow =
  | { kind: 'parent'; key: typeof PARENT_DIRECTORY_ROW_KEY }
  | { kind: 'create'; key: typeof PENDING_CREATE_ROW_KEY }
  | { kind: 'entry'; key: string; entry: ApiSftpEntry; entryIndex: number };

/**
 * Imperative focus surface exposed by the virtualized SFTP directory list.
 */
export type SftpDirectoryPanelHandle = {
  /** Reveals and focuses the requested parent or entry row. */
  focusRow: (rowKey: string) => void;
};

type SortableHeaderCellProps = {
  column: SftpDirectoryColumnDefinition;
  sort: SftpDirectoryListViewSetting['sort'];
  onSortFieldClick: (columnId: SftpDirectoryListColumnId) => void;
};

/**
 * Renders one draggable, sortable directory-list header cell.
 *
 * @param props Column definition, active sort state, and sort callback.
 * @returns Sortable header cell.
 */
const SortableHeaderCell: React.FC<SortableHeaderCellProps> = ({ column, sort, onSortFieldClick }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
  });
  const isSorted = sort.field === column.id;
  const transformStyle = transform
    ? CSS.Transform.toString({
        x: transform.x,
        y: 0,
        scaleX: 1,
        scaleY: 1,
      })
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transformStyle,
        transition: isDragging ? undefined : transition,
      }}
      className={classNames(
        '-mx-2 flex h-full min-w-0 items-center',
        column.align === 'right' ? 'justify-end' : 'justify-start',
        isDragging ? 'relative z-20 opacity-70' : '',
      )}
    >
      <button
        type="button"
        className={classNames(
          'flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm-2 px-2 text-xs font-medium text-home-text-subtle outline-none transition-colors hover:bg-home-card-hover focus-visible:ring-1 focus-visible:ring-outline',
          column.align === 'right' ? 'justify-end text-right' : 'justify-start text-left',
        )}
        {...attributes}
        {...listeners}
        onClick={() => onSortFieldClick(column.id)}
      >
        <span className="min-w-0 truncate">{t(column.labelI18nKey)}</span>
        {isSorted ? (
          sort.direction === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0" />
          )
        ) : null}
      </button>
    </div>
  );
};

/**
 * Props for the central SFTP directory listing panel.
 */
type SftpDirectoryPanelProps = {
  activeDropTarget: SftpDirectoryDropTarget | null;
  canActivateParentDirectoryListEntry: boolean;
  clipboardMode?: 'copy' | 'cut';
  clipboardPaths: ReadonlySet<string>;
  currentPath: string;
  directoryListView: SftpDirectoryListViewSetting;
  entries: ApiSftpEntry[];
  errorMessage: string;
  hasParentDirectoryListEntry: boolean;
  pendingCreate: PendingCreateState | null;
  renameInput: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renamingEntryPath: string;
  resolvedActiveFileRowKey: string;
  selectedPathSet: ReadonlySet<string>;
  sessionId: string;
  sftpDimHiddenEntries: boolean;
  sftpShowHiddenEntries: boolean;
  status: SftpConnectionStatus;
  visibleEntries: ApiSftpEntry[];
  onCancelInlineEdit: () => void;
  onCommitPendingCreate: () => Promise<void>;
  onCommitRenameEntry: (entry: ApiSftpEntry) => Promise<void>;
  onDirectoryBlankClick: () => void;
  onDirectoryListColumnOrderChange: (columnIds: SftpDirectoryListColumnId[]) => void;
  onDirectoryListColumnVisibilityChange: (columnId: SftpDirectoryListColumnId, visible: boolean) => void;
  onDirectoryListSortChange: (sort: {
    field: SftpDirectoryListColumnId;
    direction: SftpDirectoryListSortDirection;
  }) => void;
  onDirectoryListSortFieldClick: (columnId: SftpDirectoryListColumnId) => void;
  onDirectoryDropTargetDragEnter: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDragLeave: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDragOver: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetDrop: SftpDirectoryDropEventHandler;
  onDirectoryDropTargetReject: () => void;
  onEntryContextMenu: (entry: ApiSftpEntry) => void;
  onEntryDragEnd: () => void;
  onEntryDragStart: SftpEntryDragStartHandler;
  onEntryOpen: (entry: ApiSftpEntry) => void;
  onEntrySelect: (entry: ApiSftpEntry, event: SftpSelectionClickEvent) => void;
  onEntriesMarqueeSelect: (paths: string[], shouldExtendSelection: boolean) => void;
  onFileNavigationRowKeyDown: (event: React.KeyboardEvent<HTMLElement>, row: SftpFileNavigationRow) => void;
  onInlineEditInputBlur: (commit: () => void | Promise<void>) => void;
  onInlineEditMenuCloseAutoFocus: (event: Event) => void;
  onParentDirectory: () => void;
  onRefresh: () => void;
  onRenameInputChange: (value: string) => void;
  onSetActiveFileRowKey: (rowKey: string) => void;
  renderActionMenuItems: (options: SftpActionMenuOptions) => React.ReactNode;
};

/**
 * Renders the central SFTP directory table, inline create rows, and entry context menus.
 *
 * @param props Directory state and event handlers.
 * @param forwardedRef Imperative focus handle consumed by the tab-level keyboard controller.
 * @returns SFTP directory panel.
 */
export const SftpDirectoryPanel = React.forwardRef<SftpDirectoryPanelHandle, SftpDirectoryPanelProps>(
  function SftpDirectoryPanel(
    {
      activeDropTarget,
      canActivateParentDirectoryListEntry,
      clipboardMode,
      clipboardPaths,
      currentPath,
      directoryListView,
      entries,
      errorMessage,
      hasParentDirectoryListEntry,
      onCancelInlineEdit,
      onCommitPendingCreate,
      onCommitRenameEntry,
      onDirectoryBlankClick,
      onDirectoryListColumnOrderChange,
      onDirectoryListColumnVisibilityChange,
      onDirectoryListSortChange,
      onDirectoryListSortFieldClick,
      onDirectoryDropTargetDragEnter,
      onDirectoryDropTargetDragLeave,
      onDirectoryDropTargetDragOver,
      onDirectoryDropTargetDrop,
      onDirectoryDropTargetReject,
      onEntryContextMenu,
      onEntryDragEnd,
      onEntryDragStart,
      onEntryOpen,
      onEntrySelect,
      onEntriesMarqueeSelect,
      onFileNavigationRowKeyDown,
      onInlineEditInputBlur,
      onInlineEditMenuCloseAutoFocus,
      onParentDirectory,
      onRefresh,
      onRenameInputChange,
      onSetActiveFileRowKey,
      pendingCreate,
      renameInput,
      renameInputRef,
      renamingEntryPath,
      renderActionMenuItems,
      resolvedActiveFileRowKey,
      selectedPathSet,
      sessionId,
      sftpDimHiddenEntries,
      sftpShowHiddenEntries,
      status,
      visibleEntries,
    },
    forwardedRef,
  ) {
    const panelRef = React.useRef<HTMLElement | null>(null);
    const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
    const [scrollContainerElement, setScrollContainerElement] = React.useState<HTMLDivElement | null>(null);
    const directoryListRef = React.useRef<HTMLDivElement | null>(null);
    const fileRowRefs = React.useRef<Record<string, HTMLElement | null>>({});
    const pendingFocusRowKeyRef = React.useRef<string>('');
    const marqueePointerIdRef = React.useRef<number | null>(null);
    const marqueeStartRef = React.useRef({ x: 0, contentY: 0 });
    const marqueeExtendSelectionRef = React.useRef(false);
    const marqueeBasePathsRef = React.useRef<string[]>([]);
    const marqueePathsRef = React.useRef<string[]>([]);
    const marqueeActivatedRef = React.useRef(false);
    const marqueePointerPositionRef = React.useRef({ x: 0, y: 0 });
    const marqueeAutoScrollFrameRef = React.useRef<number | null>(null);
    const [contextMenuRowKey, setContextMenuRowKey] = React.useState<string>('');
    const [draggedRowKey, setDraggedRowKey] = React.useState<string>('');
    const [marqueePreviewPathSet, setMarqueePreviewPathSet] = React.useState<ReadonlySet<string>>(new Set());
    const [marqueeRect, setMarqueeRect] = React.useState<React.CSSProperties | null>(null);
    const { formatDateTime } = useDateTimeFormatter();
    const setScrollContainer = React.useCallback((element: HTMLDivElement | null): void => {
      scrollContainerRef.current = element;
      setScrollContainerElement(element);
    }, []);
    const visibleColumns = React.useMemo(
      () => resolveVisibleSftpDirectoryColumns(directoryListView),
      [directoryListView],
    );
    const directoryGridTemplate = React.useMemo(() => buildSftpDirectoryGridTemplate(visibleColumns), [visibleColumns]);
    const directoryGridStyle = React.useMemo<React.CSSProperties>(
      () => ({ columnGap: SFTP_DIRECTORY_LIST_COLUMN_GAP_PX, gridTemplateColumns: directoryGridTemplate }),
      [directoryGridTemplate],
    );
    const directoryListMinWidth = React.useMemo(
      () => resolveSftpDirectoryListMinWidth(visibleColumns),
      [visibleColumns],
    );
    const directoryListStyle = React.useMemo<React.CSSProperties>(
      () => ({ minWidth: directoryListMinWidth }),
      [directoryListMinWidth],
    );
    const skeletonColumns = React.useMemo(
      () => visibleColumns.map((column) => ({ id: column.id, align: column.align })),
      [visibleColumns],
    );
    const headerColumnIds = React.useMemo(() => visibleColumns.map((column) => column.id), [visibleColumns]);
    const headerDragSensors = useSensors(
      useSensor(MouseSensor, {
        activationConstraint: { distance: 6 },
      }),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      }),
    );
    const directoryRows = React.useMemo<SftpDirectoryVirtualRow[]>(() => {
      const rows: SftpDirectoryVirtualRow[] = [];

      if (hasParentDirectoryListEntry) {
        rows.push({ kind: 'parent', key: PARENT_DIRECTORY_ROW_KEY });
      }

      if (pendingCreate) {
        rows.push({ kind: 'create', key: PENDING_CREATE_ROW_KEY });
      }

      visibleEntries.forEach((entry, entryIndex) => {
        rows.push({ kind: 'entry', key: entry.path, entry, entryIndex });
      });

      return rows;
    }, [hasParentDirectoryListEntry, pendingCreate, visibleEntries]);
    const directoryRowIndexByKey = React.useMemo(
      () => new Map(directoryRows.map((row, index) => [row.key, index])),
      [directoryRows],
    );
    const activeRowIndex = resolvedActiveFileRowKey ? (directoryRowIndexByKey.get(resolvedActiveFileRowKey) ?? -1) : -1;
    const inlineEditRowIndex = pendingCreate
      ? (directoryRowIndexByKey.get(PENDING_CREATE_ROW_KEY) ?? -1)
      : renamingEntryPath
        ? (directoryRowIndexByKey.get(renamingEntryPath) ?? -1)
        : -1;
    const contextMenuRowIndex = contextMenuRowKey ? (directoryRowIndexByKey.get(contextMenuRowKey) ?? -1) : -1;
    const draggedRowIndex = draggedRowKey ? (directoryRowIndexByKey.get(draggedRowKey) ?? -1) : -1;
    const extractDirectoryRowRange = React.useCallback(
      (range: Parameters<typeof extractSftpVirtualRange>[0]): number[] =>
        extractSftpVirtualRange(range, [activeRowIndex, inlineEditRowIndex, contextMenuRowIndex, draggedRowIndex]),
      [activeRowIndex, contextMenuRowIndex, draggedRowIndex, inlineEditRowIndex],
    );
    /**
     * Resolves a stable key without invalidating virtualizer measurements on unrelated renders.
     *
     * @param index Logical directory row index.
     * @returns Remote entry key or the index fallback.
     */
    const getDirectoryRowKey = React.useCallback(
      (index: number): string | number => directoryRows[index]?.key ?? index,
      [directoryRows],
    );
    const directoryVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: directoryRows.length,
      estimateSize: () => SFTP_DIRECTORY_ROW_HEIGHT_PX,
      getItemKey: getDirectoryRowKey,
      getScrollElement: () => scrollContainerElement,
      overscan: SFTP_VIRTUAL_OVERSCAN_ROWS,
      rangeExtractor: extractDirectoryRowRange,
      scrollMargin: SFTP_DIRECTORY_HEADER_HEIGHT_PX,
      scrollPaddingStart: SFTP_DIRECTORY_HEADER_HEIGHT_PX,
    });
    const virtualDirectoryRows = directoryVirtualizer.getVirtualItems();
    const directoryListHeight = Math.max(
      directoryVirtualizer.getTotalSize(),
      Math.max(0, (scrollContainerElement?.clientHeight ?? 0) - SFTP_DIRECTORY_HEADER_HEIGHT_PX),
    );

    /**
     * Reveals and focuses a directory row even when virtualization has not mounted it yet.
     *
     * @param rowKey Parent-row key or remote entry path.
     * @returns void.
     */
    const focusRow = React.useCallback(
      (rowKey: string): void => {
        const rowIndex = directoryRowIndexByKey.get(rowKey);
        if (rowIndex === undefined) {
          return;
        }

        pendingFocusRowKeyRef.current = rowKey;
        directoryVirtualizer.scrollToIndex(rowIndex, { align: 'auto' });

        const mountedRow = fileRowRefs.current[rowKey];
        if (mountedRow) {
          mountedRow.focus({ preventScroll: true });
          pendingFocusRowKeyRef.current = '';
        }
      },
      [directoryRowIndexByKey, directoryVirtualizer],
    );

    React.useImperativeHandle(forwardedRef, () => ({ focusRow }), [focusRow]);

    React.useEffect(() => {
      if (!draggedRowKey) {
        return undefined;
      }

      /** Clears the pinned drag-source row when the native drag lifecycle ends outside its element. */
      const clearDraggedRow = (): void => setDraggedRowKey('');

      window.addEventListener('dragend', clearDraggedRow, true);
      window.addEventListener('blur', clearDraggedRow);
      return () => {
        window.removeEventListener('dragend', clearDraggedRow, true);
        window.removeEventListener('blur', clearDraggedRow);
      };
    }, [draggedRowKey]);

    /**
     * Registers only mounted virtual rows and completes any pending keyboard focus handoff.
     *
     * @param rowKey Parent-row key or remote entry path.
     * @param element Mounted row element, or null during virtual unmount.
     * @returns void.
     */
    const registerFileRow = React.useCallback((rowKey: string, element: HTMLElement | null): void => {
      if (!element) {
        delete fileRowRefs.current[rowKey];
        return;
      }

      fileRowRefs.current[rowKey] = element;
      if (pendingFocusRowKeyRef.current === rowKey) {
        element.focus({ preventScroll: true });
        pendingFocusRowKeyRef.current = '';
      }
    }, []);

    /**
     * Resolves entry paths whose logical fixed-height rows intersect the active marquee.
     *
     * @param left Marquee left edge in viewport coordinates.
     * @param top Marquee top edge in scroll-content coordinates.
     * @param right Marquee right edge in viewport coordinates.
     * @param bottom Marquee bottom edge in scroll-content coordinates.
     * @returns Intersecting entry paths in visible directory order.
     */
    const resolveMarqueeEntryPaths = React.useCallback(
      (left: number, top: number, right: number, bottom: number): string[] => {
        const scrollContainer = scrollContainerRef.current;
        const directoryList = directoryListRef.current;
        if (!scrollContainer || !directoryList) {
          return [];
        }

        const listRect = directoryList.getBoundingClientRect();
        if (right < listRect.left || left > listRect.right) {
          return [];
        }

        const entryRowOffset = Number(hasParentDirectoryListEntry) + Number(Boolean(pendingCreate));
        const entryRowsStartOffset = SFTP_DIRECTORY_HEADER_HEIGHT_PX + entryRowOffset * SFTP_DIRECTORY_ROW_HEIGHT_PX;
        const intersectingRange = resolveIntersectingSftpVirtualRowRange(
          visibleEntries.length,
          SFTP_DIRECTORY_ROW_HEIGHT_PX,
          entryRowsStartOffset,
          top,
          bottom,
        );
        if (!intersectingRange) {
          return [];
        }

        return visibleEntries
          .slice(intersectingRange.startIndex, intersectingRange.endIndex + 1)
          .map((entry) => entry.path);
      },
      [hasParentDirectoryListEntry, pendingCreate, visibleEntries],
    );

    /**
     * Starts marquee selection from list whitespace or the panel padding beside the list.
     *
     * @param event Primary pointer event captured by the directory panel.
     * @returns void.
     */
    const handleMarqueePointerDown = React.useCallback(
      (event: React.PointerEvent<HTMLElement>): void => {
        if (event.button !== 0 || status !== 'ready' || pendingCreate || renamingEntryPath) {
          return;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        if (target.closest('[data-sftp-entry-row], [data-sftp-list-header], input, button, [role="menuitem"]')) {
          return;
        }

        const scrollContainer = scrollContainerRef.current;
        if (!scrollContainer) {
          return;
        }

        const scrollRect = scrollContainer.getBoundingClientRect();
        marqueePointerIdRef.current = event.pointerId;
        marqueeStartRef.current = {
          x: event.clientX,
          contentY: event.clientY - scrollRect.top + scrollContainer.scrollTop,
        };
        marqueePointerPositionRef.current = { x: event.clientX, y: event.clientY };
        marqueeExtendSelectionRef.current = window.electron?.platform === 'darwin' ? event.metaKey : event.ctrlKey;
        marqueeBasePathsRef.current = marqueeExtendSelectionRef.current ? Array.from(selectedPathSet) : [];
        marqueePathsRef.current = [];
        marqueeActivatedRef.current = false;
        setMarqueePreviewPathSet(new Set(marqueeBasePathsRef.current));
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      [pendingCreate, renamingEntryPath, selectedPathSet, status],
    );

    /**
     * Updates the marquee geometry and the rows currently previewed as selected.
     *
     * @param clientX Pointer x coordinate in the viewport.
     * @param clientY Pointer y coordinate in the viewport.
     * @returns void.
     */
    const updateMarqueeSelectionPreview = React.useCallback(
      (clientX: number, clientY: number): void => {
        const panelRect = panelRef.current?.getBoundingClientRect();
        const scrollContainer = scrollContainerRef.current;
        if (!panelRect || !scrollContainer) {
          return;
        }

        const scrollRect = scrollContainer.getBoundingClientRect();
        const pointerContentY = clientY - scrollRect.top + scrollContainer.scrollTop;
        const left = Math.min(marqueeStartRef.current.x, clientX);
        const top = Math.min(marqueeStartRef.current.contentY, pointerContentY);
        const right = Math.max(marqueeStartRef.current.x, clientX);
        const bottom = Math.max(marqueeStartRef.current.contentY, pointerContentY);
        if (!marqueeActivatedRef.current && right - left < 3 && bottom - top < 3) {
          return;
        }

        marqueeActivatedRef.current = true;
        setMarqueeRect({
          left: left - panelRect.left,
          top: scrollRect.top - panelRect.top + top - scrollContainer.scrollTop,
          width: right - left,
          height: bottom - top,
        });
        marqueePathsRef.current = resolveMarqueeEntryPaths(left, top, right, bottom);
        setMarqueePreviewPathSet(new Set([...marqueeBasePathsRef.current, ...marqueePathsRef.current]));
      },
      [resolveMarqueeEntryPaths],
    );

    /**
     * Continues scrolling while the captured pointer remains near a vertical list edge.
     *
     * @returns void.
     */
    const runMarqueeAutoScroll = React.useCallback((): void => {
      const scrollContainer = scrollContainerRef.current;
      if (marqueePointerIdRef.current === null || !scrollContainer) {
        marqueeAutoScrollFrameRef.current = null;
        return;
      }

      const scrollRect = scrollContainer.getBoundingClientRect();
      const pointerY = marqueePointerPositionRef.current.y;
      const edgeThreshold = 56;
      let scrollDelta = 0;
      if (pointerY < scrollRect.top + edgeThreshold) {
        scrollDelta = -Math.ceil(((scrollRect.top + edgeThreshold - pointerY) / edgeThreshold) * 18);
      } else if (pointerY > scrollRect.bottom - edgeThreshold) {
        scrollDelta = Math.ceil(((pointerY - (scrollRect.bottom - edgeThreshold)) / edgeThreshold) * 18);
      }

      if (scrollDelta !== 0) {
        const previousScrollTop = scrollContainer.scrollTop;
        scrollContainer.scrollTop += scrollDelta;
        if (scrollContainer.scrollTop !== previousScrollTop) {
          updateMarqueeSelectionPreview(marqueePointerPositionRef.current.x, marqueePointerPositionRef.current.y);
        }
      }

      marqueeAutoScrollFrameRef.current = window.requestAnimationFrame(runMarqueeAutoScroll);
    }, [updateMarqueeSelectionPreview]);

    /**
     * Updates the marquee overlay and live selection as the pointer moves.
     *
     * @param event Captured pointer movement event.
     * @returns void.
     */
    const handleMarqueePointerMove = React.useCallback(
      (event: React.PointerEvent<HTMLElement>): void => {
        if (marqueePointerIdRef.current !== event.pointerId) {
          return;
        }

        marqueePointerPositionRef.current = { x: event.clientX, y: event.clientY };
        updateMarqueeSelectionPreview(event.clientX, event.clientY);
        if (marqueeActivatedRef.current && marqueeAutoScrollFrameRef.current === null) {
          marqueeAutoScrollFrameRef.current = window.requestAnimationFrame(runMarqueeAutoScroll);
        }
      },
      [runMarqueeAutoScroll, updateMarqueeSelectionPreview],
    );

    /**
     * Completes marquee interaction and restores normal pointer behavior.
     *
     * @param event Captured pointer completion event.
     * @returns void.
     */
    const handleMarqueePointerEnd = React.useCallback(
      (event: React.PointerEvent<HTMLElement>): void => {
        if (marqueePointerIdRef.current !== event.pointerId) {
          return;
        }

        if (marqueeActivatedRef.current) {
          onEntriesMarqueeSelect([...marqueeBasePathsRef.current, ...marqueePathsRef.current], false);
        } else {
          onDirectoryBlankClick();
        }

        marqueePointerIdRef.current = null;
        marqueeActivatedRef.current = false;
        setMarqueePreviewPathSet(new Set());
        setMarqueeRect(null);
        if (marqueeAutoScrollFrameRef.current !== null) {
          window.cancelAnimationFrame(marqueeAutoScrollFrameRef.current);
          marqueeAutoScrollFrameRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      },
      [onDirectoryBlankClick, onEntriesMarqueeSelect],
    );
    const currentDirectoryDropTarget = React.useMemo<SftpDirectoryDropTarget>(
      () => ({
        path: currentPath,
        surface: 'current-directory',
      }),
      [currentPath],
    );
    const isCurrentDirectoryDropTargetActive =
      activeDropTarget?.surface === 'current-directory' && activeDropTarget.path === currentPath;

    const handleHeaderDragEnd = React.useCallback(
      (event: DragEndEvent): void => {
        const activeId = event.active.id;
        const overId = event.over?.id;
        if (!isSftpDirectoryListColumnId(activeId) || !isSftpDirectoryListColumnId(overId) || activeId === overId) {
          return;
        }

        const currentColumnIds = directoryListView.columns.map((column) => column.id);
        const oldIndex = currentColumnIds.indexOf(activeId);
        const newIndex = currentColumnIds.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0) {
          return;
        }

        onDirectoryListColumnOrderChange(arrayMove(currentColumnIds, oldIndex, newIndex));
      },
      [directoryListView.columns, onDirectoryListColumnOrderChange],
    );

    /**
     * Keeps file and inline-edit rows from becoming implicit current-directory drop targets.
     *
     * @param event Row drag event.
     * @returns void.
     */
    const stopNonDirectoryRowDropPropagation = React.useCallback(
      (event: React.DragEvent<HTMLElement>): void => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'none';
        onDirectoryDropTargetReject();
      },
      [onDirectoryDropTargetReject],
    );

    /**
     * Prevents dropped local files on non-target rows from navigating the renderer document.
     *
     * @param event Row drop event.
     * @returns void.
     */
    const blockNonDirectoryRowDrop = React.useCallback(
      (event: React.DragEvent<HTMLElement>): void => {
        event.preventDefault();
        event.stopPropagation();
        onDirectoryDropTargetReject();
      },
      [onDirectoryDropTargetReject],
    );

    /**
     * Accepts drops only on the listbox blank area, not on bubbled row events.
     *
     * @param event Current-directory drop event.
     * @param handler Directory drop handler to invoke.
     * @returns void.
     */
    const handleDirectoryBlankAreaDropEvent = React.useCallback(
      (event: React.DragEvent<HTMLElement>, handler: SftpDirectoryDropEventHandler): void => {
        if (event.currentTarget !== event.target) {
          return;
        }

        handler(event, currentDirectoryDropTarget);
      },
      [currentDirectoryDropTarget],
    );

    const renderPlaceholderCell = React.useCallback((column: SftpDirectoryColumnDefinition): React.ReactNode => {
      return (
        <span
          key={column.id}
          className={classNames(
            'min-w-0 truncate text-xs text-home-text-subtle',
            column.align === 'right' && 'text-right',
            column.monospace && 'font-mono',
          )}
        >
          -
        </span>
      );
    }, []);

    return (
      <main
        ref={panelRef}
        className={classNames(SFTP_CARD_CLASS_NAME, 'relative select-none')}
        onPointerDown={handleMarqueePointerDown}
        onPointerMove={handleMarqueePointerMove}
        onPointerUp={handleMarqueePointerEnd}
        onPointerCancel={handleMarqueePointerEnd}
      >
        {marqueeRect ? (
          <div
            aria-hidden="true"
            className="bg-home-card-active/55 pointer-events-none absolute z-30 rounded-sm-2 border-2 border-outline shadow-sm"
            style={marqueeRect}
          />
        ) : null}
        {status === 'error' ? (
          <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
            <div className="flex max-w-[360px] flex-col items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-form-message-error" />
              <div className="text-home-text text-sm">{errorMessage || t('sftp.loadFailed')}</div>
              <Menubar>
                <Button
                  variant="ghost"
                  padding="mid"
                  disabled={!sessionId}
                  onClick={onRefresh}
                >
                  {t('sftp.actions.retry')}
                </Button>
              </Menubar>
            </div>
          </div>
        ) : status === 'connecting' || status === 'loading' ? (
          <div
            className="h-full min-h-0 overflow-auto"
            role="status"
            aria-busy="true"
          >
            <span className="sr-only">{status === 'connecting' ? t('sftp.connecting') : t('sftp.loading')}</span>
            <div
              className="flex min-h-full flex-col"
              style={directoryListStyle}
            >
              <SftpFileListSkeleton
                columnGap={SFTP_DIRECTORY_LIST_COLUMN_GAP_PX}
                columns={skeletonColumns}
                gridTemplateColumns={directoryGridTemplate}
                minWidth={directoryListMinWidth}
              />
            </div>
          </div>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={setScrollContainer}
                className="h-full min-h-0 overflow-auto"
              >
                <div
                  className="flex min-h-full flex-col"
                  style={directoryListStyle}
                >
                  <DndContext
                    collisionDetection={closestCenter}
                    modifiers={[restrictToHorizontalAxis]}
                    sensors={headerDragSensors}
                    onDragEnd={handleHeaderDragEnd}
                  >
                    <SortableContext
                      items={headerColumnIds}
                      strategy={horizontalListSortingStrategy}
                    >
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            data-sftp-list-header="true"
                            className="sticky top-0 z-10 grid h-[30px] shrink-0 items-center bg-ssh-card-bg-terminal px-3 text-xs font-medium text-home-text-subtle"
                            style={directoryGridStyle}
                          >
                            {visibleColumns.map((column) => (
                              <SortableHeaderCell
                                key={column.id}
                                column={column}
                                sort={directoryListView.sort}
                                onSortFieldClick={onDirectoryListSortFieldClick}
                              />
                            ))}
                            <span />
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent onCloseAutoFocus={onInlineEditMenuCloseAutoFocus}>
                          <SftpDirectoryViewMenuItems
                            columnsPlacement="inline"
                            directoryListView={directoryListView}
                            menuSurface="context"
                            onColumnVisibilityChange={onDirectoryListColumnVisibilityChange}
                            onSortChange={onDirectoryListSortChange}
                          />
                        </ContextMenuContent>
                      </ContextMenu>
                    </SortableContext>
                  </DndContext>
                  <div
                    ref={directoryListRef}
                    role="listbox"
                    aria-label={t('sftp.directoryListLabel')}
                    aria-multiselectable="true"
                    className={classNames(
                      'relative shrink-0 rounded-lg transition-colors',
                      isCurrentDirectoryDropTargetActive && 'bg-home-card-active',
                    )}
                    style={{ height: directoryListHeight }}
                    onClick={(event) => {
                      if (event.button === 0 && event.currentTarget === event.target) {
                        onDirectoryBlankClick();
                      }
                    }}
                    onDragEnter={(event) => {
                      handleDirectoryBlankAreaDropEvent(event, onDirectoryDropTargetDragEnter);
                    }}
                    onDragLeave={(event) => {
                      handleDirectoryBlankAreaDropEvent(event, onDirectoryDropTargetDragLeave);
                    }}
                    onDragOver={(event) => {
                      handleDirectoryBlankAreaDropEvent(event, onDirectoryDropTargetDragOver);
                    }}
                    onDrop={(event) => {
                      handleDirectoryBlankAreaDropEvent(event, onDirectoryDropTargetDrop);
                    }}
                  >
                    {status === 'idle' ? (
                      <div className="flex h-full items-center justify-center px-4 text-sm text-home-text-subtle">
                        {t('sftp.noSession')}
                      </div>
                    ) : null}
                    {status === 'ready' && entries.length === 0 && !pendingCreate && !hasParentDirectoryListEntry ? (
                      <div
                        className="flex h-full items-center justify-center px-4 text-sm text-home-text-subtle"
                        onDragEnter={(event) => onDirectoryDropTargetDragEnter(event, currentDirectoryDropTarget)}
                        onDragLeave={(event) => onDirectoryDropTargetDragLeave(event, currentDirectoryDropTarget)}
                        onDragOver={(event) => onDirectoryDropTargetDragOver(event, currentDirectoryDropTarget)}
                        onDrop={(event) => onDirectoryDropTargetDrop(event, currentDirectoryDropTarget)}
                      >
                        {t('sftp.empty')}
                      </div>
                    ) : null}
                    {status === 'ready' &&
                    entries.length > 0 &&
                    visibleEntries.length === 0 &&
                    !hasParentDirectoryListEntry ? (
                      <div
                        className="flex h-full items-center justify-center px-4 text-sm text-home-text-subtle"
                        onDragEnter={(event) => onDirectoryDropTargetDragEnter(event, currentDirectoryDropTarget)}
                        onDragLeave={(event) => onDirectoryDropTargetDragLeave(event, currentDirectoryDropTarget)}
                        onDragOver={(event) => onDirectoryDropTargetDragOver(event, currentDirectoryDropTarget)}
                        onDrop={(event) => onDirectoryDropTargetDrop(event, currentDirectoryDropTarget)}
                      >
                        {t('sftp.searchEmpty')}
                      </div>
                    ) : null}
                    {status === 'ready'
                      ? virtualDirectoryRows.map((virtualRow) => {
                          const directoryRow = directoryRows[virtualRow.index];
                          if (!directoryRow) {
                            return null;
                          }

                          let rowContent: React.ReactNode;
                          if (directoryRow.kind === 'parent') {
                            rowContent = (
                              <div
                                ref={(element) => registerFileRow(PARENT_DIRECTORY_ROW_KEY, element)}
                                role="option"
                                aria-label={t('sftp.parentDirectoryEntryLabel')}
                                aria-selected="false"
                                aria-disabled={!canActivateParentDirectoryListEntry}
                                aria-posinset={1}
                                aria-setsize={Number(hasParentDirectoryListEntry) + visibleEntries.length}
                                tabIndex={
                                  canActivateParentDirectoryListEntry &&
                                  resolvedActiveFileRowKey === PARENT_DIRECTORY_ROW_KEY
                                    ? 0
                                    : -1
                                }
                                className={classNames(
                                  'grid h-[34px] w-full items-center rounded-lg px-3 text-left text-sm transition-colors',
                                  canActivateParentDirectoryListEntry
                                    ? 'text-home-text hover:bg-home-card-hover'
                                    : 'cursor-default text-home-text-subtle opacity-55',
                                )}
                                style={directoryGridStyle}
                                onDragEnter={stopNonDirectoryRowDropPropagation}
                                onDragOver={stopNonDirectoryRowDropPropagation}
                                onDrop={blockNonDirectoryRowDrop}
                                onDoubleClick={canActivateParentDirectoryListEntry ? onParentDirectory : undefined}
                                onFocus={() => {
                                  if (canActivateParentDirectoryListEntry) {
                                    onSetActiveFileRowKey(PARENT_DIRECTORY_ROW_KEY);
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (canActivateParentDirectoryListEntry) {
                                    onFileNavigationRowKeyDown(event, {
                                      kind: 'parent',
                                      key: PARENT_DIRECTORY_ROW_KEY,
                                    });
                                  }
                                }}
                              >
                                {visibleColumns.map((column) =>
                                  column.id === 'name' ? (
                                    <span
                                      key={column.id}
                                      className="flex min-w-0 items-center gap-2 overflow-hidden"
                                    >
                                      <Undo2
                                        className={classNames(
                                          'h-4 w-4 shrink-0',
                                          canActivateParentDirectoryListEntry
                                            ? 'text-home-text'
                                            : 'text-home-text-subtle',
                                        )}
                                      />
                                      <span className="truncate">..</span>
                                    </span>
                                  ) : (
                                    renderPlaceholderCell(column)
                                  ),
                                )}
                                <span />
                              </div>
                            );
                          } else if (directoryRow.kind === 'create' && pendingCreate) {
                            rowContent = (
                              <div
                                className="text-home-text grid h-[34px] w-full items-center rounded-lg bg-home-card-hover px-3 text-left text-sm"
                                style={directoryGridStyle}
                                onDragEnter={stopNonDirectoryRowDropPropagation}
                                onDragOver={stopNonDirectoryRowDropPropagation}
                                onDrop={blockNonDirectoryRowDrop}
                              >
                                {visibleColumns.map((column) =>
                                  column.id === 'name' ? (
                                    <span
                                      key={column.id}
                                      className="flex min-w-0 items-center gap-2 overflow-hidden"
                                    >
                                      {pendingCreate.type === 'directory' ? (
                                        <Folder className="text-home-text h-4 w-4 shrink-0" />
                                      ) : (
                                        <File className="text-home-text h-4 w-4 shrink-0" />
                                      )}
                                      <Input
                                        ref={renameInputRef}
                                        aria-label={t('sftp.renameInputLabel')}
                                        className="h-[26px] min-w-0 flex-1 rounded-sm-2 px-0 text-sm"
                                        value={renameInput}
                                        onBlur={() => {
                                          onInlineEditInputBlur(onCommitPendingCreate);
                                        }}
                                        onChange={(event) => onRenameInputChange(event.target.value)}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void onCommitPendingCreate();
                                          }

                                          if (event.key === 'Escape') {
                                            event.preventDefault();
                                            onCancelInlineEdit();
                                          }
                                        }}
                                      />
                                    </span>
                                  ) : (
                                    renderPlaceholderCell(column)
                                  ),
                                )}
                                <span />
                              </div>
                            );
                          } else if (directoryRow.kind === 'entry') {
                            const { entry, entryIndex } = directoryRow;
                            const effectiveSelectedPathSet = marqueeRect ? marqueePreviewPathSet : selectedPathSet;
                            const isSelected = effectiveSelectedPathSet.has(entry.path);
                            const hasSelectedPreviousEntry =
                              isSelected &&
                              entryIndex > 0 &&
                              effectiveSelectedPathSet.has(visibleEntries[entryIndex - 1]?.path ?? '');
                            const hasSelectedNextEntry =
                              isSelected &&
                              entryIndex < visibleEntries.length - 1 &&
                              effectiveSelectedPathSet.has(visibleEntries[entryIndex + 1]?.path ?? '');
                            const isCut = clipboardMode === 'cut' ? clipboardPaths.has(entry.path) : false;
                            const shouldDimHiddenEntry =
                              sftpShowHiddenEntries && sftpDimHiddenEntries && entry.isHidden;
                            const hiddenEntryVisualClassName = shouldDimHiddenEntry ? 'opacity-80' : undefined;
                            const isDirectoryDropTarget = entry.type === 'directory';
                            const isActiveDropTarget =
                              isDirectoryDropTarget &&
                              activeDropTarget?.surface === 'directory-list' &&
                              activeDropTarget.path === entry.path;

                            rowContent = (
                              <ContextMenu onOpenChange={(open) => setContextMenuRowKey(open ? entry.path : '')}>
                                <ContextMenuTrigger asChild>
                                  <div
                                    ref={(element) => registerFileRow(entry.path, element)}
                                    data-sftp-entry-row="true"
                                    role="option"
                                    aria-selected={isSelected}
                                    aria-label={entry.name}
                                    aria-posinset={Number(hasParentDirectoryListEntry) + entryIndex + 1}
                                    aria-setsize={Number(hasParentDirectoryListEntry) + visibleEntries.length}
                                    draggable={renamingEntryPath !== entry.path}
                                    tabIndex={resolvedActiveFileRowKey === entry.path ? 0 : -1}
                                    className={classNames(
                                      'grid h-[34px] w-full items-center px-3 text-left text-sm transition-colors hover:bg-home-card-hover',
                                      hasSelectedPreviousEntry && hasSelectedNextEntry
                                        ? 'rounded-none'
                                        : hasSelectedPreviousEntry
                                          ? 'rounded-b-lg rounded-t-none'
                                          : hasSelectedNextEntry
                                            ? 'rounded-b-none rounded-t-lg'
                                            : 'rounded-lg',
                                      isSelected ? 'text-home-text bg-home-card-hover' : 'text-home-text',
                                      isActiveDropTarget ? 'bg-home-card-active' : '',
                                      isCut ? 'opacity-55' : '',
                                    )}
                                    style={directoryGridStyle}
                                    onClick={(event) => {
                                      onSetActiveFileRowKey(entry.path);
                                      onEntrySelect(entry, event);
                                    }}
                                    onDoubleClick={() => onEntryOpen(entry)}
                                    onContextMenu={() => onEntryContextMenu(entry)}
                                    onDragEnd={() => {
                                      setDraggedRowKey('');
                                      onEntryDragEnd();
                                    }}
                                    onDragEnter={
                                      isDirectoryDropTarget
                                        ? (event) =>
                                            onDirectoryDropTargetDragEnter(event, {
                                              path: entry.path,
                                              surface: 'directory-list',
                                            })
                                        : stopNonDirectoryRowDropPropagation
                                    }
                                    onDragLeave={
                                      isDirectoryDropTarget
                                        ? (event) =>
                                            onDirectoryDropTargetDragLeave(event, {
                                              path: entry.path,
                                              surface: 'directory-list',
                                            })
                                        : stopNonDirectoryRowDropPropagation
                                    }
                                    onDragOver={
                                      isDirectoryDropTarget
                                        ? (event) =>
                                            onDirectoryDropTargetDragOver(event, {
                                              path: entry.path,
                                              surface: 'directory-list',
                                            })
                                        : stopNonDirectoryRowDropPropagation
                                    }
                                    onDragStart={(event) => {
                                      setDraggedRowKey(entry.path);
                                      onEntryDragStart(entry, event);
                                    }}
                                    onDrop={
                                      isDirectoryDropTarget
                                        ? (event) =>
                                            onDirectoryDropTargetDrop(event, {
                                              path: entry.path,
                                              surface: 'directory-list',
                                            })
                                        : blockNonDirectoryRowDrop
                                    }
                                    onFocus={() => onSetActiveFileRowKey(entry.path)}
                                    onKeyDown={(event) => {
                                      onFileNavigationRowKeyDown(event, {
                                        kind: 'entry',
                                        key: entry.path,
                                        entry,
                                      });
                                    }}
                                  >
                                    {visibleColumns.map((column) =>
                                      column.id === 'name' ? (
                                        <span
                                          key={column.id}
                                          className="flex min-w-0 items-center gap-2 overflow-hidden"
                                        >
                                          {resolveEntryIcon(entry, hiddenEntryVisualClassName)}
                                          {renamingEntryPath === entry.path ? (
                                            <Input
                                              ref={renameInputRef}
                                              aria-label={t('sftp.renameInputLabel')}
                                              className="h-[26px] min-w-0 flex-1 rounded-sm-2 px-0 text-sm"
                                              value={renameInput}
                                              onClick={(event) => event.stopPropagation()}
                                              onBlur={() => {
                                                onInlineEditInputBlur(() => onCommitRenameEntry(entry));
                                              }}
                                              onChange={(event) => onRenameInputChange(event.target.value)}
                                              onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                  event.preventDefault();
                                                  void onCommitRenameEntry(entry);
                                                }

                                                if (event.key === 'Escape') {
                                                  event.preventDefault();
                                                  onCancelInlineEdit();
                                                }
                                              }}
                                            />
                                          ) : (
                                            <span className={classNames('truncate', hiddenEntryVisualClassName)}>
                                              {entry.name}
                                            </span>
                                          )}
                                        </span>
                                      ) : (
                                        <span
                                          key={column.id}
                                          className={classNames(
                                            'min-w-0 truncate text-xs text-home-text-subtle',
                                            column.align === 'right' && 'text-right',
                                            column.monospace && 'font-mono',
                                            hiddenEntryVisualClassName,
                                          )}
                                        >
                                          {formatSftpDirectoryColumnValue(column.id, entry, formatDateTime)}
                                        </span>
                                      ),
                                    )}
                                    <span />
                                  </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent onCloseAutoFocus={onInlineEditMenuCloseAutoFocus}>
                                  {renderActionMenuItems({
                                    contextEntry: entry,
                                    menuSurface: 'context',
                                    scope: 'entry',
                                    showShortcuts: true,
                                  })}
                                </ContextMenuContent>
                              </ContextMenu>
                            );
                          } else {
                            return null;
                          }

                          return (
                            <div
                              key={virtualRow.key}
                              className="absolute left-0 top-0 w-full"
                              style={{
                                height: virtualRow.size,
                                transform: `translateY(${virtualRow.start - SFTP_DIRECTORY_HEADER_HEIGHT_PX}px)`,
                              }}
                            >
                              {rowContent}
                            </div>
                          );
                        })
                      : null}
                  </div>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent onCloseAutoFocus={onInlineEditMenuCloseAutoFocus}>
              {renderActionMenuItems({
                contextEntry: null,
                menuSurface: 'context',
                scope: 'directory',
                showShortcuts: true,
              })}
            </ContextMenuContent>
          </ContextMenu>
        )}
      </main>
    );
  },
);
