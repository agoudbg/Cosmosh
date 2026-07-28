import type { ApiPortForwardCreateRuleRequest, ApiSshUpdateServerRequest, components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowUpDown,
  CalendarPlus,
  Clock3,
  Copy,
  CornerUpRight,
  FileUp,
  FolderOpen,
  FolderPlus,
  Hash,
  KeyRound,
  Link,
  Network,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  Search,
  Server,
  ShieldAlert,
  Square,
  Star,
  StarOff,
  Tags,
  Terminal,
  Trash2,
} from 'lucide-react';
import React from 'react';

import CreateFolderDialog from '../components/home/CreateFolderDialog';
import EntityCard from '../components/home/EntityCard';
import EntityIcon from '../components/home/EntityIcon';
import EntityVisualPicker from '../components/home/EntityVisualPicker';
import HomeEmptyState from '../components/home/HomeEmptyState';
import SplitWorkbenchLayout, { SplitWorkbenchMainPanel } from '../components/layout/SplitWorkbenchLayout';
import SSHKeychainEditorDialog from '../components/ssh/SSHKeychainEditorDialog';
import SSHServerEditorDialog from '../components/ssh/SSHServerEditorDialog';
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
import { useDialogExitSnapshot } from '../components/ui/dialog-lifecycle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { formStyles } from '../components/ui/form-styles';
import { Input } from '../components/ui/input';
import { menuStyles } from '../components/ui/menu-styles';
import { Menubar, MenubarSeparator, MenuToggleGroup, MenuToggleGroupItem } from '../components/ui/menubar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import type { LocalTerminalProfile } from '../lib/api/transport';
import {
  createPortForwardRule,
  createSshTag,
  deletePortForwardRule,
  deleteSshKeychain,
  deleteSshServer,
  listLocalTerminalProfiles,
  listPortForwardRules,
  listSshFolders,
  listSshKeychains,
  listSshServers,
  listSshTags,
  startPortForwardRule,
  stopPortForwardRule,
  trustSshFingerprint,
  updatePortForwardRule,
  updateSshKeychain,
  updateSshServer,
} from '../lib/backend';
import { createEntityIconNode, EntityColorKey, hashString, isEntityColorKey } from '../lib/entity-visuals';
import { normalizeFolderName, removeFolder, renameFolder } from '../lib/folder-actions';
import { groupHomeItemsByFolder } from '../lib/home-grouping';
import { consumeOpenLocalTerminalListRequest } from '../lib/home-target';
import { getLocale, t } from '../lib/i18n';
import {
  formatPortForwardBindEndpoint,
  formatPortForwardCopyEndpoint,
  formatPortForwardTargetEndpoint,
} from '../lib/port-forward-display';
import { resolveServerAddressForDisplay } from '../lib/server-address';
import { resolveSystemProxyRulesForServer } from '../lib/server-proxy';
import { useSettingsValue } from '../lib/settings-store';
import { buildKeychainMetadataUpdatePayload } from '../lib/ssh-keychain-editor-actions';
import {
  filterSharedKeychains,
  type KeychainEditorInitialFormState,
  type SshKeychainListItem,
} from '../lib/ssh-keychain-editor-shared';
import {
  derivePrivateKeyNameFromFileName,
  type ImportedPrivateKeyFile,
  importPrivateKeyFromFile,
} from '../lib/ssh-private-key-import';
import { toLocalTerminalTargetId } from '../lib/ssh-target';
import { useToast } from '../lib/toast-context';
import { useCreateFolderDialog } from '../lib/use-create-folder-dialog';
import { useDirectionalNavigation } from '../lib/use-directional-navigation';
import { useKeychainEditorDialogState } from '../lib/use-keychain-editor-dialog-state';
import { useServerEditorDialogState } from '../lib/use-server-editor-dialog-state';
import type { HomeState, TabIconKey } from '../types/tabs';

type HomeProps = {
  onOpenSSH: (serverId: string, tabTitle?: string, options?: { openInNewTab?: boolean }) => void;
  onOpenSFTP: (
    serverId: string,
    tabTitle?: string,
    options?: { openInNewTab?: boolean; iconColorKey?: EntityColorKey },
  ) => void;
  tabId: string;
  onTabVisualChange?: (tabId: string, visual: { title: string; iconKey: TabIconKey }) => void;
  isActive: boolean;
  initialState?: HomeState;
};

type SshServerListItem = components['schemas']['SshServerListItem'];
type PortForwardRuleListItem = components['schemas']['PortForwardRuleListItem'];
type PortForwardRuleType = components['schemas']['PortForwardRuleType'];
type SshFolder = components['schemas']['SshFolder'];
type SshTag = components['schemas']['SshTag'];
type HomeMode = 'ssh' | 'keychains' | 'portForwarding';
type QuickFilter = 'none' | 'recent' | 'favorite';
type GroupMode = 'none' | 'folder' | 'lastUsed' | 'tag';
type SortMode = 'nameAsc' | 'nameDesc' | 'lastUsed' | 'createdAt';
type HomeEntityKind = 'server' | 'keychain' | 'portForwarding';
type HomeViewPreference = {
  groupMode: GroupMode;
  sortMode: SortMode;
};

type ServerGroup = {
  key: string;
  title: string;
  items: SshServerListItem[];
};

type KeychainGroup = {
  key: string;
  title: string;
  items: SshKeychainListItem[];
};

type PortForwardRuleGroup = {
  key: string;
  title: string;
  items: PortForwardRuleListItem[];
};

type HomeGridNavigation = ReturnType<typeof useDirectionalNavigation>;

type SidebarCardItem = {
  key: string;
  folderId?: string;
  title: string;
  subtitle: string;
  selected: boolean;
  iconKey: string;
  colorKey: EntityColorKey;
  onClick: () => void;
};

type PortForwardRuleFormState = {
  name: string;
  serverId: string;
  type: PortForwardRuleType;
  localBindHost: string;
  localBindPort: string;
  remoteBindHost: string;
  remoteBindPort: string;
  targetHost: string;
  targetPort: string;
  note: string;
};

type PortForwardHostFingerprintPrompt = {
  ruleId: string;
  serverId: string;
  host: string;
  port: number;
  algorithm: 'sha256';
  fingerprint: string;
};

const LOCAL_TERMINAL_FOLDER_ID = '__local_terminals__';
const KEYCHAIN_RECENT_LIMIT = 12;
const LOCAL_TRUSTED_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const HOME_SECTION_LABEL_CLASS_NAME = 'px-2 pb-2.5 text-xs font-medium leading-4 text-home-text-subtle';
const DEFAULT_HOME_VIEW_PREFERENCES: Record<HomeMode, HomeViewPreference> = {
  ssh: {
    groupMode: 'lastUsed',
    sortMode: 'lastUsed',
  },
  keychains: {
    groupMode: 'lastUsed',
    sortMode: 'lastUsed',
  },
  portForwarding: {
    groupMode: 'none',
    sortMode: 'lastUsed',
  },
};

type BuildHomeKeychainInitialFormStateParams = {
  activeFolderId: string;
  quickFilter: QuickFilter;
  importedKey?: ImportedPrivateKeyFile;
};

/**
 * Builds a keychain create draft that preserves the current Home scope.
 *
 * @param params Draft source parameters.
 * @param params.activeFolderId Current Home folder selection.
 * @param params.quickFilter Current quick filter selection.
 * @param params.importedKey Optional imported private-key file.
 * @returns Initial keychain editor state, or undefined when no prefill is needed.
 */
const buildHomeKeychainInitialFormState = ({
  activeFolderId,
  quickFilter,
  importedKey,
}: BuildHomeKeychainInitialFormStateParams): KeychainEditorInitialFormState | undefined => {
  const initialFormState: KeychainEditorInitialFormState = {};
  if (activeFolderId !== 'all' && activeFolderId !== LOCAL_TERMINAL_FOLDER_ID && quickFilter === 'none') {
    initialFormState.folderId = activeFolderId;
  }

  if (importedKey) {
    initialFormState.name = derivePrivateKeyNameFromFileName(importedKey.fileName);
    initialFormState.authType = 'key';
    initialFormState.privateKey = importedKey.content;
  }

  return Object.keys(initialFormState).length > 0 ? initialFormState : undefined;
};

const homeModeEntityKindMap: Record<HomeMode, HomeEntityKind> = {
  ssh: 'server',
  keychains: 'keychain',
  portForwarding: 'portForwarding',
};

const homeModeItems: Array<{ value: HomeMode; icon: React.ComponentType<{ className?: string }>; labelKey: string }> = [
  {
    value: 'ssh',
    icon: Terminal,
    labelKey: 'home.modeSsh',
  },
  {
    value: 'keychains',
    icon: KeyRound,
    labelKey: 'home.modeKeychains',
  },
  {
    value: 'portForwarding',
    icon: CornerUpRight,
    labelKey: 'home.modePortForwarding',
  },
];

const homeModeTabVisuals: Record<HomeMode, { titleKey: string; iconKey: TabIconKey }> = {
  ssh: {
    titleKey: 'tabs.page.home',
    iconKey: 'home',
  },
  keychains: {
    titleKey: 'home.modeKeychains',
    iconKey: 'keychain',
  },
  portForwarding: {
    titleKey: 'home.modePortForwarding',
    iconKey: 'portForwarding',
  },
};

/**
 * Resolves the tab-strip title and icon for the active Home category.
 *
 * @param mode Active Home category.
 * @returns Localized tab title and icon key.
 */
const resolveHomeModeTabVisual = (mode: HomeMode): { title: string; iconKey: TabIconKey } => {
  const visual = homeModeTabVisuals[mode];
  return {
    title: t(visual.titleKey),
    iconKey: visual.iconKey,
  };
};

/**
 * Checks whether a tag is the internal "favorite" tag.
 * This tag is used behind the scenes to power the favorites feature
 * and should never be displayed in user-facing tag lists or groups.
 */
const isFavoriteTag = (tagName: string): boolean => tagName.toLowerCase().includes('favorite');

/**
 * Resolves the tag ids for the next favorite state shared by Home entities.
 * The internal favorite tag is created lazily so servers and keychains use one
 * canonical tag without exposing it in user-facing tag groups.
 *
 * @param currentTags Tags currently assigned to the entity.
 * @returns Tag ids with the favorite state toggled.
 */
const resolveNextFavoriteTagIds = async (currentTags: SshTag[]): Promise<string[]> => {
  if (currentTags.some((tag) => isFavoriteTag(tag.name))) {
    return currentTags.filter((tag) => !isFavoriteTag(tag.name)).map((tag) => tag.id);
  }

  const tagsResponse = await listSshTags();
  let favoriteTag = tagsResponse.data.items.find((tag) => tag.name.toLowerCase() === 'favorite');

  if (!favoriteTag) {
    const createResponse = await createSshTag({ name: 'favorite' });
    favoriteTag = createResponse.data.item;
  }

  return [...currentTags.map((tag) => tag.id), favoriteTag.id];
};

/**
 * Returns the localized count label for the active home mode.
 *
 * @param kind The entity kind represented by the current tab.
 * @param count Number of entities in the group.
 * @returns Localized count label for sidebar cards.
 */
const resolveHomeEntityCountLabel = (kind: HomeEntityKind, count: number): string => {
  if (kind === 'keychain') {
    return t('home.keychainCount', { count });
  }

  if (kind === 'portForwarding') {
    return t('home.portForwardingCount', { count });
  }

  return t('home.hostCount', { count });
};

/**
 * Checks whether a keychain is marked as favorite through the shared tag model.
 *
 * @param keychain Keychain list item.
 * @returns True when a keychain has a favorite tag.
 */
const isKeychainFavorite = (keychain: SshKeychainListItem): boolean => {
  return (keychain.tags ?? []).some((tag) => isFavoriteTag(tag.name));
};

/**
 * Reads a sortable timestamp from keychain metadata.
 *
 * @param keychain Keychain list item.
 * @param field Timestamp field to read.
 * @returns Numeric timestamp or zero when unavailable.
 */
const getKeychainTimestamp = (keychain: SshKeychainListItem, field: 'createdAt' | 'updatedAt'): number => {
  return new Date(keychain[field]).getTime();
};

/**
 * Reads a sortable timestamp from port forwarding rule metadata.
 *
 * @param rule Port forwarding rule list item.
 * @param field Timestamp field to read.
 * @returns Numeric timestamp or zero when unavailable.
 */
const getPortForwardRuleTimestamp = (rule: PortForwardRuleListItem, field: 'createdAt' | 'updatedAt'): number => {
  return new Date(rule[field]).getTime();
};

/**
 * Checks whether a local bind host is constrained to the local machine.
 *
 * @param host Bind host typed by the user.
 * @returns True when the host does not expose a listener to the wider network.
 */
const isTrustedLocalBindHost = (host: string | undefined): boolean => {
  return LOCAL_TRUSTED_BIND_HOSTS.has((host ?? '').trim().toLowerCase());
};

/**
 * Returns the localized label for a port forwarding type.
 *
 * @param type Forwarding type stored on a rule.
 * @returns Localized display label.
 */
const resolvePortForwardTypeLabel = (type: PortForwardRuleType): string => {
  if (type === 'local') {
    return t('home.portForwardingTypeLocal');
  }

  if (type === 'remote') {
    return t('home.portForwardingTypeRemote');
  }

  return t('home.portForwardingTypeDynamic');
};

/**
 * Resolves the menu label for a Home grouping mode in the active feature.
 *
 * @param homeMode Active Home feature mode.
 * @param mode Grouping mode value stored in feature-local view preferences.
 * @returns Localized menu item label.
 */
const resolveGroupModeLabel = (homeMode: HomeMode, mode: GroupMode): string => {
  if (mode === 'none') {
    return t('home.groupModeNone');
  }

  if (mode === 'folder') {
    return t('home.groupModeFolder');
  }

  if (homeMode === 'portForwarding') {
    return mode === 'lastUsed' ? t('home.groupModeStatus') : t('home.groupModeForwardingType');
  }

  return mode === 'lastUsed' ? t('home.groupModeLastUsed') : t('home.groupModeTag');
};

/**
 * Creates the default form state used by the New Rule dialog.
 *
 * @param servers Current SSH server list.
 * @returns Form state with safe localhost defaults.
 */
const createDefaultPortForwardRuleFormState = (servers: SshServerListItem[]): PortForwardRuleFormState => {
  return {
    name: '',
    serverId: servers[0]?.id ?? '',
    type: 'local',
    localBindHost: '127.0.0.1',
    localBindPort: '8080',
    remoteBindHost: '127.0.0.1',
    remoteBindPort: '8080',
    targetHost: '127.0.0.1',
    targetPort: '80',
    note: '',
  };
};

/**
 * Converts a persisted rule into editable form state.
 *
 * @param rule Existing port forwarding rule.
 * @returns Form state seeded from the rule.
 */
const createPortForwardRuleFormStateFromRule = (rule: PortForwardRuleListItem): PortForwardRuleFormState => {
  return {
    name: rule.name,
    serverId: rule.serverId,
    type: rule.type,
    localBindHost: rule.localBindHost ?? '127.0.0.1',
    localBindPort: String(rule.localBindPort ?? 8080),
    remoteBindHost: rule.remoteBindHost ?? '127.0.0.1',
    remoteBindPort: String(rule.remoteBindPort ?? 8080),
    targetHost: rule.targetHost ?? '127.0.0.1',
    targetPort: String(rule.targetPort ?? 80),
    note: rule.note ?? '',
  };
};

/**
 * Converts dialog form state into the API payload accepted by the backend.
 *
 * @param formState Current form values.
 * @returns API payload with type-specific fields.
 */
const buildPortForwardRulePayload = (formState: PortForwardRuleFormState): ApiPortForwardCreateRuleRequest => {
  const trimmedNote = formState.note.trim();
  const basePayload: ApiPortForwardCreateRuleRequest = {
    name: formState.name.trim(),
    serverId: formState.serverId,
    type: formState.type,
    note: trimmedNote.length > 0 ? trimmedNote : undefined,
  };

  if (formState.type === 'remote') {
    return {
      ...basePayload,
      remoteBindHost: formState.remoteBindHost.trim(),
      remoteBindPort: Number(formState.remoteBindPort),
      targetHost: formState.targetHost.trim(),
      targetPort: Number(formState.targetPort),
    };
  }

  if (formState.type === 'dynamic') {
    return {
      ...basePayload,
      localBindHost: formState.localBindHost.trim(),
      localBindPort: Number(formState.localBindPort),
    };
  }

  return {
    ...basePayload,
    localBindHost: formState.localBindHost.trim(),
    localBindPort: Number(formState.localBindPort),
    targetHost: formState.targetHost.trim(),
    targetPort: Number(formState.targetPort),
  };
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

type HomeModeTabsProps = {
  activeMode: HomeMode;
  onModeChange: (mode: HomeMode) => void;
};

/**
 * Renders the Home sidebar mode switcher.
 *
 * @param props Component props.
 * @param props.activeMode Current selected home mode.
 * @param props.onModeChange Callback fired when a mode is selected.
 * @returns Sidebar-width equal-segment mode tabs.
 */
const HomeModeTabs: React.FC<HomeModeTabsProps> = ({ activeMode, onModeChange }) => {
  return (
    <TooltipProvider delayDuration={180}>
      <div className="pb-4">
        <MenuToggleGroup
          type="single"
          value={activeMode}
          className="flex w-full"
          onValueChange={(value) => {
            if (value === 'ssh' || value === 'keychains' || value === 'portForwarding') {
              onModeChange(value);
            }
          }}
        >
          {homeModeItems.map((item) => {
            const Icon = item.icon;
            const label = t(item.labelKey);
            const isActive = activeMode === item.value;

            return (
              <Tooltip key={item.value}>
                <TooltipTrigger asChild>
                  <MenuToggleGroupItem
                    value={item.value}
                    aria-label={label}
                    className={classNames(
                      'flex-1 justify-center px-0 text-header-text',
                      isActive ? '!bg-home-card-active shadow-menu' : '!bg-menu-control hover:!bg-menu-control-hover',
                    )}
                  >
                    <Icon className="h-4 w-4 text-header-text" />
                    <span className="sr-only">{label}</span>
                  </MenuToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </MenuToggleGroup>
      </div>
    </TooltipProvider>
  );
};

type HomeKeychainsContentProps = {
  groups: KeychainGroup[];
  gridIndexMap: Map<string, number>;
  gridNavigation: HomeGridNavigation;
  onToggleFavorite: (keychain: SshKeychainListItem) => void;
  onCopyKeychainName: (keychainName: string) => void;
  onEditKeychain: (keychainId: string) => void;
  onDeleteKeychain: (keychainId: string, keychainName: string) => void;
};

/**
 * Renders shared keychains for the selected Home folder/filter scope.
 *
 * @param props Component props.
 * @param props.groups Grouped keychain rows.
 * @param props.gridIndexMap Map from rendered row key to keyboard navigation index.
 * @param props.gridNavigation Keyboard navigation helpers for keychain cards.
 * @param props.onToggleFavorite Callback fired when a keychain's favorite state changes.
 * @param props.onCopyKeychainName Callback fired when a keychain name is copied.
 * @param props.onEditKeychain Callback fired when a keychain card is selected.
 * @param props.onDeleteKeychain Callback fired when keychain deletion is requested.
 * @returns Keychain card grid.
 */
const HomeKeychainsContent: React.FC<HomeKeychainsContentProps> = ({
  groups,
  gridIndexMap,
  gridNavigation,
  onToggleFavorite,
  onCopyKeychainName,
  onEditKeychain,
  onDeleteKeychain,
}) => {
  return (
    <div className="space-y-4 pb-2">
      {groups.map((group) => (
        <section key={group.key}>
          {group.title ? <div className={HOME_SECTION_LABEL_CLASS_NAME}>{group.title}</div> : null}
          <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-x-7 gap-y-3">
            {group.items.map((keychain) => {
              const keychainEntryKey = `${group.key}:${keychain.id}`;
              const keychainEntryIndex = gridIndexMap.get(keychainEntryKey) ?? 0;
              const colorKey = isEntityColorKey(keychain.colorKey) ? keychain.colorKey : 'emerald';
              const isFavorite = isKeychainFavorite(keychain);

              return (
                <ContextMenu key={keychainEntryKey}>
                  <ContextMenuTrigger className="block">
                    <EntityCard
                      {...gridNavigation.getItemProps(keychainEntryIndex)}
                      layout="grid"
                      title={keychain.name}
                      subtitle={t('sshKeychain.visibilityShared')}
                      icon={createEntityIconNode(
                        {
                          iconKey: keychain.iconKey,
                          colorKey,
                        },
                        keychain.name,
                      )}
                      onClick={() => onEditKeychain(keychain.id)}
                    />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      icon={isFavorite ? StarOff : Star}
                      onSelect={() => onToggleFavorite(keychain)}
                    >
                      {isFavorite ? t('home.contextUnfavorite') : t('home.contextFavorite')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={Copy}
                      onSelect={() => onCopyKeychainName(keychain.name)}
                    >
                      {t('sshKeychain.contextCopyName')}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={Pencil}
                      onSelect={() => onEditKeychain(keychain.id)}
                    >
                      {t('home.contextEdit')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      icon={Trash2}
                      onSelect={() => onDeleteKeychain(keychain.id, keychain.name)}
                    >
                      {t('home.contextDelete')}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
};

type HomeSshContentProps = {
  activeFolderId: string;
  groupedServers: ServerGroup[];
  filteredLocalTerminalProfiles: LocalTerminalProfile[];
  localTerminalGridNavigation: HomeGridNavigation;
  serverGridIndexMap: Map<string, number>;
  serverGridNavigation: HomeGridNavigation;
  draggingServerId: string | null;
  showFullServerAddress: boolean;
  localTerminalFileManagerLabel: string;
  openInNewTabShortcutLabel: string;
  onOpenSSH: HomeProps['onOpenSSH'];
  onOpenSFTP: HomeProps['onOpenSFTP'];
  onShowInFileManager: (targetPath: string) => void;
  onOpenServerFromCard: (
    server: SshServerListItem,
    event?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>,
  ) => void;
  onSetDraggingServerId: (serverId: string | null) => void;
  onSetDragOverFolderId: (folderId: string | null) => void;
  isServerFavorite: (server: SshServerListItem) => boolean;
  onToggleFavorite: (server: SshServerListItem) => void;
  onCopyToClipboard: (value: string) => void;
  onEditServer: (serverId: string) => void;
  onDeleteServer: (serverId: string, serverName: string) => void;
};

/**
 * Renders the existing Home SSH and local-terminal card grids.
 *
 * @param props Component props.
 * @returns SSH/local-terminal content body.
 */
const HomeSshContent: React.FC<HomeSshContentProps> = ({
  activeFolderId,
  groupedServers,
  filteredLocalTerminalProfiles,
  localTerminalGridNavigation,
  serverGridIndexMap,
  serverGridNavigation,
  draggingServerId,
  showFullServerAddress,
  localTerminalFileManagerLabel,
  openInNewTabShortcutLabel,
  onOpenSSH,
  onOpenSFTP,
  onShowInFileManager,
  onOpenServerFromCard,
  onSetDraggingServerId,
  onSetDragOverFolderId,
  isServerFavorite,
  onToggleFavorite,
  onCopyToClipboard,
  onEditServer,
  onDeleteServer,
}) => {
  return (
    <div className="space-y-4 pb-2">
      {activeFolderId === LOCAL_TERMINAL_FOLDER_ID ? (
        <section>
          <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-x-7 gap-y-3">
            {filteredLocalTerminalProfiles.map((profile, index) => (
              <ContextMenu key={profile.id}>
                <ContextMenuTrigger className="block">
                  <EntityCard
                    {...localTerminalGridNavigation.getItemProps(index)}
                    layout="grid"
                    title={profile.name}
                    subtitle={profile.command}
                    icon={createEntityIconNode({ iconKey: 'HardDrive', colorKey: 'blue' }, profile.name)}
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
                      onShowInFileManager(profile.executablePath);
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
            {group.title ? <div className={HOME_SECTION_LABEL_CLASS_NAME}>{group.title}</div> : null}
            <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-x-7 gap-y-3">
              {group.items.map((server) => {
                const serverEntryKey = `${group.key}:${server.id}`;
                const serverEntryIndex = serverGridIndexMap.get(serverEntryKey) ?? 0;
                const colorKey = isEntityColorKey(server.colorKey) ? server.colorKey : 'blue';
                return (
                  <ContextMenu key={serverEntryKey}>
                    <ContextMenuTrigger className="block">
                      <EntityCard
                        {...serverGridNavigation.getItemProps(serverEntryIndex)}
                        draggable
                        layout="grid"
                        title={server.name}
                        subtitle={resolveServerAddressForDisplay(server.host, showFullServerAddress)}
                        className={draggingServerId === server.id ? 'opacity-70' : undefined}
                        icon={createEntityIconNode({ iconKey: server.iconKey, colorKey }, server.name)}
                        action={
                          <Button
                            variant="ghost"
                            tabIndex={serverEntryIndex === serverGridNavigation.activeIndex ? 0 : -1}
                            className="h-[32px] w-[32px] rounded-[8px] px-0 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                            aria-label={t('home.contextConnectSftp')}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenSFTP(server.id, server.name, {
                                openInNewTab: true,
                                iconColorKey: colorKey,
                              });
                            }}
                          >
                            <FolderOpen className="h-4 w-4 flex-shrink-0" />
                          </Button>
                        }
                        onDragStart={(event) => {
                          event.dataTransfer.setData('application/x-cosmosh-server-id', server.id);
                          event.dataTransfer.effectAllowed = 'move';
                          onSetDraggingServerId(server.id);
                        }}
                        onDragEnd={() => {
                          onSetDraggingServerId(null);
                          onSetDragOverFolderId(null);
                        }}
                        onClick={(event) => onOpenServerFromCard(server, event)}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        icon={Terminal}
                        onSelect={() => onOpenSSH(server.id, server.name)}
                      >
                        {t('home.contextConnect')}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => onOpenSSH(server.id, server.name, { openInNewTab: true })}>
                        {t('home.openSshNewTab')}
                        <ContextMenuShortcut>{openInNewTabShortcutLabel}</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={FolderOpen}
                        onSelect={() => onOpenSFTP(server.id, server.name, { iconColorKey: colorKey })}
                      >
                        {t('home.contextConnectSftp')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={isServerFavorite(server) ? StarOff : Star}
                        onSelect={() => {
                          onToggleFavorite(server);
                        }}
                      >
                        {isServerFavorite(server) ? t('home.contextUnfavorite') : t('home.contextFavorite')}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger icon={Copy}>{t('home.contextCopy')}</ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem
                            icon={Network}
                            onSelect={() => {
                              onCopyToClipboard(server.host);
                            }}
                          >
                            {t('home.contextCopyIp')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            icon={Server}
                            onSelect={() => {
                              onCopyToClipboard(server.name);
                            }}
                          >
                            {t('home.contextCopyName')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            icon={Hash}
                            onSelect={() => {
                              onCopyToClipboard(String(server.port));
                            }}
                          >
                            {t('home.contextCopyPort')}
                          </ContextMenuItem>
                          <ContextMenuItem
                            icon={Link}
                            onSelect={() => {
                              onCopyToClipboard(`ssh://${server.username}@${server.host}:${server.port}`);
                            }}
                          >
                            {t('home.contextCopySchema')}
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={Pencil}
                        onSelect={() => onEditServer(server.id)}
                      >
                        {t('home.contextEdit')}
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={Trash2}
                        onSelect={() => onDeleteServer(server.id, server.name)}
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
  );
};

type HomePortForwardingContentProps = {
  groups: PortForwardRuleGroup[];
  servers: SshServerListItem[];
  onStartRule: (ruleId: string) => void;
  onStopRule: (ruleId: string) => void;
  onEditRule: (rule: PortForwardRuleListItem) => void;
  onDeleteRule: (rule: PortForwardRuleListItem) => void;
  onCopyToClipboard: (value: string) => void;
};

/**
 * Renders the high-density port forwarding rules table.
 *
 * @param props Rule rows and row action callbacks.
 * @returns Port forwarding content body.
 */
const HomePortForwardingContent: React.FC<HomePortForwardingContentProps> = ({
  groups,
  servers,
  onStartRule,
  onStopRule,
  onEditRule,
  onDeleteRule,
  onCopyToClipboard,
}) => {
  const serverNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    servers.forEach((server) => map.set(server.id, server.name));
    return map;
  }, [servers]);
  const hasRules = groups.some((group) => group.items.length > 0);

  if (!hasRules) {
    return (
      <HomeEmptyState
        text={t('home.portForwardingEmpty')}
        icon={PackageOpen}
      />
    );
  }

  return (
    <TooltipProvider delayDuration={180}>
      <div className="space-y-4 pb-2">
        {groups.map((group) => (
          <section key={group.key}>
            {group.title ? <div className={HOME_SECTION_LABEL_CLASS_NAME}>{group.title}</div> : null}
            <div className="overflow-x-auto rounded-sm-2 border border-home-divider">
              <div className="bg-home-card/70 grid min-w-[880px] grid-cols-[1.1fr_0.72fr_0.72fr_1fr_1fr_0.9fr_142px] border-b border-home-divider px-3 py-2 text-xs font-medium text-home-text-subtle">
                <div>{t('home.portForwardingColumnRule')}</div>
                <div>{t('home.portForwardingColumnStatus')}</div>
                <div>{t('home.portForwardingColumnType')}</div>
                <div>{t('home.portForwardingColumnBind')}</div>
                <div>{t('home.portForwardingColumnTarget')}</div>
                <div>{t('home.portForwardingColumnServer')}</div>
                <div className="text-end">{t('home.portForwardingColumnActions')}</div>
              </div>

              <div className="divide-y divide-home-divider">
                {group.items.map((rule) => {
                  const isRunning = rule.runtime.status === 'running';
                  const isLocalBindRisk =
                    rule.type !== 'remote' && !isTrustedLocalBindHost(rule.localBindHost ?? rule.runtime.boundHost);
                  const statusLabel = isRunning
                    ? t('home.portForwardingStatusRunningWithConnections', {
                        count: rule.runtime.activeConnectionCount,
                      })
                    : t('home.portForwardingStatusStopped');

                  return (
                    <div
                      key={rule.id}
                      className="bg-home-card/35 text-home-text hover:bg-home-card/70 grid min-w-[880px] grid-cols-[1.1fr_0.72fr_0.72fr_1fr_1fr_0.9fr_142px] items-center gap-2 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{rule.name}</span>
                          {isLocalBindRisk ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0 text-form-message-error" />
                              </TooltipTrigger>
                              <TooltipContent>{t('home.portForwardingBindRiskTooltip')}</TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                        {rule.note ? (
                          <div className="mt-0.5 truncate text-xs text-home-text-subtle">{rule.note}</div>
                        ) : null}
                      </div>

                      <div className="min-w-0">
                        <div
                          className={classNames(
                            'flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs',
                            isRunning ? 'text-home-text' : 'text-home-text-subtle',
                          )}
                        >
                          <span
                            className={classNames(
                              'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                              isRunning ? 'bg-form-active' : 'bg-home-text-subtle',
                            )}
                          />
                          <span className="truncate">{statusLabel}</span>
                        </div>
                        {!isRunning && rule.lastFailureMessage ? (
                          <div
                            className="mt-1 truncate text-xs text-form-message-error"
                            title={rule.lastFailureMessage}
                          >
                            {t('home.portForwardingActivityFailed')}
                          </div>
                        ) : null}
                      </div>

                      <div className="truncate text-home-text-subtle">{resolvePortForwardTypeLabel(rule.type)}</div>
                      <div className="truncate font-mono text-xs">{formatPortForwardBindEndpoint(rule)}</div>
                      <div className="truncate font-mono text-xs">{formatPortForwardTargetEndpoint(rule)}</div>
                      <div className="truncate text-home-text-subtle">
                        {rule.serverName ?? serverNameById.get(rule.serverId) ?? t('home.portForwardingUnknownServer')}
                      </div>

                      <div className="flex justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghostIcon"
                              className="h-8 w-8 rounded-sm-2"
                              aria-label={
                                isRunning ? t('home.portForwardingStopAction') : t('home.portForwardingStartAction')
                              }
                              onClick={() => {
                                if (isRunning) {
                                  onStopRule(rule.id);
                                  return;
                                }

                                onStartRule(rule.id);
                              }}
                            >
                              {isRunning ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isRunning ? t('home.portForwardingStopAction') : t('home.portForwardingStartAction')}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghostIcon"
                              className="h-8 w-8 rounded-sm-2"
                              aria-label={t('home.portForwardingCopyEndpointAction')}
                              onClick={() => onCopyToClipboard(formatPortForwardCopyEndpoint(rule))}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('home.portForwardingCopyEndpointAction')}</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghostIcon"
                              className="h-8 w-8 rounded-sm-2"
                              disabled={isRunning}
                              aria-label={t('home.contextEdit')}
                              onClick={() => onEditRule(rule)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isRunning ? t('home.portForwardingActiveEditDisabled') : t('home.contextEdit')}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghostIcon"
                              className="h-8 w-8 rounded-sm-2"
                              disabled={isRunning}
                              aria-label={t('home.contextDelete')}
                              onClick={() => onDeleteRule(rule)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isRunning ? t('home.portForwardingActiveDeleteDisabled') : t('home.contextDelete')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        ))}
      </div>
    </TooltipProvider>
  );
};

type PortForwardRuleDialogProps = {
  open: boolean;
  mode: 'create' | 'edit';
  formState: PortForwardRuleFormState;
  servers: SshServerListItem[];
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onExitComplete: () => void;
  onFormStateChange: (nextState: PortForwardRuleFormState) => void;
  onSubmit: () => void;
};

/**
 * Renders the create/edit dialog for a port forwarding rule.
 *
 * @param props Dialog state, form state, and callbacks.
 * @returns Port forwarding rule dialog.
 */
const PortForwardRuleDialog: React.FC<PortForwardRuleDialogProps> = ({
  open,
  mode,
  formState,
  servers,
  isSubmitting,
  onOpenChange,
  onExitComplete,
  onFormStateChange,
  onSubmit,
}) => {
  const updateField = React.useCallback(
    <Key extends keyof PortForwardRuleFormState>(key: Key, value: PortForwardRuleFormState[Key]) => {
      onFormStateChange({ ...formState, [key]: value });
    },
    [formState, onFormStateChange],
  );
  const shouldShowLocalRiskWarning = formState.type !== 'remote' && !isTrustedLocalBindHost(formState.localBindHost);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        className="max-w-[640px]"
        onExitComplete={onExitComplete}
      >
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? t('home.portForwardingDialogCreateTitle') : t('home.portForwardingDialogEditTitle')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('home.portForwardingDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <label className={formStyles.field}>
              <span className={formStyles.label}>{t('home.portForwardingFieldName')}</span>
              <Input
                value={formState.name}
                placeholder={t('home.portForwardingFieldNamePlaceholder')}
                onChange={(event) => updateField('name', event.target.value)}
              />
            </label>

            <label className={formStyles.field}>
              <span className={formStyles.label}>{t('home.portForwardingFieldServer')}</span>
              <Select
                disabled={servers.length === 0}
                value={formState.serverId}
                onValueChange={(value) => updateField('serverId', value)}
              >
                {servers.length === 0 ? (
                  <SelectTrigger>
                    <SelectValue placeholder={t('home.portForwardingNoServers')} />
                  </SelectTrigger>
                ) : (
                  <>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((server) => (
                        <SelectItem
                          key={server.id}
                          value={server.id}
                          icon={Server}
                        >
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </>
                )}
              </Select>
            </label>
          </div>

          <div className={formStyles.field}>
            <span className={formStyles.label}>{t('home.portForwardingFieldType')}</span>
            <MenuToggleGroup
              type="single"
              value={formState.type}
              onValueChange={(value) => {
                if (value === 'local' || value === 'remote' || value === 'dynamic') {
                  updateField('type', value);
                }
              }}
            >
              <MenuToggleGroupItem value="local">{t('home.portForwardingTypeLocal')}</MenuToggleGroupItem>
              <MenuToggleGroupItem value="remote">{t('home.portForwardingTypeRemote')}</MenuToggleGroupItem>
              <MenuToggleGroupItem value="dynamic">{t('home.portForwardingTypeDynamic')}</MenuToggleGroupItem>
            </MenuToggleGroup>
          </div>

          {formState.type === 'remote' ? (
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingRemoteBindHost')}</span>
                <Input
                  value={formState.remoteBindHost}
                  onChange={(event) => updateField('remoteBindHost', event.target.value)}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingRemoteBindPort')}</span>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={formState.remoteBindPort}
                  onChange={(event) => updateField('remoteBindPort', event.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingLocalBindHost')}</span>
                <Input
                  value={formState.localBindHost}
                  onChange={(event) => updateField('localBindHost', event.target.value)}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingLocalBindPort')}</span>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={formState.localBindPort}
                  onChange={(event) => updateField('localBindPort', event.target.value)}
                />
              </label>
            </div>
          )}

          {formState.type !== 'dynamic' ? (
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingTargetHost')}</span>
                <Input
                  value={formState.targetHost}
                  onChange={(event) => updateField('targetHost', event.target.value)}
                />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>{t('home.portForwardingTargetPort')}</span>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={formState.targetPort}
                  onChange={(event) => updateField('targetPort', event.target.value)}
                />
              </label>
            </div>
          ) : null}

          {shouldShowLocalRiskWarning ? (
            <div className="border-form-message-error/40 bg-form-message-error/10 rounded-sm-2 border px-3 py-2 text-xs text-form-message-error">
              {t('home.portForwardingBindRiskWarning')}
            </div>
          ) : null}

          <label className={formStyles.field}>
            <span className={formStyles.label}>{t('home.portForwardingFieldNote')}</span>
            <Textarea
              value={formState.note}
              placeholder={t('home.portForwardingFieldNotePlaceholder')}
              onChange={(event) => updateField('note', event.target.value)}
            />
          </label>
        </div>

        <DialogFooter>
          <DialogSecondaryButton onClick={() => onOpenChange(false)}>{t('home.actionCancel')}</DialogSecondaryButton>
          <DialogPrimaryButton
            disabled={isSubmitting || servers.length === 0}
            onClick={() => onSubmit()}
          >
            {mode === 'create' ? t('home.actionCreate') : t('home.actionSave')}
          </DialogPrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const Home: React.FC<HomeProps> = ({ onOpenSSH, onOpenSFTP, tabId, onTabVisualChange, isActive, initialState }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const defaultServerNoteTemplate = useSettingsValue('defaultServerNoteTemplate');
  const showFullServerAddress = useSettingsValue('showFullServerAddress');
  const [activeHomeMode, setActiveHomeMode] = React.useState<HomeMode>(initialState?.initialMode ?? 'ssh');
  const [servers, setServers] = React.useState<SshServerListItem[]>([]);
  const [keychains, setKeychains] = React.useState<SshKeychainListItem[]>([]);
  const [folders, setFolders] = React.useState<SshFolder[]>([]);
  const [portForwardRules, setPortForwardRules] = React.useState<PortForwardRuleListItem[]>([]);
  const [localTerminalProfiles, setLocalTerminalProfiles] = React.useState<LocalTerminalProfile[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [activeFolderId, setActiveFolderId] = React.useState<string>('all');
  const [activeTag, setActiveTag] = React.useState<string>('all');
  const [search, setSearch] = React.useState<string>('');
  const [quickFilter, setQuickFilter] = React.useState<QuickFilter>('none');
  const [viewPreferences, setViewPreferences] =
    React.useState<Record<HomeMode, HomeViewPreference>>(DEFAULT_HOME_VIEW_PREFERENCES);
  const [runtimeUserName, setRuntimeUserName] = React.useState<string>('user');
  const [isEditFolderDialogOpen, setIsEditFolderDialogOpen] = React.useState<boolean>(false);
  const [isDeleteFolderDialogOpen, setIsDeleteFolderDialogOpen] = React.useState<boolean>(false);
  const [isDeleteServerDialogOpen, setIsDeleteServerDialogOpen] = React.useState<boolean>(false);
  const [isDeleteKeychainDialogOpen, setIsDeleteKeychainDialogOpen] = React.useState<boolean>(false);
  const [folderNameInput, setFolderNameInput] = React.useState<string>('');
  const [activeFolderDraft, setActiveFolderDraft] = React.useState<{
    id: string;
    name: string;
    iconKey: string;
    colorKey: EntityColorKey;
  } | null>(null);
  const [activeServerDraft, setActiveServerDraft] = React.useState<{ id: string; name: string } | null>(null);
  const [activeKeychainDraft, setActiveKeychainDraft] = React.useState<{ id: string; name: string } | null>(null);
  const [activePortForwardRuleDraft, setActivePortForwardRuleDraft] = React.useState<PortForwardRuleListItem | null>(
    null,
  );
  const [isPortForwardRuleDialogOpen, setIsPortForwardRuleDialogOpen] = React.useState<boolean>(false);
  const [portForwardRuleDialogMode, setPortForwardRuleDialogMode] = React.useState<'create' | 'edit'>('create');
  const [portForwardRuleFormState, setPortForwardRuleFormState] = React.useState<PortForwardRuleFormState>(() =>
    createDefaultPortForwardRuleFormState([]),
  );
  const [isPortForwardRuleSubmitting, setIsPortForwardRuleSubmitting] = React.useState<boolean>(false);
  const [isDeletePortForwardRuleDialogOpen, setIsDeletePortForwardRuleDialogOpen] = React.useState<boolean>(false);
  const [isPortForwardRuleDeleting, setIsPortForwardRuleDeleting] = React.useState<boolean>(false);
  const [portForwardHostFingerprintPrompt, setPortForwardHostFingerprintPrompt] =
    React.useState<PortForwardHostFingerprintPrompt | null>(null);
  const [exitPortForwardHostFingerprintPrompt, clearExitPortForwardHostFingerprintPrompt] = useDialogExitSnapshot(
    portForwardHostFingerprintPrompt,
  );
  const [isFolderActionSubmitting, setIsFolderActionSubmitting] = React.useState<boolean>(false);
  const [isServerDeleteSubmitting, setIsServerDeleteSubmitting] = React.useState<boolean>(false);
  const [isKeychainDeleteSubmitting, setIsKeychainDeleteSubmitting] = React.useState<boolean>(false);
  const [draggingServerId, setDraggingServerId] = React.useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = React.useState<string | null>(null);
  const previousIsActiveRef = React.useRef<boolean>(isActive);
  const pendingInitialPortForwardRuleIdRef = React.useRef<string | null>(
    initialState?.initialPortForwardRuleId ?? null,
  );
  const sshViewPreference = viewPreferences.ssh;
  const keychainViewPreference = viewPreferences.keychains;
  const portForwardingViewPreference = viewPreferences.portForwarding;
  const activeViewPreference = viewPreferences[activeHomeMode];
  const canGroupByFolder = activeHomeMode !== 'portForwarding' && activeFolderId === 'all';
  const groupMode =
    activeViewPreference.groupMode === 'folder' && !canGroupByFolder ? 'none' : activeViewPreference.groupMode;
  const { sortMode } = activeViewPreference;

  const updateActiveViewPreference = React.useCallback(
    (nextPreference: Partial<HomeViewPreference>) => {
      setViewPreferences((previousPreferences) => ({
        ...previousPreferences,
        [activeHomeMode]: {
          ...previousPreferences[activeHomeMode],
          ...nextPreference,
        },
      }));
    },
    [activeHomeMode],
  );

  const reloadHomeData = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const [
        foldersResponse,
        serversResponse,
        keychainsResponse,
        localTerminalProfilesResponse,
        portForwardRulesResponse,
      ] = await Promise.all([
        listSshFolders(),
        listSshServers(),
        listSshKeychains(),
        listLocalTerminalProfiles(),
        listPortForwardRules(),
      ]);
      setFolders(foldersResponse.data.items);
      setServers(serversResponse.data.items);
      setKeychains(filterSharedKeychains(keychainsResponse.data.items));
      setLocalTerminalProfiles(localTerminalProfilesResponse.data.items);
      setPortForwardRules(portForwardRulesResponse.data.items);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load home data.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Builds a safe SSH server update payload for Home actions.
   * Home operations must preserve keychain linkage instead of inline credentials,
   * otherwise backend validation may incorrectly require private key/password fields.
   */
  const buildServerUpdatePayload = React.useCallback(
    (server: SshServerListItem, overrides: Partial<ApiSshUpdateServerRequest> = {}): ApiSshUpdateServerRequest => {
      if (!server.keychainId) {
        throw new Error('Server keychain reference is missing. Please refresh and try again.');
      }

      const basePayload: ApiSshUpdateServerRequest = {
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        keychainId: server.keychainId,
        strictHostKey: server.strictHostKey,
        enableSshCompression: server.enableSshCompression,
        remoteEnhancementsEnabled: server.remoteEnhancementsEnabled,
        disableCharacterWidthCompatibilityMode: server.disableCharacterWidthCompatibilityMode,
        note: server.note ?? undefined,
        folderId: server.folder?.id,
      };

      return {
        ...basePayload,
        ...overrides,
      };
    },
    [],
  );

  const createFolderDialog = useCreateFolderDialog({
    onCreated: async () => {
      await reloadHomeData();
    },
  });

  React.useEffect(() => {
    void reloadHomeData();
  }, [reloadHomeData]);

  React.useEffect(() => {
    onTabVisualChange?.(tabId, resolveHomeModeTabVisual(activeHomeMode));
  }, [activeHomeMode, onTabVisualChange, tabId]);

  React.useEffect(() => {
    if (activeHomeMode !== 'ssh' && activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
      setActiveFolderId('all');
      setQuickFilter('none');
    }
  }, [activeFolderId, activeHomeMode]);

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
    return servers.filter((server) => (server.tags ?? []).some((tag) => isFavoriteTag(tag.name))).length;
  }, [servers]);

  const recentCount = React.useMemo(() => {
    return servers.filter((server) => Boolean(server.lastLoginAudit?.attemptedAt)).length;
  }, [servers]);

  const keychainFavoriteCount = React.useMemo(() => {
    return keychains.filter((keychain) => isKeychainFavorite(keychain)).length;
  }, [keychains]);

  const recentKeychains = React.useMemo(() => {
    return [...keychains]
      .sort((left, right) => getKeychainTimestamp(right, 'updatedAt') - getKeychainTimestamp(left, 'updatedAt'))
      .slice(0, KEYCHAIN_RECENT_LIMIT);
  }, [keychains]);

  const recentKeychainIdSet = React.useMemo(() => {
    return new Set(recentKeychains.map((keychain) => keychain.id));
  }, [recentKeychains]);

  const runningPortForwardCount = React.useMemo(() => {
    return portForwardRules.filter((rule) => rule.runtime.status === 'running').length;
  }, [portForwardRules]);

  const activeEntityKind = homeModeEntityKindMap[activeHomeMode];

  const serverById = React.useMemo(() => {
    const map = new Map<string, SshServerListItem>();
    servers.forEach((server) => map.set(server.id, server));
    return map;
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
        return (server.tags ?? []).some((tag) => isFavoriteTag(tag.name));
      }

      return true;
    });
  }, [servers, activeFolderId, quickFilter]);

  const tagSourceKeychains = React.useMemo(() => {
    return keychains.filter((keychain) => {
      if (activeFolderId !== 'all' && keychain.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent') {
        return recentKeychainIdSet.has(keychain.id);
      }

      if (quickFilter === 'favorite') {
        return isKeychainFavorite(keychain);
      }

      return true;
    });
  }, [activeFolderId, keychains, quickFilter, recentKeychainIdSet]);

  const tagSourcePortForwardRules = React.useMemo(() => {
    return portForwardRules.filter((rule) => {
      const server = serverById.get(rule.serverId);

      if (activeFolderId !== 'all' && server?.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent' && rule.runtime.status !== 'running') {
        return false;
      }

      return quickFilter !== 'favorite';
    });
  }, [activeFolderId, portForwardRules, quickFilter, serverById]);

  const tags = React.useMemo(() => {
    if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
      return ['all'];
    }

    const nameSet = new Set<string>();
    const sourceItems =
      activeHomeMode === 'keychains'
        ? tagSourceKeychains
        : activeHomeMode === 'portForwarding'
          ? tagSourcePortForwardRules
              .map((rule) => serverById.get(rule.serverId))
              .filter((server): server is SshServerListItem => Boolean(server))
          : tagSourceServers;
    sourceItems.forEach((item) => {
      (item.tags ?? []).forEach((tag) => {
        /* Hide the internal "favorite" tag from user-facing tag filters */
        if (!isFavoriteTag(tag.name)) {
          nameSet.add(tag.name);
        }
      });
    });

    return ['all', ...Array.from(nameSet)];
  }, [activeFolderId, activeHomeMode, serverById, tagSourceKeychains, tagSourcePortForwardRules, tagSourceServers]);

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
        const isFavorite = (server.tags ?? []).some((tag) => isFavoriteTag(tag.name));
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

  const filteredKeychains = React.useMemo(() => {
    return keychains.filter((keychain) => {
      if (activeFolderId !== 'all' && keychain.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent' && !recentKeychainIdSet.has(keychain.id)) {
        return false;
      }

      if (quickFilter === 'favorite' && !isKeychainFavorite(keychain)) {
        return false;
      }

      if (activeTag !== 'all' && !(keychain.tags ?? []).some((tag) => tag.name === activeTag)) {
        return false;
      }

      if (!search.trim()) {
        return true;
      }

      const keyword = search.trim().toLowerCase();
      return keychain.name.toLowerCase().includes(keyword) || (keychain.note ?? '').toLowerCase().includes(keyword);
    });
  }, [activeFolderId, activeTag, keychains, quickFilter, recentKeychainIdSet, search]);

  const filteredPortForwardRules = React.useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return portForwardRules.filter((rule) => {
      const server = serverById.get(rule.serverId);

      if (activeFolderId !== 'all' && server?.folder?.id !== activeFolderId) {
        return false;
      }

      if (quickFilter === 'recent' && rule.runtime.status !== 'running') {
        return false;
      }

      if (quickFilter === 'favorite') {
        return false;
      }

      if (activeTag !== 'all' && !(server?.tags ?? []).some((tag) => tag.name === activeTag)) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      const searchableValues = [
        rule.name,
        rule.serverName ?? '',
        server?.host ?? '',
        server?.username ?? '',
        rule.type,
        rule.note ?? '',
        formatPortForwardBindEndpoint(rule),
        formatPortForwardTargetEndpoint(rule),
      ];

      return searchableValues.some((value) => value.toLowerCase().includes(keyword));
    });
  }, [activeFolderId, activeTag, portForwardRules, quickFilter, search, serverById]);

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
        if (sshViewPreference.sortMode === 'nameAsc') {
          return left.name.localeCompare(right.name);
        }

        if (sshViewPreference.sortMode === 'nameDesc') {
          return right.name.localeCompare(left.name);
        }

        if (sshViewPreference.sortMode === 'createdAt') {
          const leftTime = new Date(left.createdAt).getTime();
          const rightTime = new Date(right.createdAt).getTime();
          return rightTime - leftTime;
        }

        const leftTime = new Date(left.lastLoginAudit?.attemptedAt ?? 0).getTime();
        const rightTime = new Date(right.lastLoginAudit?.attemptedAt ?? 0).getTime();
        return rightTime - leftTime;
      });
    },
    [sshViewPreference.sortMode],
  );

  const groupedServers = React.useMemo<ServerGroup[]>(() => {
    const effectiveGroupMode =
      sshViewPreference.groupMode === 'folder' && activeFolderId !== 'all' ? 'none' : sshViewPreference.groupMode;

    if (effectiveGroupMode === 'none') {
      return [
        {
          key: 'ungrouped:all',
          title: '',
          items: sortServers(filteredServers),
        },
      ];
    }

    if (effectiveGroupMode === 'folder') {
      return groupHomeItemsByFolder(filteredServers, {
        keyPrefix: 'server',
        noFolderTitle: t('home.groupNoFolder'),
        sortItems: sortServers,
      });
    }

    if (effectiveGroupMode === 'tag') {
      const tagNameSet = new Set<string>();
      filteredServers.forEach((server) => {
        (server.tags ?? []).forEach((tag) => {
          /* Exclude the internal "favorite" tag from visible tag groups */
          if (!isFavoriteTag(tag.name)) {
            tagNameSet.add(tag.name);
          }
        });
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

      /* Servers whose only tag is the hidden "favorite" tag are treated as untagged */
      const untaggedItems = sortServers(
        filteredServers.filter((server) => {
          const visibleTags = (server.tags ?? []).filter((tag) => !isFavoriteTag(tag.name));
          return visibleTags.length === 0;
        }),
      );

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
  }, [activeFolderId, filteredServers, sortServers, sshViewPreference.groupMode]);

  const sortKeychains = React.useCallback(
    (items: SshKeychainListItem[]): SshKeychainListItem[] => {
      return [...items].sort((left, right) => {
        if (keychainViewPreference.sortMode === 'nameAsc') {
          return left.name.localeCompare(right.name);
        }

        if (keychainViewPreference.sortMode === 'nameDesc') {
          return right.name.localeCompare(left.name);
        }

        if (keychainViewPreference.sortMode === 'createdAt') {
          return getKeychainTimestamp(right, 'createdAt') - getKeychainTimestamp(left, 'createdAt');
        }

        return getKeychainTimestamp(right, 'updatedAt') - getKeychainTimestamp(left, 'updatedAt');
      });
    },
    [keychainViewPreference.sortMode],
  );

  const groupedKeychains = React.useMemo<KeychainGroup[]>(() => {
    const effectiveGroupMode =
      keychainViewPreference.groupMode === 'folder' && activeFolderId !== 'all'
        ? 'none'
        : keychainViewPreference.groupMode;

    if (effectiveGroupMode === 'none') {
      return [
        {
          key: 'keychain:ungrouped:all',
          title: '',
          items: sortKeychains(filteredKeychains),
        },
      ];
    }

    if (effectiveGroupMode === 'folder') {
      return groupHomeItemsByFolder(filteredKeychains, {
        keyPrefix: 'keychain',
        noFolderTitle: t('home.groupNoFolder'),
        sortItems: sortKeychains,
      });
    }

    if (effectiveGroupMode === 'tag') {
      const tagNameSet = new Set<string>();
      filteredKeychains.forEach((keychain) => {
        (keychain.tags ?? []).forEach((tag) => {
          if (!isFavoriteTag(tag.name)) {
            tagNameSet.add(tag.name);
          }
        });
      });

      const tagGroups = Array.from(tagNameSet)
        .sort((left, right) => left.localeCompare(right))
        .map((tagName) => {
          const items = filteredKeychains.filter((keychain) =>
            (keychain.tags ?? []).some((tag) => tag.name === tagName),
          );

          return {
            key: `keychain:tag:${tagName}`,
            title: tagName,
            items: sortKeychains(items),
          };
        })
        .filter((group) => group.items.length > 0);

      const untaggedItems = sortKeychains(
        filteredKeychains.filter((keychain) => {
          const visibleTags = (keychain.tags ?? []).filter((tag) => !isFavoriteTag(tag.name));
          return visibleTags.length === 0;
        }),
      );

      if (untaggedItems.length > 0) {
        tagGroups.push({
          key: 'keychain:tag:untagged',
          title: t('home.tagUntagged'),
          items: untaggedItems,
        });
      }

      return tagGroups;
    }

    return [
      {
        key: 'keychain:last-used:recent',
        title: t('home.sectionRecentlyUpdated'),
        items: sortKeychains(filteredKeychains),
      },
    ].filter((group) => group.items.length > 0);
  }, [activeFolderId, filteredKeychains, keychainViewPreference.groupMode, sortKeychains]);

  const sortPortForwardRules = React.useCallback(
    (items: PortForwardRuleListItem[]): PortForwardRuleListItem[] => {
      return [...items].sort((left, right) => {
        if (portForwardingViewPreference.sortMode === 'nameAsc') {
          return left.name.localeCompare(right.name);
        }

        if (portForwardingViewPreference.sortMode === 'nameDesc') {
          return right.name.localeCompare(left.name);
        }

        if (portForwardingViewPreference.sortMode === 'createdAt') {
          return getPortForwardRuleTimestamp(right, 'createdAt') - getPortForwardRuleTimestamp(left, 'createdAt');
        }

        return getPortForwardRuleTimestamp(right, 'updatedAt') - getPortForwardRuleTimestamp(left, 'updatedAt');
      });
    },
    [portForwardingViewPreference.sortMode],
  );

  const groupedPortForwardRules = React.useMemo<PortForwardRuleGroup[]>(() => {
    if (portForwardingViewPreference.groupMode === 'none') {
      return [
        {
          key: 'port-forwarding:ungrouped:all',
          title: '',
          items: sortPortForwardRules(filteredPortForwardRules),
        },
      ].filter((group) => group.items.length > 0);
    }

    if (portForwardingViewPreference.groupMode === 'tag') {
      const groups: PortForwardRuleGroup[] = (['local', 'remote', 'dynamic'] as const)
        .map((type) => ({
          key: `port-forwarding:type:${type}`,
          title: resolvePortForwardTypeLabel(type),
          items: sortPortForwardRules(filteredPortForwardRules.filter((rule) => rule.type === type)),
        }))
        .filter((group) => group.items.length > 0);

      return groups;
    }

    return [
      {
        key: 'port-forwarding:status:running',
        title: t('home.portForwardingRunningGroup'),
        items: sortPortForwardRules(filteredPortForwardRules.filter((rule) => rule.runtime.status === 'running')),
      },
      {
        key: 'port-forwarding:status:stopped',
        title: t('home.portForwardingStoppedGroup'),
        items: sortPortForwardRules(filteredPortForwardRules.filter((rule) => rule.runtime.status !== 'running')),
      },
    ].filter((group) => group.items.length > 0);
  }, [filteredPortForwardRules, portForwardingViewPreference.groupMode, sortPortForwardRules]);

  const selectedGroupName = React.useMemo(() => {
    if (quickFilter === 'recent') {
      if (activeHomeMode === 'portForwarding') {
        return t('home.portForwardingRunningGroup');
      }

      return activeHomeMode === 'keychains'
        ? t('home.groupRecentlyUpdatedKeychains')
        : t('home.groupRecentConnections');
    }

    if (quickFilter === 'favorite') {
      return t('home.groupFavorite');
    }

    if (activeFolderId === 'all') {
      if (activeHomeMode === 'keychains') {
        return t('home.groupAllKeychains');
      }

      if (activeHomeMode === 'portForwarding') {
        return t('home.groupAllPortForwarding');
      }

      return t('home.groupAllHosts');
    }

    if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
      return t('home.groupLocalTerminals');
    }

    return folders.find((folder) => folder.id === activeFolderId)?.name ?? t('home.groupUntitled');
  }, [activeHomeMode, quickFilter, activeFolderId, folders]);

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

  const folderKeychainCountMap = React.useMemo(() => {
    const countMap = new Map<string, number>();
    keychains.forEach((keychain) => {
      const folderId = keychain.folder?.id;
      if (!folderId) {
        return;
      }

      countMap.set(folderId, (countMap.get(folderId) ?? 0) + 1);
    });

    return countMap;
  }, [keychains]);

  const folderPortForwardRuleCountMap = React.useMemo(() => {
    const countMap = new Map<string, number>();
    portForwardRules.forEach((rule) => {
      const folderId = serverById.get(rule.serverId)?.folder?.id;
      if (!folderId) {
        return;
      }

      countMap.set(folderId, (countMap.get(folderId) ?? 0) + 1);
    });

    return countMap;
  }, [portForwardRules, serverById]);

  const folderPortForwardRunningRuleCountMap = React.useMemo(() => {
    const countMap = new Map<string, number>();
    portForwardRules.forEach((rule) => {
      if (rule.runtime.status !== 'running') {
        return;
      }

      const folderId = serverById.get(rule.serverId)?.folder?.id;
      if (!folderId) {
        return;
      }

      countMap.set(folderId, (countMap.get(folderId) ?? 0) + 1);
    });

    return countMap;
  }, [portForwardRules, serverById]);

  const quickSidebarCards = React.useMemo<SidebarCardItem[]>(() => {
    const recentTitle =
      activeHomeMode === 'keychains'
        ? t('home.groupRecentlyUpdatedKeychains')
        : activeHomeMode === 'portForwarding'
          ? t('home.portForwardingRunningGroup')
          : t('home.groupRecentConnections');
    const recentItemCount =
      activeHomeMode === 'keychains'
        ? recentKeychains.length
        : activeHomeMode === 'portForwarding'
          ? runningPortForwardCount
          : recentCount;
    const favoriteItemCount =
      activeHomeMode === 'keychains' ? keychainFavoriteCount : activeHomeMode === 'portForwarding' ? 0 : favoriteCount;

    return [
      {
        key: 'quick:recent',
        title: recentTitle,
        subtitle: resolveHomeEntityCountLabel(activeEntityKind, recentItemCount),
        selected: quickFilter === 'recent',
        iconKey: 'Cloud',
        colorKey: 'blue',
        onClick: () => {
          setActiveFolderId('all');
          setQuickFilter('recent');
        },
      },
      {
        key: 'quick:favorite',
        title: t('home.groupFavorite'),
        subtitle: resolveHomeEntityCountLabel(activeEntityKind, favoriteItemCount),
        selected: quickFilter === 'favorite',
        iconKey: 'Database',
        colorKey: 'amber',
        onClick: () => {
          setActiveFolderId('all');
          setQuickFilter('favorite');
        },
      },
    ];
  }, [
    activeEntityKind,
    activeHomeMode,
    favoriteCount,
    keychainFavoriteCount,
    quickFilter,
    recentCount,
    recentKeychains.length,
    runningPortForwardCount,
  ]);

  const folderSidebarCards = React.useMemo<SidebarCardItem[]>(() => {
    const userFolders = folders.map((folder) => {
      const count =
        activeHomeMode === 'keychains'
          ? (folderKeychainCountMap.get(folder.id) ?? 0)
          : activeHomeMode === 'portForwarding'
            ? quickFilter === 'recent'
              ? (folderPortForwardRunningRuleCountMap.get(folder.id) ?? 0)
              : (folderPortForwardRuleCountMap.get(folder.id) ?? 0)
            : (folderServerCountMap.get(folder.id) ?? 0);
      const colorKey = isEntityColorKey(folder.colorKey) ? folder.colorKey : 'slate';

      return {
        key: `folder:${folder.id}`,
        folderId: folder.id,
        title: folder.name,
        subtitle: resolveHomeEntityCountLabel(activeEntityKind, count),
        selected: activeFolderId === folder.id,
        iconKey: folder.iconKey,
        colorKey,
        onClick: () => {
          setActiveFolderId(folder.id);
          setQuickFilter('none');
        },
      };
    });

    const localTerminalFolder =
      activeHomeMode === 'ssh'
        ? [
            {
              key: `folder:${LOCAL_TERMINAL_FOLDER_ID}`,
              folderId: LOCAL_TERMINAL_FOLDER_ID,
              title: t('home.groupLocalTerminals'),
              subtitle: t('home.hostCount', { count: localTerminalProfiles.length }),
              selected: activeFolderId === LOCAL_TERMINAL_FOLDER_ID,
              iconKey: 'HardDrive',
              colorKey: 'blue' as EntityColorKey,
              onClick: () => {
                setActiveFolderId(LOCAL_TERMINAL_FOLDER_ID);
                setQuickFilter('none');
              },
            },
          ]
        : [];

    return [...localTerminalFolder, ...userFolders];
  }, [
    activeEntityKind,
    activeFolderId,
    activeHomeMode,
    folderKeychainCountMap,
    folderPortForwardRuleCountMap,
    folderPortForwardRunningRuleCountMap,
    folderServerCountMap,
    folders,
    localTerminalProfiles.length,
    quickFilter,
  ]);

  const allSidebarCard = React.useMemo<SidebarCardItem>(() => {
    const count =
      activeHomeMode === 'keychains'
        ? keychains.length
        : activeHomeMode === 'portForwarding'
          ? portForwardRules.length
          : servers.length;
    const title =
      activeHomeMode === 'keychains'
        ? t('home.groupAllKeychains')
        : activeHomeMode === 'portForwarding'
          ? t('home.groupAllPortForwarding')
          : t('home.groupAllHosts');

    return {
      key: 'all',
      folderId: 'all',
      title,
      subtitle: resolveHomeEntityCountLabel(activeEntityKind, count),
      selected: activeFolderId === 'all' && quickFilter === 'none',
      iconKey: 'Folder',
      colorKey: 'slate',
      onClick: () => {
        setActiveFolderId('all');
        setQuickFilter('none');
      },
    };
  }, [
    activeEntityKind,
    activeFolderId,
    activeHomeMode,
    keychains.length,
    portForwardRules.length,
    quickFilter,
    servers.length,
  ]);

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

  const localTerminalGridNavigation = useDirectionalNavigation({
    itemCount: filteredLocalTerminalProfiles.length,
    columns: 3,
    initialIndex: 0,
  });

  const keychainGridEntries = React.useMemo(() => {
    return groupedKeychains.flatMap((group) => {
      return group.items.map((keychain) => ({
        key: `${group.key}:${keychain.id}`,
      }));
    });
  }, [groupedKeychains]);

  const keychainGridIndexMap = React.useMemo(() => {
    const indexMap = new Map<string, number>();
    keychainGridEntries.forEach((entry, index) => {
      indexMap.set(entry.key, index);
    });

    return indexMap;
  }, [keychainGridEntries]);

  const keychainGridNavigation = useDirectionalNavigation({
    itemCount: keychainGridEntries.length,
    columns: 3,
    initialIndex: 0,
  });

  React.useEffect(() => {
    if (servers.length > 0 && !portForwardRuleFormState.serverId) {
      setPortForwardRuleFormState((previous) => ({
        ...previous,
        serverId: servers[0]?.id ?? '',
      }));
    }
  }, [portForwardRuleFormState.serverId, servers]);

  const groupModeIcon = React.useMemo(() => {
    if (groupMode === 'folder') {
      return FolderOpen;
    }

    if (groupMode === 'tag') {
      return Tags;
    }

    if (groupMode === 'none') {
      return Network;
    }

    return Clock3;
  }, [groupMode]);

  const groupModeOptions = React.useMemo<Array<{ value: GroupMode; label: string }>>(() => {
    const values: GroupMode[] = canGroupByFolder ? ['none', 'folder', 'lastUsed', 'tag'] : ['none', 'lastUsed', 'tag'];

    return values.map((value) => ({
      value,
      label: resolveGroupModeLabel(activeHomeMode, value),
    }));
  }, [activeHomeMode, canGroupByFolder]);

  const setActiveGroupMode = React.useCallback(
    (nextGroupMode: GroupMode) => {
      updateActiveViewPreference({ groupMode: nextGroupMode });
    },
    [updateActiveViewPreference],
  );

  const setActiveSortMode = React.useCallback(
    (nextSortMode: SortMode) => {
      updateActiveViewPreference({ sortMode: nextSortMode });
    },
    [updateActiveViewPreference],
  );

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

  const {
    isServerEditorDialogOpen,
    activeServerEditorId,
    serverEditorInitialFolderId,
    openCreateServerDialog,
    openEditServerDialog,
    closeServerEditorDialog,
  } = useServerEditorDialogState({
    activeFolderId,
    servers,
    localTerminalFolderId: LOCAL_TERMINAL_FOLDER_ID,
    onServerNotFound: () => {
      notifyWarning(t('ssh.validationServerNotFound'));
    },
  });

  const openInNewTabShortcutLabel = React.useMemo(() => {
    const clickLabel = t('common.click');
    return isMacPlatform ? `⌘+${clickLabel}` : `Ctrl+${clickLabel}`;
  }, [isMacPlatform]);

  const {
    isKeychainEditorDialogOpen,
    activeKeychainEditorId,
    keychainEditorInitialFormState,
    openCreateKeychainDialog,
    openEditKeychainDialog,
    closeKeychainEditorDialog,
  } = useKeychainEditorDialogState({
    keychains,
    onKeychainNotFound: () => {
      notifyWarning(t('ssh.validationKeychainNotFound'));
    },
  });

  const openCreateKeychainFromHome = React.useCallback(() => {
    openCreateKeychainDialog(
      buildHomeKeychainInitialFormState({
        activeFolderId,
        quickFilter,
      }),
    );
  }, [activeFolderId, openCreateKeychainDialog, quickFilter]);

  const importPrivateKeyToNewKeychain = React.useCallback(async () => {
    const importedKey = await importPrivateKeyFromFile({
      onSuccess: notifySuccess,
      onError: notifyError,
      importSuccessMessage: t('ssh.privateKeyImportSuccess'),
      importFailedMessage: t('ssh.privateKeyImportFailed'),
    });

    if (!importedKey) {
      return;
    }

    openCreateKeychainDialog(
      buildHomeKeychainInitialFormState({
        activeFolderId,
        quickFilter,
        importedKey,
      }),
    );
  }, [activeFolderId, notifyError, notifySuccess, openCreateKeychainDialog, quickFilter]);

  const openCreatePortForwardRuleDialog = React.useCallback(() => {
    setActivePortForwardRuleDraft(null);
    setPortForwardRuleDialogMode('create');
    setPortForwardRuleFormState(createDefaultPortForwardRuleFormState(servers));
    setIsPortForwardRuleDialogOpen(true);
  }, [servers]);

  const openEditPortForwardRuleDialog = React.useCallback(
    (rule: PortForwardRuleListItem) => {
      if (rule.runtime.status === 'running') {
        notifyWarning(t('home.portForwardingActiveEditDisabled'));
        return;
      }

      setActivePortForwardRuleDraft(rule);
      setPortForwardRuleDialogMode('edit');
      setPortForwardRuleFormState(createPortForwardRuleFormStateFromRule(rule));
      setIsPortForwardRuleDialogOpen(true);
    },
    [notifyWarning],
  );

  React.useEffect(() => {
    const pendingRuleId = pendingInitialPortForwardRuleIdRef.current;
    if (isLoading || errorMessage || !pendingRuleId) {
      return;
    }

    setActiveHomeMode('portForwarding');
    setActiveFolderId('all');
    setActiveTag('all');
    setQuickFilter('none');
    setSearch('');
    pendingInitialPortForwardRuleIdRef.current = null;

    const targetRule = portForwardRules.find((rule) => rule.id === pendingRuleId);
    if (!targetRule) {
      notifyWarning(t('home.portForwardingRuleNotFound'));
      return;
    }

    openEditPortForwardRuleDialog(targetRule);
  }, [errorMessage, isLoading, notifyWarning, openEditPortForwardRuleDialog, portForwardRules]);
  const openDeletePortForwardRuleDialog = React.useCallback(
    (rule: PortForwardRuleListItem) => {
      if (rule.runtime.status === 'running') {
        notifyWarning(t('home.portForwardingActiveDeleteDisabled'));
        return;
      }

      setActivePortForwardRuleDraft(rule);
      setIsDeletePortForwardRuleDialogOpen(true);
    },
    [notifyWarning],
  );

  const handleAddAction = React.useCallback(() => {
    if (activeHomeMode === 'keychains') {
      openCreateKeychainFromHome();
      return;
    }

    if (activeHomeMode === 'portForwarding') {
      openCreatePortForwardRuleDialog();
      return;
    }

    openCreateServerDialog();
  }, [activeHomeMode, openCreateKeychainFromHome, openCreatePortForwardRuleDialog, openCreateServerDialog]);

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

  const handleSubmitPortForwardRule = React.useCallback(async () => {
    if (!portForwardRuleFormState.serverId) {
      notifyWarning(t('home.portForwardingServerRequired'));
      return;
    }

    setIsPortForwardRuleSubmitting(true);
    try {
      const payload = buildPortForwardRulePayload(portForwardRuleFormState);

      if (portForwardRuleDialogMode === 'edit') {
        if (!activePortForwardRuleDraft) {
          return;
        }

        await updatePortForwardRule(activePortForwardRuleDraft.id, payload);
        notifySuccess(t('home.portForwardingUpdateSuccess'));
      } else {
        await createPortForwardRule(payload);
        notifySuccess(t('home.portForwardingCreateSuccess'));
      }

      setIsPortForwardRuleDialogOpen(false);
      await reloadHomeData();
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.portForwardingSaveFailed'));
    } finally {
      setIsPortForwardRuleSubmitting(false);
    }
  }, [
    activePortForwardRuleDraft,
    notifyError,
    notifySuccess,
    notifyWarning,
    portForwardRuleDialogMode,
    portForwardRuleFormState,
    reloadHomeData,
  ]);

  const handleStartPortForwardRule = React.useCallback(
    async (ruleId: string) => {
      try {
        const rule = portForwardRules.find((item) => item.id === ruleId);
        const server = rule ? servers.find((item) => item.id === rule.serverId) : undefined;
        if (!server) {
          throw new Error(t('home.portForwardingUnknownServer'));
        }

        const systemProxyRules = await resolveSystemProxyRulesForServer(server);
        const response = await startPortForwardRule(ruleId, { systemProxyRules });

        if (!response.success && response.code === 'SSH_HOST_UNTRUSTED' && 'data' in response) {
          setPortForwardHostFingerprintPrompt({
            ruleId,
            serverId: response.data.serverId,
            host: response.data.host,
            port: response.data.port,
            algorithm: response.data.algorithm,
            fingerprint: response.data.fingerprint,
          });
          return;
        }

        if (!response.success) {
          throw new Error(response.message);
        }

        setPortForwardRules((previousRules) =>
          previousRules.map((rule) => (rule.id === ruleId ? response.data.item : rule)),
        );
        notifySuccess(t('home.portForwardingStartSuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.portForwardingStartFailed'));
      }
    },
    [notifyError, notifySuccess, portForwardRules, servers],
  );

  const handleStopPortForwardRule = React.useCallback(
    async (ruleId: string) => {
      try {
        const response = await stopPortForwardRule(ruleId);
        setPortForwardRules((previousRules) =>
          previousRules.map((rule) => (rule.id === ruleId ? response.data.item : rule)),
        );
        notifySuccess(t('home.portForwardingStopSuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.portForwardingStopFailed'));
      }
    },
    [notifyError, notifySuccess],
  );

  const handleTrustPortForwardHostFingerprint = React.useCallback(
    async (accepted: boolean) => {
      const prompt = portForwardHostFingerprintPrompt;
      setPortForwardHostFingerprintPrompt(null);

      if (!prompt || !accepted) {
        return;
      }

      try {
        await trustSshFingerprint({
          serverId: prompt.serverId,
          fingerprintSha256: prompt.fingerprint,
          algorithm: prompt.algorithm,
        });
        await handleStartPortForwardRule(prompt.ruleId);
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.portForwardingStartFailed'));
      }
    },
    [handleStartPortForwardRule, notifyError, portForwardHostFingerprintPrompt],
  );

  const submitDeletePortForwardRule = React.useCallback(async () => {
    if (!activePortForwardRuleDraft) {
      return;
    }

    setIsPortForwardRuleDeleting(true);
    try {
      const deleted = await deletePortForwardRule(activePortForwardRuleDraft.id);
      if (!deleted.success) {
        throw new Error(t('home.portForwardingDeleteFailed'));
      }

      setIsDeletePortForwardRuleDialogOpen(false);
      await reloadHomeData();
      notifySuccess(t('home.portForwardingDeleteSuccess'));
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.portForwardingDeleteFailed'));
    } finally {
      setIsPortForwardRuleDeleting(false);
    }
  }, [activePortForwardRuleDraft, notifyError, notifySuccess, reloadHomeData]);

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

  const openEditFolderDialog = React.useCallback(
    (folderId: string, folderName: string, iconKey: string, colorKey: EntityColorKey) => {
      setActiveFolderDraft({ id: folderId, name: folderName, iconKey, colorKey });
      setFolderNameInput(folderName);
      setIsEditFolderDialogOpen(true);
    },
    [],
  );

  const openDeleteFolderDialog = React.useCallback(
    (folderId: string, folderName: string, iconKey: string, colorKey: EntityColorKey) => {
      setActiveFolderDraft({ id: folderId, name: folderName, iconKey, colorKey });
      setIsDeleteFolderDialogOpen(true);
    },
    [],
  );

  const openDeleteServerDialog = React.useCallback((serverId: string, serverName: string) => {
    setActiveServerDraft({ id: serverId, name: serverName });
    setIsDeleteServerDialogOpen(true);
  }, []);

  /**
   * Opens the destructive confirmation for a specific keychain.
   *
   * @param keychainId Keychain identifier selected from the card menu.
   * @param keychainName Keychain name shown in the confirmation copy.
   * @returns Nothing.
   */
  const openDeleteKeychainDialog = React.useCallback((keychainId: string, keychainName: string): void => {
    setActiveKeychainDraft({ id: keychainId, name: keychainName });
    setIsDeleteKeychainDialogOpen(true);
  }, []);

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
      await renameFolder(activeFolderDraft.id, folderName, {
        iconKey: activeFolderDraft.iconKey,
        colorKey: activeFolderDraft.colorKey,
      });
      setIsEditFolderDialogOpen(false);
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
      await reloadHomeData();
      notifySuccess(t('home.serverDeleteSuccess'));
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('home.serverDeleteFailed'));
    } finally {
      setIsServerDeleteSubmitting(false);
    }
  }, [activeServerDraft, notifyError, notifySuccess, reloadHomeData]);

  /**
   * Deletes the confirmed keychain and keeps the confirmation open when the backend rejects the request.
   *
   * @returns Resolves after the delete attempt and any required Home refresh complete.
   */
  const submitDeleteKeychain = React.useCallback(async (): Promise<void> => {
    if (!activeKeychainDraft) {
      return;
    }

    setIsKeychainDeleteSubmitting(true);
    try {
      const deleted = await deleteSshKeychain(activeKeychainDraft.id);
      if (!deleted.success) {
        throw new Error(t('sshKeychain.deleteFailed'));
      }

      setIsDeleteKeychainDialogOpen(false);
      await reloadHomeData();
      notifySuccess(t('sshKeychain.deleteSuccess'));
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('sshKeychain.deleteFailed'));
    } finally {
      setIsKeychainDeleteSubmitting(false);
    }
  }, [activeKeychainDraft, notifyError, notifySuccess, reloadHomeData]);

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
        await updateSshServer(serverId, buildServerUpdatePayload(targetServer, { folderId }));

        await reloadHomeData();
        setActiveFolderId(folderId);
        setQuickFilter('none');
        notifySuccess(t('home.dragServerToFolderSuccess'));
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.dragServerToFolderFailed'));
      }
    },
    [buildServerUpdatePayload, notifyError, notifySuccess, reloadHomeData, servers],
  );

  /**
   * Checks whether a server is marked as favorite based on its tags.
   * A server is considered favorite when any of its tags contains "favorite" (case-insensitive).
   */
  const isServerFavorite = React.useCallback((server: SshServerListItem): boolean => {
    return (server.tags ?? []).some((tag) => isFavoriteTag(tag.name));
  }, []);

  /**
   * Toggles the favorite status of a server.
   * - If the server is not favorited, finds or creates a "favorite" tag and assigns it.
   * - If the server is already favorited, removes the favorite tag from the server.
   *
   * @param server Server whose favorite state should change.
   * @returns Resolves after the favorite update and Home refresh complete.
   */
  const handleToggleServerFavorite = React.useCallback(
    async (server: SshServerListItem) => {
      try {
        const nextTagIds = await resolveNextFavoriteTagIds(server.tags ?? []);
        await updateSshServer(server.id, buildServerUpdatePayload(server, { tagIds: nextTagIds }));

        await reloadHomeData();
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.contextFavoriteFailed'));
      }
    },
    [buildServerUpdatePayload, notifyError, reloadHomeData],
  );

  /**
   * Toggles a keychain favorite tag through a metadata-only update.
   *
   * @param keychain Keychain whose favorite state should change.
   * @returns Resolves after the favorite update and Home refresh complete.
   */
  const handleToggleKeychainFavorite = React.useCallback(
    async (keychain: SshKeychainListItem): Promise<void> => {
      try {
        const nextTagIds = await resolveNextFavoriteTagIds(keychain.tags ?? []);
        await updateSshKeychain(keychain.id, buildKeychainMetadataUpdatePayload(keychain, nextTagIds));
        await reloadHomeData();
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('home.contextFavoriteFailed'));
      }
    },
    [notifyError, reloadHomeData],
  );

  const handleHomeModeChange = React.useCallback(
    (mode: HomeMode) => {
      setActiveHomeMode(mode);
      if (mode !== 'ssh') {
        setActiveFolderId((currentFolderId) =>
          currentFolderId === LOCAL_TERMINAL_FOLDER_ID ? 'all' : currentFolderId,
        );
        if (activeFolderId === LOCAL_TERMINAL_FOLDER_ID) {
          setQuickFilter('none');
        }
      }
    },
    [activeFolderId],
  );

  const tagFilterItems = React.useMemo(() => {
    return tags.map((tagName) => ({
      value: tagName,
      label: tagName === 'all' ? selectedGroupName : tagName,
      isScopeFilter: tagName === 'all',
    }));
  }, [selectedGroupName, tags]);

  return (
    <SplitWorkbenchLayout
      topSlot={
        <h1 className="px-2 pb-2 text-[28px] font-semibold text-header-text">
          {t('home.greetingWithUser', { greeting, name: runtimeUserName })}
        </h1>
      }
      sidebar={
        <div className="gutter-box-y min-h-0 flex-1 overflow-auto pb-2">
          <HomeModeTabs
            activeMode={activeHomeMode}
            onModeChange={handleHomeModeChange}
          />
          <div>
            <div className="pb-5">
              <div className="px-2 pb-2.5 text-xs font-medium text-home-text-subtle">{t('home.groupAll')}</div>
              <EntityCard
                title={allSidebarCard.title}
                subtitle={allSidebarCard.subtitle}
                selected={allSidebarCard.selected}
                icon={createEntityIconNode(
                  { iconKey: allSidebarCard.iconKey, colorKey: allSidebarCard.colorKey },
                  allSidebarCard.title,
                )}
                onClick={allSidebarCard.onClick}
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
                    icon={createEntityIconNode({ iconKey: item.iconKey, colorKey: item.colorKey }, item.title)}
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
                        icon={createEntityIconNode({ iconKey: item.iconKey, colorKey: item.colorKey }, item.title)}
                        onDragOver={(event) => {
                          if (
                            activeHomeMode !== 'ssh' ||
                            !item.folderId ||
                            item.folderId === LOCAL_TERMINAL_FOLDER_ID ||
                            !draggingServerId
                          ) {
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
                          if (
                            activeHomeMode !== 'ssh' ||
                            !item.folderId ||
                            item.folderId === LOCAL_TERMINAL_FOLDER_ID
                          ) {
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

                          openEditFolderDialog(folderId, item.title, item.iconKey, item.colorKey);
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

                          openDeleteFolderDialog(folderId, item.title, item.iconKey, item.colorKey);
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
        </div>
      }
      main={
        <SplitWorkbenchMainPanel
          mode="panel-scroll"
          header={
            <div className="flex items-center justify-between gap-4 ps-2">
              <div className="min-w-0 flex-1">
                <MenuToggleGroup
                  type="single"
                  value={activeTag}
                  className="-ms-1 max-w-full overflow-x-auto"
                  onValueChange={(value) => {
                    if (value) {
                      setActiveTag(value);
                    }
                  }}
                >
                  {tagFilterItems.map((tag) => (
                    <MenuToggleGroupItem
                      key={tag.value}
                      value={tag.value}
                      className={classNames(tag.isScopeFilter && 'font-semibold')}
                    >
                      {tag.label}
                    </MenuToggleGroupItem>
                  ))}
                </MenuToggleGroup>
              </div>

              <div className="flex shrink-0 items-center">
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
                        <DropdownMenuRadioGroup
                          value={groupMode}
                          onValueChange={(value) => setActiveGroupMode(value as GroupMode)}
                        >
                          {groupModeOptions.map((option) => (
                            <DropdownMenuRadioItem
                              key={option.value}
                              value={option.value}
                            >
                              {option.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
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
                        <DropdownMenuRadioGroup
                          value={sortMode}
                          onValueChange={(value) => setActiveSortMode(value as SortMode)}
                        >
                          <DropdownMenuRadioItem value="nameAsc">{t('home.sortByNameAsc')}</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="nameDesc">{t('home.sortByNameDesc')}</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="lastUsed">{t('home.sortByLastUsed')}</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="createdAt">{t('home.sortByCreatedAt')}</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <MenubarSeparator vertical />

                    {activeHomeMode === 'portForwarding' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('home.portForwardingNewRuleAction')}
                            className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
                            onClick={handleAddAction}
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{t('home.portForwardingNewRuleAction')}</TooltipContent>
                      </Tooltip>
                    ) : (
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
                            icon={activeHomeMode === 'keychains' ? KeyRound : Server}
                            onSelect={handleAddAction}
                          >
                            {activeHomeMode === 'keychains' ? t('sshKeychain.newKeychain') : t('home.quickAddServer')}
                          </DropdownMenuItem>
                          {activeHomeMode === 'keychains' ? (
                            <>
                              <DropdownMenuItem
                                icon={FileUp}
                                onSelect={() => {
                                  void importPrivateKeyToNewKeychain();
                                }}
                              >
                                {t('sshKeychain.importKeyAction')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          <DropdownMenuItem
                            icon={FolderPlus}
                            onSelect={() => createFolderDialog.openCreateFolderDialog()}
                          >
                            {t('home.quickAddFolder')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </Menubar>
                </TooltipProvider>
              </div>
            </div>
          }
          body={
            <>
              {isLoading ? <div className="text-home-text-subtle">{t('home.loading')}</div> : null}
              {errorMessage ? <div className="text-form-message-error">{errorMessage}</div> : null}

              {!isLoading && !errorMessage ? (
                activeHomeMode === 'portForwarding' ? (
                  <HomePortForwardingContent
                    groups={groupedPortForwardRules}
                    servers={servers}
                    onStartRule={(ruleId) => {
                      void handleStartPortForwardRule(ruleId);
                    }}
                    onStopRule={(ruleId) => {
                      void handleStopPortForwardRule(ruleId);
                    }}
                    onEditRule={openEditPortForwardRuleDialog}
                    onDeleteRule={openDeletePortForwardRuleDialog}
                    onCopyToClipboard={(value) => {
                      void handleCopyToClipboard(value);
                    }}
                  />
                ) : activeHomeMode === 'keychains' ? (
                  <HomeKeychainsContent
                    groups={groupedKeychains}
                    gridIndexMap={keychainGridIndexMap}
                    gridNavigation={keychainGridNavigation}
                    onToggleFavorite={(keychain) => {
                      void handleToggleKeychainFavorite(keychain);
                    }}
                    onCopyKeychainName={(keychainName) => {
                      void handleCopyToClipboard(keychainName);
                    }}
                    onEditKeychain={openEditKeychainDialog}
                    onDeleteKeychain={openDeleteKeychainDialog}
                  />
                ) : (
                  <HomeSshContent
                    activeFolderId={activeFolderId}
                    groupedServers={groupedServers}
                    filteredLocalTerminalProfiles={filteredLocalTerminalProfiles}
                    localTerminalGridNavigation={localTerminalGridNavigation}
                    serverGridIndexMap={serverGridIndexMap}
                    serverGridNavigation={serverGridNavigation}
                    draggingServerId={draggingServerId}
                    showFullServerAddress={showFullServerAddress}
                    localTerminalFileManagerLabel={localTerminalFileManagerLabel}
                    openInNewTabShortcutLabel={openInNewTabShortcutLabel}
                    isServerFavorite={isServerFavorite}
                    onOpenSSH={onOpenSSH}
                    onOpenSFTP={onOpenSFTP}
                    onShowInFileManager={(targetPath) => {
                      void handleShowInFileManager(targetPath);
                    }}
                    onOpenServerFromCard={openServerFromCard}
                    onSetDraggingServerId={setDraggingServerId}
                    onSetDragOverFolderId={setDragOverFolderId}
                    onToggleFavorite={(server) => {
                      void handleToggleServerFavorite(server);
                    }}
                    onCopyToClipboard={(value) => {
                      void handleCopyToClipboard(value);
                    }}
                    onEditServer={openEditServerDialog}
                    onDeleteServer={openDeleteServerDialog}
                  />
                )
              ) : null}

              {!isLoading &&
              !errorMessage &&
              activeHomeMode === 'ssh' &&
              activeFolderId !== LOCAL_TERMINAL_FOLDER_ID &&
              filteredServers.length === 0 ? (
                <HomeEmptyState
                  text={t('home.empty')}
                  icon={PackageOpen}
                />
              ) : null}

              {!isLoading &&
              !errorMessage &&
              activeHomeMode === 'ssh' &&
              activeFolderId === LOCAL_TERMINAL_FOLDER_ID &&
              filteredLocalTerminalProfiles.length === 0 ? (
                <HomeEmptyState
                  text={t('home.empty')}
                  icon={PackageOpen}
                />
              ) : null}

              {!isLoading && !errorMessage && activeHomeMode === 'keychains' && filteredKeychains.length === 0 ? (
                <HomeEmptyState
                  text={t('sshKeychain.empty')}
                  icon={PackageOpen}
                />
              ) : null}
            </>
          }
        />
      }
    >
      <CreateFolderDialog
        open={createFolderDialog.isOpen}
        folderName={createFolderDialog.folderName}
        visual={createFolderDialog.folderVisual}
        isSubmitting={createFolderDialog.isSubmitting}
        onOpenChange={createFolderDialog.onOpenChange}
        onExitComplete={createFolderDialog.onExitComplete}
        onFolderNameChange={createFolderDialog.setFolderName}
        onVisualChange={createFolderDialog.setFolderVisual}
        onSubmit={() => {
          void createFolderDialog.submitCreateFolder();
        }}
      />

      <SSHServerEditorDialog
        open={isServerEditorDialogOpen}
        serverId={activeServerEditorId}
        initialFolderId={serverEditorInitialFolderId}
        servers={servers}
        folders={folders}
        defaultServerNoteTemplate={defaultServerNoteTemplate}
        onOpenChange={(open) => {
          if (!open) {
            closeServerEditorDialog();
          }
        }}
        onSaved={reloadHomeData}
      />

      <SSHKeychainEditorDialog
        open={isKeychainEditorDialogOpen}
        keychainId={activeKeychainEditorId}
        initialFormState={keychainEditorInitialFormState}
        onOpenChange={(open) => {
          if (!open) {
            closeKeychainEditorDialog();
          }
        }}
        onSaved={async () => {
          await reloadHomeData();
        }}
      />

      <PortForwardRuleDialog
        open={isPortForwardRuleDialogOpen}
        mode={portForwardRuleDialogMode}
        formState={portForwardRuleFormState}
        servers={servers}
        isSubmitting={isPortForwardRuleSubmitting}
        onOpenChange={setIsPortForwardRuleDialogOpen}
        onExitComplete={() => {
          if (!isDeletePortForwardRuleDialogOpen) {
            setActivePortForwardRuleDraft(null);
          }
        }}
        onFormStateChange={setPortForwardRuleFormState}
        onSubmit={() => {
          void handleSubmitPortForwardRule();
        }}
      />

      <Dialog
        open={portForwardHostFingerprintPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            void handleTrustPortForwardHostFingerprint(false);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          onExitComplete={clearExitPortForwardHostFingerprintPrompt}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            void handleTrustPortForwardHostFingerprint(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('ssh.hostFingerprintDialogTitle')}</DialogTitle>
            <DialogDescription>{t('ssh.hostFingerprintDialogDescription')}</DialogDescription>
          </DialogHeader>

          {exitPortForwardHostFingerprintPrompt ? (
            <div className="bg-home-card/70 space-y-2 rounded-lg border border-home-divider p-3 text-sm">
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogHost')}: </span>
                <span className="text-home-text font-medium">
                  {exitPortForwardHostFingerprintPrompt.host}:{exitPortForwardHostFingerprintPrompt.port}
                </span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogAlgorithm')}: </span>
                <span className="text-home-text font-medium">{exitPortForwardHostFingerprintPrompt.algorithm}</span>
              </div>
              <div>
                <span className="text-home-text-subtle">{t('ssh.hostFingerprintDialogFingerprint')}: </span>
                <span className="break-all font-mono text-xs">{exitPortForwardHostFingerprintPrompt.fingerprint}</span>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <DialogSecondaryButton
              onClick={() => {
                void handleTrustPortForwardHostFingerprint(false);
              }}
            >
              {t('ssh.hostFingerprintDialogCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              onClick={() => {
                void handleTrustPortForwardHostFingerprint(true);
              }}
            >
              {t('ssh.hostFingerprintDialogTrustContinue')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isEditFolderDialogOpen}
        onOpenChange={setIsEditFolderDialogOpen}
      >
        <DialogContent
          onExitComplete={() => {
            if (!isDeleteFolderDialogOpen) {
              setFolderNameInput('');
              setActiveFolderDraft(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('home.contextEditFolder')}</DialogTitle>
            <DialogDescription>{t('home.dialogEditFolderDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <EntityVisualPicker
              visual={
                activeFolderDraft
                  ? { iconKey: activeFolderDraft.iconKey, colorKey: activeFolderDraft.colorKey }
                  : { iconKey: 'Folder', colorKey: 'slate' }
              }
              label={t('home.iconSearchPlaceholder')}
              onChange={(nextVisual: { iconKey: string; colorKey: EntityColorKey }) => {
                setActiveFolderDraft((previous) => {
                  if (!previous) {
                    return previous;
                  }

                  return {
                    ...previous,
                    iconKey: nextVisual.iconKey,
                    colorKey: nextVisual.colorKey,
                  };
                });
              }}
            >
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-9 shrink-0 rounded-sm-2 p-0"
                aria-label={t('home.editVisual')}
              >
                <EntityIcon
                  icon={createEntityIconNode(
                    {
                      iconKey: activeFolderDraft?.iconKey ?? 'Folder',
                      colorKey: activeFolderDraft?.colorKey ?? 'slate',
                    },
                    t('home.editVisual'),
                  )}
                  tone="flat"
                />
              </Button>
            </EntityVisualPicker>
            <Input
              value={folderNameInput}
              placeholder={t('home.folderNamePlaceholder')}
              onChange={(event) => setFolderNameInput(event.target.value)}
            />
          </div>
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
        <AlertDialogContent
          onExitComplete={() => {
            if (!isEditFolderDialogOpen) {
              setFolderNameInput('');
              setActiveFolderDraft(null);
            }
          }}
        >
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
        <AlertDialogContent onExitComplete={() => setActiveServerDraft(null)}>
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

      <AlertDialog
        open={isDeleteKeychainDialogOpen}
        onOpenChange={setIsDeleteKeychainDialogOpen}
      >
        <AlertDialogContent onExitComplete={() => setActiveKeychainDraft(null)}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sshKeychain.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sshKeychain.deleteConfirmDescription', { name: activeKeychainDraft?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancelButton disabled={isKeychainDeleteSubmitting}>
              {t('home.actionCancel')}
            </AlertDialogCancelButton>
            <AlertDialogActionButton
              disabled={isKeychainDeleteSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void submitDeleteKeychain();
              }}
            >
              {t('home.contextDelete')}
            </AlertDialogActionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isDeletePortForwardRuleDialogOpen}
        onOpenChange={setIsDeletePortForwardRuleDialogOpen}
      >
        <AlertDialogContent
          onExitComplete={() => {
            if (!isPortForwardRuleDialogOpen) {
              setActivePortForwardRuleDraft(null);
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('home.portForwardingDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('home.portForwardingDeleteDescription', { name: activePortForwardRuleDraft?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancelButton disabled={isPortForwardRuleDeleting}>
              {t('home.actionCancel')}
            </AlertDialogCancelButton>
            <AlertDialogActionButton
              disabled={isPortForwardRuleDeleting}
              onClick={(event) => {
                event.preventDefault();
                void submitDeletePortForwardRule();
              }}
            >
              {t('home.contextDelete')}
            </AlertDialogActionButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SplitWorkbenchLayout>
  );
};

export default Home;
