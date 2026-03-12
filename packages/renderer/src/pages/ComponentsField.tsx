import classNames from 'classnames';
import {
  Clock3,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Link2,
  Pin,
  PlugZap,
  RefreshCw,
  Server,
  Terminal,
} from 'lucide-react';
import React from 'react';

import {
  AlertDialog,
  AlertDialogActionButton,
  AlertDialogCancelButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { CommandPalette, CommandPaletteItem } from '../components/ui/command-palette';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Form, FormControl, FormField, FormLabel, FormMessage } from '../components/ui/form';
import { formStyles } from '../components/ui/form-styles';
import { Input } from '../components/ui/input';
import { InputContextMenuItem, InputMenuTarget } from '../components/ui/input-context-menu-registry';
import { Label } from '../components/ui/label';
import { menuStyles } from '../components/ui/menu-styles';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '../components/ui/menubar';
import { PasswordField } from '../components/ui/password-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { getLocale, setLocale, t } from '../lib/i18n';
import { useToast } from '../lib/toast-context';

const ComponentsField: React.FC = () => {
  const {
    error: notifyError,
    info: notifyInfo,
    push: pushToast,
    success: notifySuccess,
    warning: notifyWarning,
  } = useToast();
  const [checked, setChecked] = React.useState<boolean>(true);
  const [compactMode, setCompactMode] = React.useState<boolean>(false);
  const [density, setDensity] = React.useState<string>('compact');
  const [profile, setProfile] = React.useState<string>('prod');
  const [sshMode, setSshMode] = React.useState<string>('shell');
  const [locale, setLocaleState] = React.useState<'en' | 'zh-CN'>(getLocale());
  const [host, setHost] = React.useState<string>('node-a.prod');
  const [port, setPort] = React.useState<string>('22');
  const [username, setUsername] = React.useState<string>('root');
  const [password, setPassword] = React.useState<string>('');
  const [privateKey, setPrivateKey] = React.useState<string>('');
  const [alias, setAlias] = React.useState<string>('prod-main');
  const [strictHostKey, setStrictHostKey] = React.useState<boolean>(true);
  const [enableCompression, setEnableCompression] = React.useState<boolean>(false);
  const [connectionTimeout, setConnectionTimeout] = React.useState<number[]>([45]);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = React.useState<boolean>(true);
  const [commandQuery, setCommandQuery] = React.useState<string>('ssh');
  const [commandShowInput, setCommandShowInput] = React.useState<boolean>(true);
  const [commandInputIconMode, setCommandInputIconMode] = React.useState<'search' | 'terminal' | 'server'>('search');
  const [commandMetadataLayout, setCommandMetadataLayout] = React.useState<'stacked' | 'inline'>('stacked');
  const [commandCloseOnEsc, setCommandCloseOnEsc] = React.useState<boolean>(false);
  const [commandMixedIcons, setCommandMixedIcons] = React.useState<boolean>(true);
  const [commandAllNoIcons, setCommandAllNoIcons] = React.useState<boolean>(false);
  const [commandEnableManyItems, setCommandEnableManyItems] = React.useState<boolean>(false);

  const handleToggleLocale = React.useCallback(async () => {
    const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
    const syncedLocale = await setLocale(nextLocale);
    setLocaleState(syncedLocale);
  }, [locale]);

  const handleSshFormSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  }, []);

  const hostContextMenuItems = React.useMemo<InputContextMenuItem[]>(
    () => [
      {
        key: 'insert-host-template',
        label: 'Insert Host Template',
        onSelect: (target: InputMenuTarget) => {
          target.focus({ preventScroll: true });
          target.setRangeText('node-{env}.prod', target.selectionStart ?? 0, target.selectionEnd ?? 0, 'end');
        },
      },
      {
        key: 'normalize-host-lowercase',
        label: 'Normalize to Lowercase',
        onSelect: (target: InputMenuTarget) => {
          target.value = target.value.toLowerCase();
          target.dispatchEvent(new Event('input', { bubbles: true }));
        },
      },
    ],
    [],
  );

  const keyContextMenuItems = React.useMemo<InputContextMenuItem[]>(
    () => [
      {
        key: 'insert-fake-key-header',
        label: 'Insert Key Header',
        onSelect: (target: InputMenuTarget) => {
          target.focus({ preventScroll: true });
          target.setRangeText(
            '-----BEGIN OPENSSH PRIVATE KEY-----\n',
            target.selectionStart ?? 0,
            target.selectionEnd ?? 0,
            'end',
          );
        },
      },
    ],
    [],
  );

  const formatSamples = [
    t('home.formatNamed', { name: 'agou', profile: 'prod' }),
    t('home.formatPrintf', [58, 'ok']),
    t('home.formatIndexed', ['node-a', 3]),
    t('home.pluralSessions', { count: 0 }),
    t('home.pluralSessions', { count: 1 }),
    t('home.pluralSessions', { count: 3 }),
  ];

  const commandItems = React.useMemo<CommandPaletteItem[]>(() => {
    const resolveItemIcon = (icon: React.ReactNode, allowMixedWithoutIcon = false): React.ReactNode | undefined => {
      if (commandAllNoIcons) {
        return undefined;
      }

      if (allowMixedWithoutIcon && commandMixedIcons) {
        return undefined;
      }

      return icon;
    };

    const baseItems: CommandPaletteItem[] = [
      {
        key: 'connect-current-host',
        icon: resolveItemIcon(<Server className="h-4 w-4" />),
        title: 'Connect: node-a.prod',
        titleTooltip: 'Connect to node-a.prod via SSH using the saved profile.',
        subtitle: 'SSH Session',
        onSelect: () => notifySuccess('Connecting to node-a.prod...'),
        actions: [
          {
            key: 'pin-connect-current-host',
            icon: <Pin className="h-3.5 w-3.5" />,
            tooltip: 'Pin command',
            onSelect: () => notifyInfo('Pinned command: Connect node-a.prod'),
          },
        ],
      },
      {
        key: 'open-sftp-current-host',
        icon: resolveItemIcon(<HardDrive className="h-4 w-4" />),
        title: 'Open SFTP: node-a.prod',
        subtitle: 'File Transfer',
        onSelect: () => notifyInfo('Opening SFTP panel for node-a.prod.'),
        actions: [
          {
            key: 'copy-sftp-path',
            icon: <Link2 className="h-3.5 w-3.5" />,
            tooltip: 'Copy remote path',
            onSelect: () => notifySuccess('Copied remote path /var/www to clipboard.'),
          },
        ],
      },
      {
        key: 'reconnect-last-session',
        icon: resolveItemIcon(<RefreshCw className="h-4 w-4" />, true),
        title: 'Reconnect Last Session',
        subtitle: 'Recent Command',
        onSelect: () => notifyInfo('Reconnecting to the last active session.'),
      },
      {
        key: 'open-session-log',
        icon: resolveItemIcon(<FileText className="h-4 w-4" />),
        title: 'Open Session Log',
        subtitle: 'Diagnostics',
        onSelect: () => notifyInfo('Opening session log viewer.'),
        actions: [
          {
            key: 'pin-open-session-log',
            icon: <Pin className="h-3.5 w-3.5" />,
            tooltip: 'Pin command',
            onSelect: () => notifyInfo('Pinned command: Open Session Log'),
          },
        ],
      },
      {
        key: 'switch-profile-prod',
        icon: resolveItemIcon(<Clock3 className="h-4 w-4" />),
        title: 'Switch Profile: prod',
        subtitle: 'Workspace Profile',
        onSelect: () => notifySuccess('Switched active profile to prod.'),
      },
    ];

    if (!commandEnableManyItems) {
      return baseItems;
    }

    const bulkItems: CommandPaletteItem[] = Array.from({ length: 28 }, (_, index) => {
      const itemIndex = index + 1;

      return {
        key: `bulk-command-${itemIndex}`,
        icon: resolveItemIcon(<Terminal className="h-4 w-4" />),
        title: `Bulk Command ${itemIndex}`,
        subtitle: `Scroll Test Item ${itemIndex}`,
        onSelect: () => notifyInfo(`Executed bulk command ${itemIndex}.`),
      };
    });

    return [...baseItems, ...bulkItems];
  }, [commandAllNoIcons, commandEnableManyItems, commandMixedIcons, notifyInfo, notifySuccess]);

  const commandInputLeadingIcon = React.useMemo<React.ReactNode>(() => {
    if (commandInputIconMode === 'terminal') {
      return <Terminal className="h-4 w-4 shrink-0 text-command-text-muted" />;
    }

    if (commandInputIconMode === 'server') {
      return <Server className="h-4 w-4 shrink-0 text-command-text-muted" />;
    }

    return undefined;
  }, [commandInputIconMode]);

  const filteredCommandItems = React.useMemo<CommandPaletteItem[]>(() => {
    const normalizedQuery = commandQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return commandItems;
    }

    return commandItems.filter((item) => {
      const haystack = `${item.title} ${item.subtitle ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [commandItems, commandQuery]);

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg font-semibold">{t('componentsPlayground.title')}</div>

      <div className="rounded-md bg-bg-subtle p-3 shadow-soft backdrop-blur-[4px]">
        <div className="mb-1 text-sm font-semibold">Command Palette Playground</div>
        <div className="text-xs text-header-text-muted">Fixed center on x-axis, top offset locked at 50px.</div>

        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="flex items-center gap-2">
              <Switch
                id="command-palette-open"
                checked={isCommandPaletteOpen}
                onCheckedChange={setIsCommandPaletteOpen}
              />
              <Label
                htmlFor="command-palette-open"
                className={formStyles.inlineLabel}
              >
                Open State
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="command-close-on-esc"
                checked={commandCloseOnEsc}
                onCheckedChange={setCommandCloseOnEsc}
              />
              <Label
                htmlFor="command-close-on-esc"
                className={formStyles.inlineLabel}
              >
                Close on Esc
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="command-show-input"
                checked={commandShowInput}
                onCheckedChange={(checkedState) => {
                  setCommandShowInput(checkedState);

                  if (!checkedState) {
                    setCommandQuery('');
                  }
                }}
              />
              <Label
                htmlFor="command-show-input"
                className={formStyles.inlineLabel}
              >
                Show Input
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="command-mixed-icons"
                checked={commandMixedIcons}
                onCheckedChange={(checkedState) => setCommandMixedIcons(checkedState === true)}
              />
              <Label
                htmlFor="command-mixed-icons"
                className={formStyles.inlineLabel}
              >
                Mixed Item Icons
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="command-all-no-icons"
                checked={commandAllNoIcons}
                onCheckedChange={(checkedState) => setCommandAllNoIcons(checkedState === true)}
              />
              <Label
                htmlFor="command-all-no-icons"
                className={formStyles.inlineLabel}
              >
                All Items Without Icons
              </Label>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="command-many-items"
                checked={commandEnableManyItems}
                onCheckedChange={(checkedState) => setCommandEnableManyItems(checkedState === true)}
              />
              <Label
                htmlFor="command-many-items"
                className={formStyles.inlineLabel}
              >
                More Items (Scroll Test)
              </Label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField className="gap-1.5">
              <FormLabel className={formStyles.inlineLabel}>Input Leading Icon</FormLabel>
              <Select
                value={commandInputIconMode}
                onValueChange={(value) => setCommandInputIconMode(value as 'search' | 'terminal' | 'server')}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select icon" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="search"
                    icon={Terminal}
                  >
                    Search (Default)
                  </SelectItem>
                  <SelectItem
                    value="terminal"
                    icon={Terminal}
                  >
                    Terminal
                  </SelectItem>
                  <SelectItem
                    value="server"
                    icon={Server}
                  >
                    Server
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField className="gap-1.5">
              <FormLabel className={formStyles.inlineLabel}>Title + Description Layout</FormLabel>
              <Select
                value={commandMetadataLayout}
                onValueChange={(value) => setCommandMetadataLayout(value as 'stacked' | 'inline')}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select layout" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="stacked"
                    icon={Terminal}
                  >
                    Stacked
                  </SelectItem>
                  <SelectItem
                    value="inline"
                    icon={Terminal}
                  >
                    Inline (Horizontal)
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="rounded-lg bg-form-control px-2.5 py-2 text-xs text-form-text-muted">
            Palette row/input baseline: height 34px, radius 14px (aligned with Input controls).
          </div>
        </div>
      </div>

      <CommandPalette
        open={isCommandPaletteOpen}
        query={commandQuery}
        placeholder="Type a command or search by keyword"
        items={filteredCommandItems}
        emptyText="No commands found"
        showInput={commandShowInput}
        inputLeadingIcon={commandInputLeadingIcon}
        metadataLayout={commandMetadataLayout}
        closeOnEsc={commandCloseOnEsc}
        onOpenChange={setIsCommandPaletteOpen}
        onQueryChange={setCommandQuery}
      />

      <Form
        className="grid gap-3"
        onSubmit={handleSshFormSubmit}
      >
        <FormField>
          <FormLabel htmlFor="ssh-host">Host</FormLabel>
          <FormControl>
            <Input
              id="ssh-host"
              value={host}
              placeholder="server.example.com"
              contextMenuItems={hostContextMenuItems}
              onChange={(event) => setHost(event.target.value)}
            />
          </FormControl>
        </FormField>

        <FormField>
          <FormLabel htmlFor="ssh-alias">Alias</FormLabel>
          <FormControl>
            <Input
              id="ssh-alias"
              value={alias}
              placeholder="production-main"
              contextMenuItems={hostContextMenuItems}
              onChange={(event) => setAlias(event.target.value)}
            />
          </FormControl>
        </FormField>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField>
            <FormLabel htmlFor="ssh-port">Port</FormLabel>
            <FormControl>
              <Input
                id="ssh-port"
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </FormControl>
          </FormField>

          <FormField>
            <FormLabel htmlFor="ssh-username">Username</FormLabel>
            <FormControl>
              <Input
                id="ssh-username"
                value={username}
                placeholder="root"
                onChange={(event) => setUsername(event.target.value)}
              />
            </FormControl>
          </FormField>
        </div>

        <FormField>
          <FormLabel htmlFor="ssh-password">Password</FormLabel>
          <FormControl>
            <PasswordField
              id="ssh-password"
              value={password}
              placeholder="Optional"
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormControl>
        </FormField>

        <FormField>
          <FormLabel htmlFor="ssh-private-key">Private Key</FormLabel>
          <FormControl>
            <Textarea
              id="ssh-private-key"
              value={privateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              contextMenuItems={keyContextMenuItems}
              onChange={(event) => setPrivateKey(event.target.value)}
            />
          </FormControl>
          <FormMessage>{privateKey.length > 0 && privateKey.length < 32 ? 'Key seems too short.' : ''}</FormMessage>
        </FormField>

        <div className="grid grid-cols-1 gap-3 px-2.5 sm:grid-cols-2">
          <div className="flex items-center gap-0.5">
            <Switch
              id="ssh-strict-host-key"
              checked={strictHostKey}
              onCheckedChange={setStrictHostKey}
            />
            <Label
              htmlFor="ssh-strict-host-key"
              className={formStyles.inlineLabel}
            >
              Strict Host Key Checking
            </Label>
          </div>

          <div className="flex items-center gap-0.5">
            <Checkbox
              id="ssh-compression"
              checked={enableCompression}
              onCheckedChange={(checkedState) => setEnableCompression(checkedState === true)}
            />
            <Label
              htmlFor="ssh-compression"
              className={formStyles.inlineLabel}
            >
              Enable Compression
            </Label>
          </div>
        </div>

        <FormField>
          <div className="mb-1 flex items-center justify-between">
            <FormLabel
              htmlFor="ssh-timeout"
              className={formStyles.inlineLabel}
            >
              Connection Timeout
            </FormLabel>
            <span className={formStyles.helperText}>{connectionTimeout[0]}s</span>
          </div>
          <Slider
            className="px-2.5"
            id="ssh-timeout"
            min={5}
            max={180}
            step={5}
            value={connectionTimeout}
            onValueChange={setConnectionTimeout}
          />
        </FormField>

        <div className="flex items-center gap-2.5">
          <Button type="submit">Save SSH Profile</Button>
          <Button variant="ghost">Test Connection</Button>
        </div>
      </Form>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={classNames(menuStyles.control, menuStyles.iconOnlyControl)}
          aria-label="Icon only example"
        >
          <PlugZap className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={menuStyles.control}
        >
          <Server className="h-4 w-4" />
          <span>Icon + Text</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Dialog>
          <DialogTrigger asChild>
            <Button>Open Dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>SSH Profile Template</DialogTitle>
              <DialogDescription>
                This dialog shares the same semantic tokens as AlertDialog and follows current form/button visuals.
              </DialogDescription>
            </DialogHeader>
            <Form className="grid gap-2">
              <FormField>
                <FormLabel htmlFor="dialog-host">Host</FormLabel>
                <FormControl>
                  <Input
                    id="dialog-host"
                    placeholder="node-a.prod"
                  />
                </FormControl>
              </FormField>
              <FormField>
                <FormLabel htmlFor="dialog-user">Username</FormLabel>
                <FormControl>
                  <Input
                    id="dialog-user"
                    placeholder="root"
                  />
                </FormControl>
              </FormField>
            </Form>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button>Save Template</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost">Open Alert Dialog</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove SSH Profile?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. The server entry will be removed from your local workspace.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancelButton>Cancel</AlertDialogCancelButton>
              <AlertDialogActionButton>Delete</AlertDialogActionButton>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="rounded-md bg-bg-subtle p-3 shadow-soft backdrop-blur-[4px]">
        <div className="mb-2 text-sm font-semibold">Toast Showcase</div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button onClick={() => notifyInfo('Session metadata synced.')}>Info Toast</Button>
          <Button onClick={() => notifySuccess('Profile saved successfully.')}>Success Toast</Button>
          <Button onClick={() => notifyWarning('Host fingerprint changed. Please verify it again.')}>
            Warning Toast
          </Button>
          <Button onClick={() => notifyError('Connection test failed. Please check credentials.')}>Error Toast</Button>
          <Button
            variant="ghost"
            onClick={() =>
              pushToast({
                title: 'Custom Toast Title',
                description:
                  'This is a long description sample used to verify auto width behavior and text wrapping in the bottom toast viewport.',
                variant: 'info',
                duration: 5200,
              })
            }
          >
            Title + Long Text
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>
                New Tab
                <span className="ml-auto text-xs text-header-text-muted">Ctrl+T</span>
              </MenubarItem>
              <MenubarSub>
                <MenubarSubTrigger icon={Folder}>Profiles</MenubarSubTrigger>
                <MenubarSubContent>
                  <MenubarItem icon={Terminal}>dev</MenubarItem>
                  <MenubarItem icon={Terminal}>staging</MenubarItem>
                  <MenubarItem icon={Terminal}>prod</MenubarItem>
                </MenubarSubContent>
              </MenubarSub>
              <MenubarItem>Reconnect</MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled>Close</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>View</MenubarTrigger>
            <MenubarContent>
              <MenubarCheckboxItem
                checked={compactMode}
                onCheckedChange={(value) => setCompactMode(value === true)}
              >
                Compact Mode
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarRadioGroup
                value={density}
                onValueChange={setDensity}
              >
                <MenubarRadioItem value="compact">Density: Compact</MenubarRadioItem>
                <MenubarRadioItem value="comfortable">Density: Comfortable</MenubarRadioItem>
              </MenubarRadioGroup>
            </MenubarContent>
          </MenubarMenu>
          <Select
            value={profile}
            onValueChange={setProfile}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                value="dev"
                icon={Terminal}
              >
                dev
              </SelectItem>
              <SelectItem
                value="staging"
                icon={Terminal}
              >
                staging
              </SelectItem>
              <SelectItem
                value="prod"
                icon={Server}
              >
                prod
              </SelectItem>
            </SelectContent>
          </Select>
          <MenubarSeparator vertical />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={menuStyles.control}
              >
                Dropdown
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem icon={PlugZap}>Open Session</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger icon={FolderOpen}>Profiles</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem icon={Terminal}>dev</DropdownMenuItem>
                  <DropdownMenuItem icon={Terminal}>staging</DropdownMenuItem>
                  <DropdownMenuItem icon={Terminal}>prod</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem>
                Split Terminal and Try to Keep the Menu Open And Caption is Long Long Long Long Long Long Long Long Long
                Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long Long
                <DropdownMenuShortcut>Alt+S</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={checked}
                onCheckedChange={(value) => setChecked(value === true)}
              >
                Keep Alive
              </DropdownMenuCheckboxItem>
              <DropdownMenuRadioGroup
                value={density}
                onValueChange={setDensity}
              >
                <DropdownMenuRadioItem value="compact">Density: Compact</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="comfortable">Density: Comfortable</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Input
            id="ssh-username"
            value={username}
            placeholder="root"
            onChange={(event) => setUsername(event.target.value)}
          />
        </Menubar>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={menuStyles.control}
            >
              Dropdown
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem icon={PlugZap}>Open Session</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={FolderOpen}>Profiles</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem icon={Terminal}>dev</DropdownMenuItem>
                <DropdownMenuItem icon={Terminal}>staging</DropdownMenuItem>
                <DropdownMenuItem icon={Terminal}>prod</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem>
              Split Terminal
              <DropdownMenuShortcut>Alt+S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>Disabled Item</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={checked}
              onCheckedChange={(value) => setChecked(value === true)}
            >
              Keep Alive
            </DropdownMenuCheckboxItem>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={setDensity}
            >
              <DropdownMenuRadioItem value="compact">Density: Compact</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="comfortable">Density: Comfortable</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={menuStyles.control}
            >
              SSH Session Menu
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Session: node-a.prod</DropdownMenuLabel>
            <DropdownMenuItem icon={Server}>Connect</DropdownMenuItem>
            <DropdownMenuItem icon={HardDrive}>Open SFTP</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger icon={PlugZap}>Port Forward</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>New Local Forward</DropdownMenuItem>
                <DropdownMenuItem>New Remote Forward</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sshMode}
              onValueChange={setSshMode}
            >
              <DropdownMenuRadioItem value="shell">Mode: Shell</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="sftp">Mode: SFTP</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Delete Host</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Select
          value={profile}
          onValueChange={setProfile}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select profile" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value="dev"
              icon={Terminal}
            >
              dev
            </SelectItem>
            <SelectItem
              value="staging"
              icon={Terminal}
            >
              staging
            </SelectItem>
            <SelectItem
              value="prod"
              icon={Server}
            >
              prod
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="rounded-md bg-bg-subtle px-3 py-6 text-sm text-header-text-muted shadow-soft backdrop-blur-[4px]">
            Right click in this area to test ContextMenu
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>Session</ContextMenuLabel>
          <ContextMenuItem icon={Server}>Reconnect</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={FolderOpen}>Profiles</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem icon={Terminal}>dev</ContextMenuItem>
              <ContextMenuItem icon={Terminal}>staging</ContextMenuItem>
              <ContextMenuItem icon={Terminal}>prod</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem>
            Rename
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled>Disabled Item</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
          >
            Keep Alive
          </ContextMenuCheckboxItem>
          <ContextMenuRadioGroup
            value={density}
            onValueChange={setDensity}
          >
            <ContextMenuRadioItem value="compact">Density: Compact</ContextMenuRadioItem>
            <ContextMenuRadioItem value="comfortable">Density: Comfortable</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuContent>
      </ContextMenu>

      <div className="rounded-md bg-bg-subtle p-3 shadow-soft backdrop-blur-[4px]">
        <div className="mb-2 text-sm font-semibold">
          {t('home.currentLanguage')}: {locale}
        </div>
        <div className="mb-2">
          <button
            type="button"
            className={menuStyles.control}
            onClick={handleToggleLocale}
          >
            {t('home.switchLanguage')}: {locale}
          </button>
        </div>
        <div className="text-muted flex flex-col gap-1 text-sm">
          {formatSamples.map((sample, index) => (
            <div key={`${sample}-${index}`}>{sample}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ComponentsField;
