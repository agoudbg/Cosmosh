import type { components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  CalendarPlus,
  Clock3,
  Cloud,
  Database,
  File,
  Folder,
  Folders,
  HardDrive,
  Network,
  Package2,
  PackageOpen,
  Plus,
  Search,
  Server,
  Tags,
} from 'lucide-react';
import React from 'react';

import EntityCard from '../components/home/EntityCard';
import HomeEmptyState from '../components/home/HomeEmptyState';
import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
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
import { listSshFolders, listSshServers } from '../lib/backend';
import { colorKeyToClassName, type HomeIconKey, resolveHomeVisual } from '../lib/home-visuals';
import { getLocale, t } from '../lib/i18n';

type HomeProps = {
  onOpenSSH: (serverId: string) => void;
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
  title: string;
  subtitle: string;
  selected: boolean;
  iconKey: HomeIconKey;
  iconClassName: string;
  imageUrl?: string;
  onClick: () => void;
};

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

const Home: React.FC<HomeProps> = ({ onOpenSSH }) => {
  const [servers, setServers] = React.useState<SshServerListItem[]>([]);
  const [folders, setFolders] = React.useState<SshFolder[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [activeFolderId, setActiveFolderId] = React.useState<string>('all');
  const [activeTag, setActiveTag] = React.useState<string>('all');
  const [search, setSearch] = React.useState<string>('');
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>('none');
  const [groupMode, setGroupMode] = React.useState<GroupMode>('lastUsed');
  const [sortMode, setSortMode] = React.useState<SortMode>('lastUsed');
  const [runtimeUserName, setRuntimeUserName] = React.useState<string>('user');

  React.useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setErrorMessage('');

      try {
        const [foldersResponse, serversResponse] = await Promise.all([listSshFolders(), listSshServers()]);
        setFolders(foldersResponse.data.items);
        setServers(serversResponse.data.items);
      } catch (error: unknown) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load home data.');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

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
    const nameSet = new Set<string>();
    tagSourceServers.forEach((server) => {
      (server.tags ?? []).forEach((tag) => nameSet.add(tag.name));
    });

    return ['all', ...Array.from(nameSet)];
  }, [tagSourceServers]);

  React.useEffect(() => {
    if (!tags.includes(activeTag)) {
      setActiveTag('all');
    }
  }, [tags, activeTag]);

  const filteredServers = React.useMemo(() => {
    return servers.filter((server) => {
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
    return folders.map((folder) => {
      const visual = resolveHomeVisual('folder', folder.id, folder.id);
      const count = folderServerCountMap.get(folder.id) ?? 0;

      return {
        key: `folder:${folder.id}`,
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
  }, [folders, folderServerCountMap, activeFolderId]);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-2">
      <h1 className="px-2 pb-2 text-[28px] font-semibold text-header-text">
        {t('home.greetingWithUser', { greeting, name: runtimeUserName })}
      </h1>

      <div className="flex min-h-0 flex-1 gap-3.5">
        <aside className="flex h-full w-[250px] shrink-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto pb-2 pr-1">
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
                {folderSidebarCards.map((item) => (
                  <ContextMenu key={item.key}>
                    <ContextMenuTrigger className="block">
                      <EntityCard
                        title={item.title}
                        subtitle={item.subtitle}
                        selected={item.selected}
                        icon={createIconNode(item.iconKey, item.iconClassName, item.title)}
                        imageUrl={item.imageUrl}
                        onClick={item.onClick}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem>{t('home.contextOpenFolder')}</ContextMenuItem>
                      <ContextMenuItem>{t('home.contextEditFolder')}</ContextMenuItem>
                      <ContextMenuItem>{t('home.contextDeleteFolder')}</ContextMenuItem>
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
                        <DropdownMenuItem>{t('home.quickAddServer')}</DropdownMenuItem>
                        <DropdownMenuItem>{t('home.quickAddFolder')}</DropdownMenuItem>
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
              {groupedServers.map((group) => (
                <section key={group.key}>
                  {group.title ? (
                    <div className="px-2 pb-2.5 text-[13px] font-medium text-home-text-subtle">{group.title}</div>
                  ) : null}
                  <div className="grid max-w-[880px] grid-cols-3 gap-x-7 gap-y-3">
                    {group.items.map((server) => {
                      const visual = resolveHomeVisual('server', server.id, server.folder?.id ?? server.id);
                      return (
                        <ContextMenu key={`${group.key}:${server.id}`}>
                          <ContextMenuTrigger className="block">
                            <EntityCard
                              layout="grid"
                              title={server.name}
                              subtitle={server.host}
                              icon={createIconNode(visual.iconKey, colorKeyToClassName(visual.colorKey), server.name)}
                              imageUrl={visual.imageUrl}
                              action={
                                <Button
                                  variant="ghost"
                                  className="h-[32px] w-[32px] rounded-[8px] px-0 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                                  aria-label={t('home.contextConnectSftp')}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                >
                                  <File className="h-4 w-4 flex-shrink-0" />
                                </Button>
                              }
                              onClick={() => onOpenSSH(server.id)}
                            />
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem>{t('home.contextConnect')}</ContextMenuItem>
                            <ContextMenuItem>{t('home.contextConnectSftp')}</ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuSub>
                              <ContextMenuSubTrigger>{t('home.contextCopy')}</ContextMenuSubTrigger>
                              <ContextMenuSubContent>
                                <ContextMenuItem>{t('home.contextCopyIp')}</ContextMenuItem>
                                <ContextMenuItem>{t('home.contextCopyName')}</ContextMenuItem>
                                <ContextMenuItem>{t('home.contextCopyPort')}</ContextMenuItem>
                                <ContextMenuItem>{t('home.contextCopySchema')}</ContextMenuItem>
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                            <ContextMenuSeparator />
                            <ContextMenuItem>{t('home.contextEdit')}</ContextMenuItem>
                            <ContextMenuItem>{t('home.contextDelete')}</ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {!isLoading && !errorMessage && filteredServers.length === 0 ? (
            <HomeEmptyState
              text={t('home.empty')}
              icon={PackageOpen}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
};

export default Home;
