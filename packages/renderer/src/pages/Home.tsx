import type { components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  CalendarPlus,
  Clock3,
  Cloud,
  Copy,
  Database,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Folders,
  HardDrive,
  Hash,
  Link,
  Network,
  Package2,
  PackageOpen,
  Pencil,
  Plus,
  Search,
  Server,
  Tags,
  Terminal,
  Trash2,
} from 'lucide-react';
import React from 'react';

import EntityCard from '../components/home/EntityCard';
import HomeEmptyState from '../components/home/HomeEmptyState';
import {
  AlertDialog,
  AlertDialogActionButton,
  AlertDialogCancelButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { menuStyles } from '../components/ui/menu-styles';
import { Menubar, MenubarSeparator, MenuToggleGroup, MenuToggleGroupItem } from '../components/ui/menubar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import type { LocalTerminalProfile } from '../lib/api/transport';
import {
  deleteSshServer,
  listLocalTerminalProfiles,
  listSshFolders,
  listSshServers,
  updateSshServer,
} from '../lib/backend';
import { createFolder, normalizeFolderName, removeFolder, renameFolder } from '../lib/folder-actions';
import { consumeOpenLocalTerminalListRequest } from '../lib/home-target';
import { colorKeyToClassName, type HomeIconKey, resolveHomeVisual } from '../lib/home-visuals';
import { getLocale, t } from '../lib/i18n';
import { toLocalTerminalTargetId } from '../lib/ssh-target';
import { useToast } from '../lib/toast-context';
import { useDirectionalNavigation } from '../lib/use-directional-navigation';

type HomeProps = {
  onOpenSSH: (serverId: string, tabTitle?: string, options?: { openInNewTab?: boolean }) => void;
  onOpenSshEditor: (serverId: string) => void;
  isActive: boolean;
};

type SshServerListItem = components['schemas']['SshServerListItem'];
type SshFolder = components['schemas']['SshFolder'];
type QuickFilter = 'none' | 'recent' | 'favorite';
type GroupMode = 'none' | 'lastUsed' | 'tag';
type SortMode = 'nameAsc' | 'nameDesc' | 'lastUsed' | 'createdAt';

type ServerGroup = {
  key: string;
  title: string;
  items: SshServerListItem[];
};

type SidebarCardItem = {
  key: string;
  folderId?: string;
  title: string;
  subtitle: string;
  selected: boolean;
  iconKey: HomeIconKey;
  iconClassName: string;
  imageUrl?: string;
  onClick: () => void;
};

const LOCAL_TERMINAL_FOLDER_ID = '__local_terminals__';

const iconMap: Record<HomeIconKey, React.ComponentType<{ className?: string }>> = {
  Folder,
  Folders,
  Package2,
  Network,
  Cloud,
  Database,
  Server,
  HardDrive,
};

const resolveGreetingPeriod = (now: Date): 'morning' | 'afternoon' | 'evening' => {
  const hour = now.getHours();
  if (hour < 12) {
    return 'morning';
  }

  if (hour < 18) {
    return 'afternoon';
  }

  return 'evening';
};

const hashString = (value: string): number => {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return hash >>> 0;
};

const Home: React.FC<HomeProps> = ({ onOpenSSH, onOpenSshEditor, isActive }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const [servers, setServers] = React.useState<SshServerListItem[]>([]);
  const [folders, setFolders] = React.useState<SshFolder[]>([]);
  const [localTerminalProfiles, setLocalTerminalProfiles] = React.useState<LocalTerminalProfile[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [activeFolderId, setActiveFolderId] = React.useState<string>('all');
  const [activeTag, setActiveTag] = React.useState<string>('all');
  const [search, setSearch] = React.useState<string>('');
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>('none');
  const [groupMode, setGroupMode] = React.useState<GroupMode>('lastUsed');
  const [sortMode, setSortMode] = React.useState<SortMode>('lastUsed');
  const [runtimeUserName, setRuntimeUserName] = React.useState<string>('user');
  const [isCreateFolderDialogOpen, setIsCreateFolderDialogOpen] = React.useState<boolean>(false);
  const [isEditFolderDialogOpen, setIsEditFolderDialogOpen] = React.useState<boolean>(false);
  const [isDeleteFolderDialogOpen, setIsDeleteFolderDialogOpen] = React.useState<boolean>(false);
  const [isDeleteServerDialogOpen, setIsDeleteServerDialogOpen] = React.useState<boolean>(false);
  const [folderNameInput, setFolderNameInput] = React.useState<string>('');
  const [activeFolderDraft, setActiveFolderDraft] = React.useState<{ id: string; name: string } | null>(null);
  const [activeServerDraft, setActiveServerDraft] = React.useState<{ id: string; name: string } | null>(null);
  const [isFolderActionSubmitting, setIsFolderActionSubmitting] = React.useState<boolean>(false);
  const [isServerDeleteSubmitting, setIsServerDeleteSubmitting] = React.useState<boolean>(false);
  const [draggingServerId, setDraggingServerId] = React.useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = React.useState<string | null>(null);
  const previousIsActiveRef = React.useRef<boolean>(isActive);

  const reloadHomeData = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const [foldersResponse, serversResponse, localTerminalProfilesResponse] = await Promise.all([
        listSshFolders(),
        listSshServers(),
        listLocalTerminalProfiles(),
      ]);
      setFolders(foldersResponse.data.items);
      setServers(serversResponse.data.items);
      setLocalTerminalProfiles(localTerminalProfilesResponse.data.items);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load home data.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadHomeData();
  }, [reloadHomeData]);

  React.useEffect(() => {
    const becameActive = !previousIsActiveRef.current && isActive;
    previousIsActiveRef.current = isActive;

    if (isActive && consumeOpenLocalTerminalListRequest()) {
      setActiveFolderId(LOCAL_TERMINAL_FOLDER_ID);
    }

    if (becameActive) {
      void reloadHomeData();
    }
  }, [isActive, reloadHomeData]);

  React.useEffect(() => {
    const loadUserName = async () => {
      const user = await window.electron?.getRuntimeUserName?.();
      if (typeof user === 'string' && user.trim().length > 0) {
        setRuntimeUserName(user.trim());
      }
    };

    void loadUserName();
  }, []);

  const greeting = React.useMemo(() => {
    const now = new Date();
    const period = resolveGreetingPeriod(now);
    const dateSeed = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const locale = getLocale();

    const variants: Record<typeof period, string[]> = {
      morning: ['home.greetingMorningPrimary', 'home.greetingMorningSecondary'],
      afternoon: ['home.greetingAfternoonPrimary', 'home.greetingAfternoonSecondary'],
      evening: ['home.greetingEveningPrimary', 'home.greetingEveningSecondary'],
    };

    const seed = hashString(`${dateSeed}:${runtimeUserName}:${period}:${locale}`);
    const variant = variants[period][seed % variants[period].length];
    return t(variant);
  }, [runtimeUserName]);

  const favoriteCount = React.useMemo(() => {
    return servers.filter((server) => (server.tags ?? []).some((tag) => tag.name.toLowerCase().includes('favorite')))
      .length;
  }, [servers]);

  const recentCount = React.useMemo(() => {
    return servers.filter((server) => Boolean(server.lastLoginAudit?.attemptedAt)).length;
  }, [servers]);

  const tagSourceServers = React.useMemo(() => {
    return servers.filter((server) => {
      if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
        return false;
      }

      if (activeFolderId !== 'all' && server.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent' && !server.lastLoginAudit?.attemptedAt) {
        return false;
      }

      if (quickFilter === 'favorite') {
        return (server.tags ?? []).some((tag) => tag.name.toLowerCase().includes('favorite'));
      }

      return true;
    });
  }, [servers, activeFolderId, quickFilter]);

  const tags = React.useMemo(() => {
    if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
      return ['all'];
    }

    const nameSet = new Set<string>();
    tagSourceServers.forEach((server) => {
      (server.tags ?? []).forEach((tag) => nameSet.add(tag.name));
    });

    return ['all', ...Array.from(nameSet)];
  }, [tagSourceServers, activeFolderId]);

  React.useEffect(() => {
    if (!tags.includes(activeTag)) {
      setActiveTag('all');
    }
  }, [tags, activeTag]);

  const filteredServers = React.useMemo(() => {
    return servers.filter((server) => {
      if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
        return false;
      }

      if (activeFolderId !== 'all' && server.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent' && !server.lastLoginAudit?.attemptedAt) {
        return false;
      }

      if (quickFilter === 'favorite') {
        const isFavorite = (server.tags ?? []).some((tag) => tag.name.toLowerCase().includes('favorite'));
        if (!isFavorite) {
          return false;
        }
      }

      if (activeTag !== 'all' && !(server.tags ?? []).some((tag) => tag.name === activeTag)) {
        return false;
      }

      if (!search.trim()) {
        return true;
      }

      const keyword = search.trim().toLowerCase();
      return (
        server.name.toLowerCase().includes(keyword) ||
        server.host.toLowerCase().includes(keyword) ||
        server.username.toLowerCase().includes(keyword)
      );
    });
  }, [servers, activeFolderId, quickFilter, activeTag, search]);

  const filteredLocalTerminalProfiles = React.useMemo(() => {
    if (activeFolderId !== LOCAL_TERMINAL_FOLDER_ID) {
      return [];
    }

    const keyword = search.trim().toLowerCase();
    const sortedProfiles = [...localTerminalProfiles].sort((left, right) => left.name.localeCompare(right.name));

    if (!keyword) {
      return sortedProfiles;
    }

    return sortedProfiles.filter((profile) => {
      return (
        profile.name.toLowerCase().includes(keyword) ||
        profile.command.toLowerCase().includes(keyword) ||
        profile.id.toLowerCase().includes(keyword)
      );
    });
  }, [activeFolderId, localTerminalProfiles, search]);

  const sortServers = React.useCallback(
    (items: SshServerListItem[]): SshServerListItem[] => {
      return [...items].sort((left, right) => {
        if (sortMode === 'nameAsc') {
          return left.name.localeCompare(right.name);
        }

        if (sortMode === 'nameDesc') {
          return right.name.localeCompare(left.name);
        }

        if (sortMode === 'createdAt') {
          const leftTime = new Date(left.createdAt).getTime();
          const rightTime = new Date(right.createdAt).getTime();
          return rightTime - leftTime;
        }

        const leftTime = new Date(left.lastLoginAudit?.attemptedAt ?? 0).getTime();
        const rightTime = new Date(right.lastLoginAudit?.attemptedAt ?? 0).getTime();
        return rightTime - leftTime;
      });
    },
    [sortMode],
  );

  const groupedServers = React.useMemo<ServerGroup[]>(() => {
    if (groupMode === 'none') {
      return [
        {
          key: 'ungrouped:all',
          title: '',
          items: sortServers(filteredServers),
        },
      ];
    }

    if (groupMode === 'tag') {
      const tagNameSet = new Set<string>();
      filteredServers.forEach((server) => {
        (server.tags ?? []).forEach((tag) => tagNameSet.add(tag.name));
      });

      const tagGroups = Array.from(tagNameSet)
        .sort((left, right) => left.localeCompare(right))
        .map((tagName) => {
          const items = filteredServers.filter((server) => (server.tags ?? []).some((tag) => tag.name === tagName));

          return {
            key: `tag:${tagName}`,
            title: tagName,
            items: sortServers(items),
          };
        })
        .filter((group) => group.items.length > 0);

      const untaggedItems = sortServers(filteredServers.filter((server) => (server.tags ?? []).length === 0));

      if (untaggedItems.length > 0) {
        tagGroups.push({
          key: 'tag:untagged',
          title: t('home.tagUntagged'),
          items: untaggedItems,
        });
      }

      return tagGroups;
    }

    const now = Date.now();
    const dayMilliseconds = 24 * 60 * 60 * 1000;
    const recentThreshold = dayMilliseconds;
    const weekThreshold = 7 * dayMilliseconds;

    const recentItems = sortServers(
      filteredServers.filter((server) => {
        const attemptedAt = server.lastLoginAudit?.attemptedAt;
        if (!attemptedAt) {
          return false;
        }

        const elapsed = now - new Date(attemptedAt).getTime();
        return elapsed <= recentThreshold;
      }),
    );

    const weekItems = sortServers(
      filteredServers.filter((server) => {
        const attemptedAt = server.lastLoginAudit?.attemptedAt;
        if (!attemptedAt) {
          return false;
        }

        const elapsed = now - new Date(attemptedAt).getTime();
        return elapsed > recentThreshold && elapsed <= weekThreshold;
      }),
    );

    const otherItems = sortServers(
      filteredServers.filter((server) => {
        const attemptedAt = server.lastLoginAudit?.attemptedAt;
        if (!attemptedAt) {
          return true;
        }

        const elapsed = now - new Date(attemptedAt).getTime();
        return elapsed > weekThreshold;
      }),
    );

    return [
      {
        key: 'last-used:recent',
        title: t('home.sectionRecent'),
        items: recentItems,
      },
      {
        key: 'last-used:last-week',
        title: t('home.sectionLastWeek'),
        items: weekItems,
      },
      {
        key: 'last-used:other',
        title: t('home.sectionOlder'),
        items: otherItems,
      },
    ].filter((group) => group.items.length > 0);
  }, [filteredServers, groupMode, sortServers]);

  const selectedGroupName = React.useMemo(() => {
    if (quickFilter === 'recent') {
      return t('home.groupRecentConnections');
    }

    if (quickFilter === 'favorite') {
      return t('home.groupFavorite');
    }

    if (activeFolderId === 'all') {
      return t('home.groupAllHosts');
    }

    if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
      return t('home.groupLocalTerminals');
    }

    return folders.find((folder) => folder.id === activeFolderId)?.name ?? t('home.groupUntitled');
  }, [quickFilter, activeFolderId, folders]);

  const folderServerCountMap = React.useMemo(() => {
    const countMap = new Map<string, number>();
    servers.forEach((server) => {
      const folderId = server.folder?.id;
      if (!folderId) {
        return;
      }

      countMap.set(folderId, (countMap.get(folderId) ?? 0) + 1);
    });

    return countMap;
  }, [servers]);

  const quickSidebarCards = React.useMemo<SidebarCardItem[]>(() => {
    return [
      {
        key: 'quick:recent',
        title: t('home.groupRecentConnections'),
        subtitle: t('home.hostCount', { count: recentCount }),
        selected: quickFilter === 'recent',
        iconKey: 'Cloud',
        iconClassName: 'bg-home-icon-blue text-home-icon-blue-ink',
        onClick: () => {
          setActiveFolderId('all');
          setQuickFilter('recent');
        },
      },
      {
        key: 'quick:favorite',
        title: t('home.groupFavorite'),
        subtitle: t('home.hostCount', { count: favoriteCount }),
        selected: quickFilter === 'favorite',
        iconKey: 'Database',
        iconClassName: 'bg-home-icon-amber text-home-icon-amber-ink',
        onClick: () => {
          setActiveFolderId('all');
          setQuickFilter('favorite');
        },
      },
    ];
  }, [quickFilter, recentCount, favoriteCount]);

  const folderSidebarCards = React.useMemo<SidebarCardItem[]>(() => {
    const userFolders = folders.map((folder) => {
      const visual = resolveHomeVisual('folder', folder.id, folder.id);
      const count = folderServerCountMap.get(folder.id) ?? 0;

      return {
        key: `folder:${folder.id}`,
        folderId: folder.id,
        title: folder.name,
        subtitle: t('home.hostCount', { count }),
        selected: activeFolderId === folder.id,
        iconKey: visual.iconKey,
        iconClassName: colorKeyToClassName(visual.colorKey),
        imageUrl: visual.imageUrl,
        onClick: () => {
          setActiveFolderId(folder.id);
          setQuickFilter('none');
        },
      };
    });

    return [
      {
        key: `folder:${LOCAL_TERMINAL_FOLDER_ID}`,
        folderId: LOCAL_TERMINAL_FOLDER_ID,
        title: t('home.groupLocalTerminals'),
        subtitle: t('home.hostCount', { count: localTerminalProfiles.length }),
        selected: activeFolderId === LOCAL_TERMINAL_FOLDER_ID,
        iconKey: 'HardDrive',
        iconClassName: 'bg-home-icon-blue text-home-icon-blue-ink',
        onClick: () => {
          setActiveFolderId(LOCAL_TERMINAL_FOLDER_ID);
          setQuickFilter('none');
        },
      },
      ...userFolders,
    ];
  }, [folders, folderServerCountMap, activeFolderId, localTerminalProfiles.length]);

  const selectedFolderCardIndex = React.useMemo(() => {
    return folderSidebarCards.findIndex((item) => item.selected);
  }, [folderSidebarCards]);

  const folderListNavigation = useDirectionalNavigation({
    itemCount: folderSidebarCards.length,
    columns: 1,
    initialIndex: selectedFolderCardIndex >= 0 ? selectedFolderCardIndex : 0,
  });

  const setFolderListActiveIndex = folderListNavigation.setActiveIndex;

  React.useEffect(() => {
    if (selectedFolderCardIndex >= 0) {
      setFolderListActiveIndex(selectedFolderCardIndex);
    }
  }, [selectedFolderCardIndex, setFolderListActiveIndex]);

  const serverGridEntries = React.useMemo(() => {
    return groupedServers.flatMap((group) => {
      return group.items.map((server) => ({
        key: `${group.key}:${server.id}`,
      }));
    });
  }, [groupedServers]);

  const serverGridIndexMap = React.useMemo(() => {
    const indexMap = new Map<string, number>();
    serverGridEntries.forEach((entry, index) => {
      indexMap.set(entry.key, index);
    });

    return indexMap;
  }, [serverGridEntries]);

  const serverGridNavigation = useDirectionalNavigation({
    itemCount: serverGridEntries.length,
    columns: 3,
    initialIndex: 0,
  });

  const groupModeIcon = React.useMemo(() => {
    if (groupMode === 'tag') {
      return Tags;
    }

    if (groupMode === 'none') {
      return Network;
    }

    return Clock3;
  }, [groupMode]);

  const sortModeIcon = React.useMemo(() => {
    if (sortMode === 'nameAsc') {
      return ArrowUpAZ;
    }

    if (sortMode === 'nameDesc') {
      return ArrowDownAZ;
    }

    if (sortMode === 'createdAt') {
      return CalendarPlus;
    }

    return ArrowUpDown;
  }, [sortMode]);

  const createIconNode = React.useCallback((iconKey: HomeIconKey, colorClassName: string, label: string) => {
    const Icon = iconMap[iconKey];
    return (
      <span
        aria-hidden
        className={classNames('inline-flex h-full w-full items-center justify-center rounded-md', colorClassName)}
      >
        <Icon className="h-4 w-4" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }, []);

  const localTerminalFileManagerLabel = React.useMemo(() => {
    const platform = window.electron?.platform;
    if (platform === 'win32') {
      return t('home.contextShowInFileExplorer');
    }

    if (platform === 'darwin') {
      return t('home.contextShowInFinder');
    }

    return t('home.contextShowInFileManager');
  }, []);

  const isMacPlatform = React.useMemo(() => window.electron?.platform === 'darwin', []);

  const openInNewTabShortcutLabel = React.useMemo(() => {
    const clickLabel = t('common.click');
    return isMacPlatform ? `⌘+${clickLabel}` : `Ctrl+${clickLabel}`;
  }, [isMacPlatform]);

  const openServerFromCard = React.useCallback(
    (server: SshServerListItem, event?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
      const isModifierPressed = isMacPlatform ? event?.metaKey : event?.ctrlKey;
      const shouldOpenInNewTab = event?.type === 'click' && Boolean(isModifierPressed);

      onOpenSSH(server.id, server.name, { openInNewTab: shouldOpenInNewTab });
    },
    [isMacPlatform, onOpenSSH],
  );

  const handleCopyToClipboard = React.useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        notifySuccess(t('home.copySuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : 'Failed to copy content to clipboard.');
      }
    },
    [notifyError, notifySuccess],
  );

  const handleShowInFileManager = React.useCallback(
    async (targetPath: string) => {
      try {
        const opened = await window.electron?.showInFileManager?.(targetPath);
        if (!opened) {
          notifyError(t('home.openInFileManagerFailed'));
        }
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.openInFileManagerFailed'));
      }
    },
    [notifyError],
  );

  const openCreateFolderDialog = React.useCallback(() => {
    setFolderNameInput('');
    setActiveFolderDraft(null);
    setIsCreateFolderDialogOpen(true);
  }, []);

  const openEditFolderDialog = React.useCallback((folderId: string, folderName: string) => {
    setActiveFolderDraft({ id: folderId, name: folderName });
    setFolderNameInput(folderName);
    setIsEditFolderDialogOpen(true);
  }, []);

  const openDeleteFolderDialog = React.useCallback((folderId: string, folderName: string) => {
    setActiveFolderDraft({ id: folderId, name: folderName });
    setIsDeleteFolderDialogOpen(true);
  }, []);

  const openDeleteServerDialog = React.useCallback((serverId: string, serverName: string) => {
    setActiveServerDraft({ id: serverId, name: serverName });
    setIsDeleteServerDialogOpen(true);
  }, []);

  const submitCreateFolder = React.useCallback(async () => {
    const folderName = normalizeFolderName(folderNameInput);
    if (!folderName) {
      notifyWarning(t('home.folderNameRequired'));
      return;
    }

    setIsFolderActionSubmitting(true);
    try {
      await createFolder(folderName);
      setIsCreateFolderDialogOpen(false);
      setFolderNameInput('');
      await reloadHomeData();
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.folderCreateFailed'));
    } finally {
      setIsFolderActionSubmitting(false);
    }
  }, [folderNameInput, notifyError, notifyWarning, reloadHomeData]);

  const submitEditFolder = React.useCallback(async () => {
    if (!activeFolderDraft) {
      return;
    }

    const folderName = normalizeFolderName(folderNameInput);
    if (!folderName) {
      notifyWarning(t('home.folderNameRequired'));
      return;
    }

    setIsFolderActionSubmitting(true);
    try {
      await renameFolder(activeFolderDraft.id, folderName);
      setIsEditFolderDialogOpen(false);
      setFolderNameInput('');
      setActiveFolderDraft(null);
      await reloadHomeData();
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.folderUpdateFailed'));
    } finally {
      setIsFolderActionSubmitting(false);
    }
  }, [activeFolderDraft, folderNameInput, notifyError, notifyWarning, reloadHomeData]);

  const submitDeleteFolder = React.useCallback(async () => {
    if (!activeFolderDraft) {
      return;
    }

    setIsFolderActionSubmitting(true);
    try {
      await removeFolder(activeFolderDraft.id);

      if (activeFolderId === activeFolderDraft.id) {
        setActiveFolderId('all');
        setQuickFilter('none');
      }

      setIsDeleteFolderDialogOpen(false);
      setActiveFolderDraft(null);
      await reloadHomeData();
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.folderDeleteFailed'));
    } finally {
      setIsFolderActionSubmitting(false);
    }
  }, [activeFolderDraft, activeFolderId, notifyError, reloadHomeData]);

  const submitDeleteServer = React.useCallback(async () => {
    if (!activeServerDraft) {
      return;
    }

    setIsServerDeleteSubmitting(true);
    try {
      const deleted = await deleteSshServer(activeServerDraft.id);
      if (!deleted.success) {
        throw new Error(t('home.serverDeleteFailed'));
      }

      setIsDeleteServerDialogOpen(false);
      setActiveServerDraft(null);
      await reloadHomeData();
      notifySuccess(t('home.serverDeleteSuccess'));
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.serverDeleteFailed'));
    } finally {
      setIsServerDeleteSubmitting(false);
    }
  }, [activeServerDraft, notifyError, notifySuccess, reloadHomeData]);

  const handleAssignServerToFolder = React.useCallback(
    async (serverId: string, folderId: string) => {
      const targetServer = servers.find((server) => server.id === serverId);
      if (!targetServer) {
        return;
      }

      if (targetServer.folder?.id === folderId) {
        return;
      }

      try {
        await updateSshServer(serverId, {
          name: targetServer.name,
          host: targetServer.host,
          port: targetServer.port,
          username: targetServer.username,
          authType: targetServer.authType,
          note: targetServer.note ?? undefined,
          folderId,
        });

        await reloadHomeData();
        setActiveFolderId(folderId);
        setQuickFilter('none');
        notifySuccess(t('home.dragServerToFolderSuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.dragServerToFolderFailed'));
      }
    },
    [notifyError, notifySuccess, reloadHomeData, servers],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-2">
      <h1 className="px-2 pb-2 text-[28px] font-semibold text-header-text">
        {t('home.greetingWithUser', { greeting, name: runtimeUserName })}
      </h1>

      <div className="flex min-h-0 flex-1 gap-3.5">
        <aside className="flex h-full w-[250px] shrink-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <div className="pb-5">
              <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">{t('home.groupAll')}</div>
              <EntityCard
                title={t('home.groupAllHosts')}
                subtitle={t('home.hostCount', { count: servers.length })}
                selected={activeFolderId === 'all' && quickFilter === 'none'}
                icon={createIconNode('Folder', 'bg-home-icon-bg text-header-text', t('home.groupAllHosts'))}
                onClick={() => {
                  setActiveFolderId('all');
                  setQuickFilter('none');
                }}
              />
            </div>

            <div className="pb-5">
              <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">
                {t('home.groupFavoriteAndRecent')}
              </div>
              <div className="space-y-1.5">
                {quickSidebarCards.map((item) => (
                  <EntityCard
                    key={item.key}
                    title={item.title}
                    subtitle={item.subtitle}
                    selected={item.selected}
                    icon={createIconNode(item.iconKey, item.iconClassName, item.title)}
                    onClick={item.onClick}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">{t('home.groupFolders')}</div>
              <div className="space-y-1.5">
                {folderSidebarCards.map((item, index) => (
                  <ContextMenu key={item.key}>
                    <ContextMenuTrigger className="block">
                      <EntityCard
                        {...folderListNavigation.getItemProps(index)}
                        title={item.title}
                        subtitle={item.subtitle}
                        selected={item.selected}
                        className={dragOverFolderId === item.folderId ? 'bg-home-card-active' : undefined}
                        icon={createIconNode(item.iconKey, item.iconClassName, item.title)}
                        imageUrl={item.imageUrl}
                        onDragOver={(event) => {
                          if (!item.folderId || item.folderId === LOCAL_TERMINAL_FOLDER_ID || !draggingServerId) {
                            return;
                          }

                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          if (dragOverFolderId !== item.folderId) {
                            setDragOverFolderId(item.folderId);
                          }
                        }}
                        onDragLeave={() => {
                          if (dragOverFolderId === item.folderId) {
                            setDragOverFolderId(null);
                          }
                        }}
                        onDrop={(event) => {
                          if (!item.folderId || item.folderId === LOCAL_TERMINAL_FOLDER_ID) {
                            return;
                          }

                          event.preventDefault();
                          const droppedServerId =
                            event.dataTransfer.getData('application/x-cosmosh-server-id') || draggingServerId;
                          if (!droppedServerId) {
                            return;
                          }

                          setDragOverFolderId(null);
                          setDraggingServerId(null);
                          void handleAssignServerToFolder(droppedServerId, item.folderId);
                        }}
                        onClick={item.onClick}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        icon={FolderOpen}
                        onSelect={item.onClick}
                      >
                        {t('home.contextOpenFolder')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={Pencil}
                        disabled={item.folderId === LOCAL_TERMINAL_FOLDER_ID}
                        onSelect={() => {
                          const folderId = item.folderId;
                          if (!folderId || folderId === LOCAL_TERMINAL_FOLDER_ID) {
                            return;
                          }

                          openEditFolderDialog(folderId, item.title);
                        }}
                      >
                        {t('home.contextEditFolder')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={Trash2}
                        disabled={item.folderId === LOCAL_TERMINAL_FOLDER_ID}
                        onSelect={() => {
                          const folderId = item.folderId;
                          if (!folderId || folderId === LOCAL_TERMINAL_FOLDER_ID) {
                            return;
                          }

                          openDeleteFolderDialog(folderId, item.title);
                        }}
                      >
                        {t('home.contextDeleteFolder')}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <div className="w-px shrink-0 bg-home-divider" />

        <main className="min-w-0 flex-1 overflow-auto pl-2">
          <div className="pb-4">
            <div className="flex items-center justify-between gap-4 pb-2 ps-2">
              <div className="min-w-0 pb-2 text-[20px] font-semibold leading-[1.02] tracking-[-0.01em] text-header-text">
                {selectedGroupName}
              </div>

              <div className="flex items-center">
                <TooltipProvider delayDuration={180}>
                  <Menubar className="mr-1">
                    <div className="w-50 relative">
                      <Input
                        value={search}
                        placeholder={t('home.searchPlaceholder')}
                        className="pr-9"
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
                    </div>
                  </Menubar>
                  <Menubar className="mr-1">
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('home.groupModeAction')}
                              className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                            >
                              {React.createElement(groupModeIcon, { className: 'h-4 w-4' })}
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{t('home.groupModeAction')}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent>
                        <DropdownMenuLabel>{t('home.groupModeAction')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem
                          checked={groupMode === 'none'}
                          onSelect={() => setGroupMode('none')}
                        >
                          {t('home.groupModeNone')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={groupMode === 'lastUsed'}
                          onSelect={() => setGroupMode('lastUsed')}
                        >
                          {t('home.groupModeLastUsed')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={groupMode === 'tag'}
                          onSelect={() => setGroupMode('tag')}
                        >
                          {t('home.groupModeTag')}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('home.sortAction')}
                              className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                            >
                              {React.createElement(sortModeIcon, { className: 'h-4 w-4' })}
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{t('home.sortAction')}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent>
                        <DropdownMenuLabel>{t('home.sortAction')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem
                          checked={sortMode === 'nameAsc'}
                          onSelect={() => setSortMode('nameAsc')}
                        >
                          {t('home.sortByNameAsc')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={sortMode === 'nameDesc'}
                          onSelect={() => setSortMode('nameDesc')}
                        >
                          {t('home.sortByNameDesc')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={sortMode === 'lastUsed'}
                          onSelect={() => setSortMode('lastUsed')}
                        >
                          {t('home.sortByLastUsed')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={sortMode === 'createdAt'}
                          onSelect={() => setSortMode('createdAt')}
                        >
                          {t('home.sortByCreatedAt')}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <MenubarSeparator vertical />

                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={t('home.addAction')}
                              className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{t('home.addAction')}</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          icon={Server}
                          onSelect={() => onOpenSshEditor('')}
                        >
                          {t('home.quickAddServer')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          icon={FolderPlus}
                          onSelect={openCreateFolderDialog}
                        >
                          {t('home.quickAddFolder')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Menubar>
                </TooltipProvider>
              </div>
            </div>

            <MenuToggleGroup
              type="single"
              value={activeTag}
              className="-ms-1"
              onValueChange={(value) => {
                if (value) {
                  setActiveTag(value);
                }
              }}
            >
              {tags.map((tagName) => (
                <MenuToggleGroupItem
                  key={tagName}
                  value={tagName}
                >
                  {tagName === 'all' ? t('home.tagAll') : tagName}
                </MenuToggleGroupItem>
              ))}
            </MenuToggleGroup>
          </div>

          {isLoading ? <div className="text-home-text-subtle">{t('home.loading')}</div> : null}
          {errorMessage ? <div className="text-form-message-error">{errorMessage}</div> : null}

          {!isLoading && !errorMessage ? (
            <div className="space-y-4 pb-2">
              {activeFolderId === LOCAL_TERMINAL_FOLDER_ID ? (
                <section>
                  <div className="grid max-w-[880px] grid-cols-3 gap-x-7 gap-y-3">
                    {filteredLocalTerminalProfiles.map((profile, index) => (
                      <ContextMenu key={profile.id}>
                        <ContextMenuTrigger className="block">
                          <EntityCard
                            {...serverGridNavigation.getItemProps(index)}
                            layout="grid"
                            title={profile.name}
                            subtitle={profile.command}
                            icon={createIconNode(
                              'HardDrive',
                              'bg-home-icon-blue text-home-icon-blue-ink',
                              profile.name,
                            )}
                            onClick={() => onOpenSSH(toLocalTerminalTargetId(profile.id), profile.name)}
                          />
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            icon={Terminal}
                            onSelect={() => onOpenSSH(toLocalTerminalTargetId(profile.id), profile.name)}
                          >
                            {t('home.contextConnect')}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            icon={FolderOpen}
                            onSelect={() => {
                              void handleShowInFileManager(profile.executablePath);
                            }}
                          >
                            {localTerminalFileManagerLabel}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            disabled
                            className="text-xs text-home-text-subtle"
                          >
                            {t('home.contextLocalTerminalManagedHint')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </div>
                </section>
              ) : (
                groupedServers.map((group) => (
                  <section key={group.key}>
                    {group.title ? (
                      <div className="px-2 pb-2.5 text-[13px] font-medium text-home-text-subtle">{group.title}</div>
                    ) : null}
                    <div className="grid max-w-[880px] grid-cols-3 gap-x-7 gap-y-3">
                      {group.items.map((server) => {
                        const serverEntryKey = `${group.key}:${server.id}`;
                        const serverEntryIndex = serverGridIndexMap.get(serverEntryKey) ?? 0;
                        const visual = resolveHomeVisual('server', server.id, server.folder?.id ?? server.id);
                        return (
                          <ContextMenu key={serverEntryKey}>
                            <ContextMenuTrigger className="block">
                              <EntityCard
                                {...serverGridNavigation.getItemProps(serverEntryIndex)}
                                draggable
                                layout="grid"
                                title={server.name}
                                subtitle={server.host}
                                className={draggingServerId === server.id ? 'opacity-70' : undefined}
                                icon={createIconNode(visual.iconKey, colorKeyToClassName(visual.colorKey), server.name)}
                                imageUrl={visual.imageUrl}
                                action={
                                  <Button
                                    variant="ghost"
                                    tabIndex={serverEntryIndex === serverGridNavigation.activeIndex ? 0 : -1}
                                    className="h-[32px] w-[32px] rounded-[8px] px-0 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                                    aria-label={t('home.contextConnectSftp')}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                    }}
                                  >
                                    <File className="h-4 w-4 flex-shrink-0" />
                                  </Button>
                                }
                                onDragStart={(event) => {
                                  event.dataTransfer.setData('application/x-cosmosh-server-id', server.id);
                                  event.dataTransfer.effectAllowed = 'move';
                                  setDraggingServerId(server.id);
                                }}
                                onDragEnd={() => {
                                  setDraggingServerId(null);
                                  setDragOverFolderId(null);
                                }}
                                onClick={(event) => openServerFromCard(server, event)}
                              />
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem
                                icon={Terminal}
                                onSelect={() => onOpenSSH(server.id, server.name)}
                              >
                                {t('home.contextConnect')}
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() => onOpenSSH(server.id, server.name, { openInNewTab: true })}
                              >
                                {t('home.openSshNewTab')}
                                <ContextMenuShortcut>{openInNewTabShortcutLabel}</ContextMenuShortcut>
                              </ContextMenuItem>
                              {/* TODO(home): SFTP connect entry is pending dedicated SFTP page/session wiring. */}
                              <ContextMenuItem
                                disabled
                                icon={File}
                              >
                                {t('home.contextConnectSftp')}
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuSub>
                                <ContextMenuSubTrigger icon={Copy}>{t('home.contextCopy')}</ContextMenuSubTrigger>
                                <ContextMenuSubContent>
                                  <ContextMenuItem
                                    icon={Network}
                                    onSelect={() => {
                                      void handleCopyToClipboard(server.host);
                                    }}
                                  >
                                    {t('home.contextCopyIp')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    icon={Server}
                                    onSelect={() => {
                                      void handleCopyToClipboard(server.name);
                                    }}
                                  >
                                    {t('home.contextCopyName')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    icon={Hash}
                                    onSelect={() => {
                                      void handleCopyToClipboard(String(server.port));
                                    }}
                                  >
                                    {t('home.contextCopyPort')}
                                  </ContextMenuItem>
                                  <ContextMenuItem
                                    icon={Link}
                                    onSelect={() => {
                                      void handleCopyToClipboard(
                                        `ssh://${server.username}@${server.host}:${server.port}`,
                                      );
                                    }}
                                  >
                                    {t('home.contextCopySchema')}
                                  </ContextMenuItem>
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                icon={Pencil}
                                onSelect={() => onOpenSshEditor(server.id)}
                              >
                                {t('home.contextEdit')}
                              </ContextMenuItem>
                              <ContextMenuItem
                                icon={Trash2}
                                onSelect={() => openDeleteServerDialog(server.id, server.name)}
                              >
                                {t('home.contextDelete')}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
          ) : null}

          {!isLoading &&
          !errorMessage &&
          activeFolderId !== LOCAL_TERMINAL_FOLDER_ID &&
          filteredServers.length === 0 ? (
            <HomeEmptyState
              text={t('home.empty')}
              icon={PackageOpen}
            />
          ) : null}

          {!isLoading &&
          !errorMessage &&
          activeFolderId === LOCAL_TERMINAL_FOLDER_ID &&
          filteredLocalTerminalProfiles.length === 0 ? (
            <HomeEmptyState
              text={t('home.empty')}
              icon={PackageOpen}
            />
          ) : null}
        </main>
      </div>

      <Dialog
        open={isCreateFolderDialogOpen}
        onOpenChange={setIsCreateFolderDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('home.quickAddFolder')}</DialogTitle>
            <DialogDescription>{t('home.dialogCreateFolderDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={folderNameInput}
            placeholder={t('home.folderNamePlaceholder')}
            onChange={(event) => setFolderNameInput(event.target.value)}
          />
          <DialogFooter>
            <DialogSecondaryButton onClick={() => setIsCreateFolderDialogOpen(false)}>
              {t('home.actionCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={isFolderActionSubmitting}
              onClick={() => {
                void submitCreateFolder();
              }}
            >
              {t('home.actionCreate')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isEditFolderDialogOpen}
        onOpenChange={setIsEditFolderDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('home.contextEditFolder')}</DialogTitle>
            <DialogDescription>{t('home.dialogEditFolderDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={folderNameInput}
            placeholder={t('home.folderNamePlaceholder')}
            onChange={(event) => setFolderNameInput(event.target.value)}
          />
          <DialogFooter>
            <DialogSecondaryButton onClick={() => setIsEditFolderDialogOpen(false)}>
              {t('home.actionCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={isFolderActionSubmitting}
              onClick={() => {
                void submitEditFolder();
              }}
            >
              {t('home.actionSave')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isDeleteFolderDialogOpen}
        onOpenChange={setIsDeleteFolderDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('home.contextDeleteFolder')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('home.dialogDeleteFolderDescription', { name: activeFolderDraft?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancelButton disabled={isFolderActionSubmitting}>
              {t('home.actionCancel')}
            </AlertDialogCancelButton>
            <AlertDialogActionButton
              disabled={isFolderActionSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void submitDeleteFolder();
              }}
            >
              {t('home.contextDelete')}
            </AlertDialogActionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isDeleteServerDialogOpen}
        onOpenChange={setIsDeleteServerDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('home.dialogDeleteServerTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('home.dialogDeleteServerDescription', { name: activeServerDraft?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancelButton disabled={isServerDeleteSubmitting}>
              {t('home.actionCancel')}
            </AlertDialogCancelButton>
            <AlertDialogActionButton
              disabled={isServerDeleteSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void submitDeleteServer();
              }}
            >
              {t('home.contextDelete')}
            </AlertDialogActionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Home;
