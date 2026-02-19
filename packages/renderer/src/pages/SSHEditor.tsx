import type { components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import { ArrowDownAZ, ArrowUpAZ, ArrowUpDown, CalendarPlus, Folder, Plus, Search, Server } from 'lucide-react';
import React from 'react';

import EntityCard from '../components/home/EntityCard';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Form, FormControl, FormField, FormLabel, FormMessage } from '../components/ui/form';
import { formStyles } from '../components/ui/form-styles';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { menuStyles } from '../components/ui/menu-styles';
import { Menubar, MenubarSeparator } from '../components/ui/menubar';
import { PasswordField } from '../components/ui/password-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import {
  createSshFolder,
  createSshServer,
  getSshServerCredentials,
  listSshFolders,
  listSshServers,
  updateSshServer,
} from '../lib/backend';
import { colorKeyToClassName, resolveHomeVisual } from '../lib/home-visuals';
import { t } from '../lib/i18n';
import { consumeSshEditorCreateMode, getActiveSshServerId } from '../lib/ssh-target';

type SshServerListItem = components['schemas']['SshServerListItem'];
type SshFolder = components['schemas']['SshFolder'];
type SshAuthType = components['schemas']['SshAuthType'];

type SortMode = 'default' | 'nameAsc' | 'nameDesc' | 'lastUsed' | 'createdAt';

type ServerEditorFormState = {
  name: string;
  note: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  folderId: string;
  strictHostKey: boolean;
  connectionTimeout: number[];
};

type ServerCredentialCache = {
  authType: SshAuthType;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
};

const NO_FOLDER_SELECT_VALUE = '__none__';

const createInitialFormState = (): ServerEditorFormState => {
  return {
    name: '',
    note: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    folderId: '',
    strictHostKey: true,
    connectionTimeout: [45],
  };
};

const parsePort = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
};

const getServerSortTimestamp = (server: SshServerListItem, mode: 'lastUsed' | 'createdAt'): number => {
  if (mode === 'createdAt') {
    return new Date(server.createdAt).getTime();
  }

  return new Date(server.lastLoginAudit?.attemptedAt ?? server.createdAt).getTime();
};

const mapServerToFormState = (server: SshServerListItem): ServerEditorFormState => {
  return {
    name: server.name,
    note: server.note ?? '',
    host: server.host,
    port: String(server.port),
    username: server.username,
    authType: server.authType,
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    folderId: server.folder?.id ?? '',
    strictHostKey: true,
    connectionTimeout: [45],
  };
};

const createIconNode = (colorClassName: string, label: string): React.ReactNode => {
  return (
    <span
      aria-hidden
      className={classNames('inline-flex h-full w-full items-center justify-center rounded-md', colorClassName)}
    >
      <Server className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </span>
  );
};

const SSHEditor: React.FC = () => {
  const [servers, setServers] = React.useState<SshServerListItem[]>([]);
  const [folders, setFolders] = React.useState<SshFolder[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
  const [search, setSearch] = React.useState<string>('');
  const [sortMode, setSortMode] = React.useState<SortMode>('default');
  const [activeServerId, setActiveServerId] = React.useState<string | null>(null);
  const [formState, setFormState] = React.useState<ServerEditorFormState>(createInitialFormState());
  const activeServerIdRef = React.useRef<string | null>(null);
  const credentialsCacheRef = React.useRef<Record<string, ServerCredentialCache>>({});

  const requiresPassword = formState.authType === 'password' || formState.authType === 'both';
  const requiresPrivateKey = formState.authType === 'key' || formState.authType === 'both';

  const activeServer = React.useMemo(() => {
    if (!activeServerId) {
      return null;
    }

    return servers.find((server) => server.id === activeServerId) ?? null;
  }, [activeServerId, servers]);

  React.useEffect(() => {
    activeServerIdRef.current = activeServerId;
  }, [activeServerId]);

  const reloadData = React.useCallback(async () => {
    setIsLoading(true);

    try {
      const [foldersResponse, serversResponse] = await Promise.all([listSshFolders(), listSshServers()]);
      const nextFolders = foldersResponse.data.items;
      const nextServers = serversResponse.data.items;

      setFolders(nextFolders);
      setServers(nextServers);

      if (consumeSshEditorCreateMode()) {
        setActiveServerId(null);
        setFormState(createInitialFormState());
        return;
      }

      if (nextServers.length === 0) {
        setActiveServerId(null);
        setFormState(createInitialFormState());
        return;
      }

      const preferredServerId = getActiveSshServerId();
      const currentActiveServerId = activeServerIdRef.current;
      const currentId =
        currentActiveServerId && nextServers.some((server) => server.id === currentActiveServerId)
          ? currentActiveServerId
          : preferredServerId && nextServers.some((server) => server.id === preferredServerId)
            ? preferredServerId
            : nextServers[0].id;
      const targetServer = nextServers.find((server) => server.id === currentId) ?? nextServers[0];
      const cachedCredentials = credentialsCacheRef.current[targetServer.id];

      setActiveServerId(targetServer.id);
      setFormState({
        ...mapServerToFormState(targetServer),
        ...(cachedCredentials ?? {}),
      });
    } catch (error: unknown) {
      window.alert(error instanceof Error ? error.message : 'Failed to load server editor resources.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadData();
  }, [reloadData]);

  React.useEffect(() => {
    if (!activeServerId) {
      return;
    }

    let cancelled = false;

    const loadCredentials = async () => {
      try {
        const response = await getSshServerCredentials(activeServerId);
        if (cancelled) {
          return;
        }

        const nextCredentials: ServerCredentialCache = {
          authType: response.data.authType,
          password: response.data.password ?? '',
          privateKey: response.data.privateKey ?? '',
          privateKeyPassphrase: response.data.privateKeyPassphrase ?? '',
        };

        credentialsCacheRef.current[activeServerId] = nextCredentials;
        setFormState((previous) => ({
          ...previous,
          ...nextCredentials,
        }));
      } catch {
        if (!cancelled) {
          window.alert('Failed to load saved credentials.');
        }
      }
    };

    void loadCredentials();

    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  const sortServers = React.useCallback((items: SshServerListItem[], mode: SortMode): SshServerListItem[] => {
    return [...items].sort((left, right) => {
      if (mode === 'nameAsc') {
        return left.name.localeCompare(right.name);
      }

      if (mode === 'nameDesc') {
        return right.name.localeCompare(left.name);
      }

      if (mode === 'lastUsed' || mode === 'createdAt') {
        return getServerSortTimestamp(right, mode) - getServerSortTimestamp(left, mode);
      }

      return 0;
    });
  }, []);

  const searchedServers = React.useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return keyword
      ? servers.filter((server) => {
          return (
            server.name.toLowerCase().includes(keyword) ||
            server.host.toLowerCase().includes(keyword) ||
            server.username.toLowerCase().includes(keyword)
          );
        })
      : servers;
  }, [search, servers]);

  const displayGroups = React.useMemo(() => {
    if (sortMode === 'nameAsc' || sortMode === 'nameDesc') {
      return [
        {
          key: `flat:${sortMode}`,
          title: '',
          items: sortServers(searchedServers, sortMode),
        },
      ];
    }

    if (sortMode === 'lastUsed' || sortMode === 'createdAt') {
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const oneWeekMs = 7 * oneDayMs;
      const oneMonthMs = 30 * oneDayMs;
      const recentServers = sortServers(searchedServers, sortMode);
      const dayItems: SshServerListItem[] = [];
      const weekItems: SshServerListItem[] = [];
      const monthItems: SshServerListItem[] = [];
      const olderItems: SshServerListItem[] = [];

      recentServers.forEach((server) => {
        const age = now - getServerSortTimestamp(server, sortMode);
        if (age <= oneDayMs) {
          dayItems.push(server);
          return;
        }

        if (age <= oneWeekMs) {
          weekItems.push(server);
          return;
        }

        if (age <= oneMonthMs) {
          monthItems.push(server);
          return;
        }

        olderItems.push(server);
      });

      return [
        { key: 'time:day', title: '1日内', items: dayItems },
        { key: 'time:week', title: '1周内', items: weekItems },
        { key: 'time:month', title: '1月内', items: monthItems },
        { key: 'time:older', title: '更早', items: olderItems },
      ].filter((group) => group.items.length > 0);
    }

    const groups = folders
      .map((folder) => {
        const items = searchedServers.filter((server) => server.folder?.id === folder.id);
        return {
          key: `folder:${folder.id}`,
          title: folder.name,
          items,
        };
      })
      .filter((group) => group.items.length > 0);

    const uncategorized = searchedServers.filter((server) => !server.folder?.id);

    if (uncategorized.length > 0) {
      groups.push({
        key: 'folder:uncategorized',
        title: '无文件夹',
        items: uncategorized,
      });
    }

    return groups;
  }, [folders, searchedServers, sortMode, sortServers]);

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

  const onPickServer = React.useCallback(
    (serverId: string) => {
      const targetServer = servers.find((server) => server.id === serverId);
      if (!targetServer) {
        return;
      }

      setActiveServerId(serverId);
      setFormState({
        ...mapServerToFormState(targetServer),
        ...(credentialsCacheRef.current[serverId] ?? {}),
      });
    },
    [servers],
  );

  const onChangeForm = React.useCallback(
    <K extends keyof ServerEditorFormState>(key: K, value: ServerEditorFormState[K]) => {
      setFormState((previous) => ({
        ...previous,
        [key]: value,
      }));
    },
    [],
  );

  const onAddServer = React.useCallback(() => {
    setActiveServerId(null);
    setFormState(createInitialFormState());
  }, []);

  const onCreateFolder = React.useCallback(async () => {
    const folderName = window.prompt('Folder name');

    if (!folderName || !folderName.trim()) {
      return;
    }

    try {
      await createSshFolder({ name: folderName.trim() });
      window.alert('Folder created successfully.');
      await reloadData();
    } catch (error: unknown) {
      window.alert(error instanceof Error ? error.message : 'Failed to create folder.');
    }
  }, [reloadData]);

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const port = parsePort(formState.port);
      if (!formState.name.trim() || !formState.host.trim() || !formState.username.trim()) {
        window.alert('Name, host and username are required.');
        return;
      }

      if (port === null) {
        window.alert('Port must be an integer between 1 and 65535.');
        return;
      }

      setIsSubmitting(true);
      try {
        if (activeServerId) {
          const targetServer = servers.find((server) => server.id === activeServerId);
          if (!targetServer) {
            window.alert('Selected server was not found.');
            return;
          }

          if (requiresPassword && !formState.password.trim() && !targetServer.hasPassword) {
            window.alert('Password is required for selected authentication type.');
            return;
          }

          if (requiresPrivateKey && !formState.privateKey.trim() && !targetServer.hasPrivateKey) {
            window.alert('Private key is required for selected authentication type.');
            return;
          }

          await updateSshServer(activeServerId, {
            name: formState.name.trim(),
            host: formState.host.trim(),
            port,
            username: formState.username.trim(),
            authType: formState.authType,
            password: formState.password.trim() || undefined,
            privateKey: formState.privateKey.trim() || undefined,
            privateKeyPassphrase: formState.privateKeyPassphrase.trim() || undefined,
            folderId: formState.folderId || undefined,
            note: formState.note.trim() || undefined,
          });
        } else {
          await createSshServer({
            name: formState.name.trim(),
            host: formState.host.trim(),
            port,
            username: formState.username.trim(),
            authType: formState.authType,
            password: formState.password.trim() || undefined,
            privateKey: formState.privateKey.trim() || undefined,
            privateKeyPassphrase: formState.privateKeyPassphrase.trim() || undefined,
            folderId: formState.folderId || undefined,
            note: formState.note.trim() || undefined,
          });
        }

        window.alert(activeServerId ? 'Server updated successfully.' : 'Server created successfully.');
        await reloadData();
      } catch (error: unknown) {
        window.alert(error instanceof Error ? error.message : 'Failed to save server.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [activeServerId, formState, reloadData, requiresPassword, requiresPrivateKey, servers],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-2">
      <div className="flex min-h-0 flex-1 gap-3.5">
        <aside className="flex h-full w-[250px] shrink-0 flex-col">
          <div className="pb-3">
            <Menubar>
              <div className="w-50 relative">
                <Input
                  value={search}
                  placeholder={t('home.searchPlaceholder')}
                  className="pr-9"
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-header-text-muted" />
              </div>

              <MenubarSeparator vertical />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('home.sortAction')}
                    className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                  >
                    {React.createElement(sortModeIcon, { className: 'h-4 w-4' })}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>{t('home.sortAction')}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={sortMode === 'default'}
                    onSelect={() => setSortMode('default')}
                  >
                    默认
                  </DropdownMenuCheckboxItem>
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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('home.addAction')}
                    className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={onAddServer}>{t('home.quickAddServer')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void onCreateFolder()}>{t('home.quickAddFolder')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Menubar>
          </div>

          <div className="min-h-0 flex-1 overflow-auto pb-2 pr-1">
            {isLoading ? <div className="px-2 text-sm text-home-text-subtle">{t('home.loading')}</div> : null}

            {!isLoading && displayGroups.length === 0 && activeServerId !== null ? (
              <div className="px-2 text-sm text-home-text-subtle">{t('home.empty')}</div>
            ) : null}

            {!isLoading ? (
              <div className="space-y-4">
                {activeServerId === null ? (
                  <section>
                    <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">Draft</div>
                    <EntityCard
                      selected
                      title="新服务器"
                      subtitle="未保存"
                      icon={createIconNode(colorKeyToClassName('blue'), '新服务器')}
                      onClick={onAddServer}
                    />
                  </section>
                ) : null}

                {displayGroups.map((group) => (
                  <section key={group.key}>
                    {group.title ? (
                      <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">{group.title}</div>
                    ) : null}
                    <div className="space-y-1.5">
                      {group.items.map((server) => {
                        const visual = resolveHomeVisual('server', server.id, server.folder?.id ?? server.id);
                        return (
                          <EntityCard
                            key={server.id}
                            title={server.name}
                            subtitle={server.note || server.host}
                            selected={server.id === activeServerId}
                            icon={createIconNode(colorKeyToClassName(visual.colorKey), server.name)}
                            imageUrl={visual.imageUrl}
                            onClick={() => onPickServer(server.id)}
                          />
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}
          </div>
        </aside>

        <div className="w-px shrink-0 bg-home-divider" />

        <main className="flex min-w-0 flex-1 flex-col pl-2">
          <div className="shrink-0 bg-bg pb-2">
            <div className="flex items-center justify-between gap-4 pb-1 ps-2">
              <Menubar>
                <Input
                  value={formState.name}
                  placeholder="Server name"
                  className="w-[280px]"
                  onChange={(event) => onChangeForm('name', event.target.value)}
                />
              </Menubar>

              <Menubar>
                <Button
                  type="submit"
                  form="ssh-editor-form"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Saving...' : activeServerId ? 'Save Changes' : 'Create Server'}
                </Button>
              </Menubar>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <Form
              id="ssh-editor-form"
              className="grid gap-4 pb-4"
              onSubmit={(event) => void onSubmit(event)}
            >
              <section className="grid gap-3">
                <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">Basic Connection</div>

                <FormField>
                  <FormLabel htmlFor="ssh-editor-host">Host</FormLabel>
                  <FormControl>
                    <Input
                      id="ssh-editor-host"
                      value={formState.host}
                      placeholder="node-a.prod"
                      onChange={(event) => onChangeForm('host', event.target.value)}
                    />
                  </FormControl>
                </FormField>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField>
                    <FormLabel htmlFor="ssh-editor-port">Port</FormLabel>
                    <FormControl>
                      <Input
                        id="ssh-editor-port"
                        value={formState.port}
                        inputMode="numeric"
                        onChange={(event) => onChangeForm('port', event.target.value)}
                      />
                    </FormControl>
                  </FormField>

                  <FormField>
                    <FormLabel htmlFor="ssh-editor-username">Username</FormLabel>
                    <FormControl>
                      <Input
                        id="ssh-editor-username"
                        value={formState.username}
                        placeholder="root"
                        onChange={(event) => onChangeForm('username', event.target.value)}
                      />
                    </FormControl>
                  </FormField>

                  <FormField>
                    <FormLabel htmlFor="ssh-editor-folder">Folder</FormLabel>
                    <FormControl>
                      <Select
                        value={formState.folderId || NO_FOLDER_SELECT_VALUE}
                        onValueChange={(value) =>
                          onChangeForm('folderId', value === NO_FOLDER_SELECT_VALUE ? '' : value)
                        }
                      >
                        <SelectTrigger id="ssh-editor-folder">
                          <SelectValue placeholder={t('ssh.noFolder')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_FOLDER_SELECT_VALUE}>{t('ssh.noFolder')}</SelectItem>
                          {folders.map((folder) => (
                            <SelectItem
                              key={folder.id}
                              value={folder.id}
                              icon={Folder}
                            >
                              {folder.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormField>
                </div>
              </section>

              <section className="grid gap-3">
                <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">Authentication</div>

                <FormField>
                  <FormLabel htmlFor="ssh-editor-auth-type">Auth Type</FormLabel>
                  <FormControl>
                    <Select
                      value={formState.authType}
                      onValueChange={(value) => onChangeForm('authType', value as SshAuthType)}
                    >
                      <SelectTrigger id="ssh-editor-auth-type">
                        <SelectValue placeholder="Select auth type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">password</SelectItem>
                        <SelectItem value="key">key</SelectItem>
                        <SelectItem value="both">both</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormField>

                {requiresPassword ? (
                  <FormField>
                    <FormLabel htmlFor="ssh-editor-password">Password</FormLabel>
                    <FormControl>
                      <PasswordField
                        id="ssh-editor-password"
                        value={formState.password}
                        placeholder={
                          activeServer?.hasPassword ? 'Saved password (leave blank to keep unchanged)' : 'Optional'
                        }
                        onChange={(event) => onChangeForm('password', event.target.value)}
                      />
                    </FormControl>
                    {activeServer?.hasPassword && !formState.password.trim() ? (
                      <FormMessage>Password is already saved. Leave this empty to keep it unchanged.</FormMessage>
                    ) : null}
                  </FormField>
                ) : null}

                {requiresPrivateKey ? (
                  <>
                    <FormField>
                      <FormLabel htmlFor="ssh-editor-private-key">Private Key</FormLabel>
                      <FormControl>
                        <Textarea
                          id="ssh-editor-private-key"
                          value={formState.privateKey}
                          placeholder={
                            activeServer?.hasPrivateKey
                              ? 'Saved private key (paste a new one only if you want to replace it)'
                              : '-----BEGIN OPENSSH PRIVATE KEY-----'
                          }
                          rows={5}
                          onChange={(event) => onChangeForm('privateKey', event.target.value)}
                        />
                      </FormControl>
                      <FormMessage>
                        {formState.privateKey.length > 0 && formState.privateKey.length < 32
                          ? 'Key seems too short.'
                          : ''}
                      </FormMessage>
                    </FormField>

                    <FormField>
                      <FormLabel htmlFor="ssh-editor-private-key-passphrase">Private Key Passphrase</FormLabel>
                      <FormControl>
                        <PasswordField
                          id="ssh-editor-private-key-passphrase"
                          value={formState.privateKeyPassphrase}
                          placeholder="Optional"
                          onChange={(event) => onChangeForm('privateKeyPassphrase', event.target.value)}
                        />
                      </FormControl>
                    </FormField>
                  </>
                ) : null}
              </section>

              <section className="grid gap-3">
                <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">Security</div>
                <div className="flex items-center gap-2.5 px-2.5">
                  <Switch
                    id="ssh-editor-strict-host-key"
                    checked={formState.strictHostKey}
                    onCheckedChange={(checkedState) => onChangeForm('strictHostKey', checkedState)}
                  />
                  <Label
                    htmlFor="ssh-editor-strict-host-key"
                    className={formStyles.inlineLabel}
                  >
                    Strict Host Key Checking
                  </Label>
                </div>
              </section>

              <section className="grid gap-3">
                <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">Performance</div>

                <FormField>
                  <div className="mb-1 flex items-center justify-between px-2.5">
                    <FormLabel
                      htmlFor="ssh-editor-timeout"
                      className={formStyles.inlineLabel}
                    >
                      Connection Timeout
                    </FormLabel>
                    <span className={formStyles.helperText}>{formState.connectionTimeout[0]}s</span>
                  </div>
                  <Slider
                    className="px-2.5"
                    id="ssh-editor-timeout"
                    min={5}
                    max={180}
                    step={5}
                    value={formState.connectionTimeout}
                    onValueChange={(value) => onChangeForm('connectionTimeout', value)}
                  />
                </FormField>
              </section>

              <section className="grid gap-3">
                <div className="px-2 pb-1 text-[15px] font-medium text-home-text-subtle">Settings</div>

                <FormField>
                  <FormLabel htmlFor="ssh-editor-note">Note</FormLabel>
                  <FormControl>
                    <Textarea
                      id="ssh-editor-note"
                      value={formState.note}
                      placeholder="e.g. prod-main bastion, weekly patch window on Sunday"
                      rows={4}
                      onChange={(event) => onChangeForm('note', event.target.value)}
                    />
                  </FormControl>
                </FormField>
              </section>
            </Form>
          </div>
        </main>
      </div>
    </div>
  );
};

export default SSHEditor;
