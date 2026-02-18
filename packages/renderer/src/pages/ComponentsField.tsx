import classNames from 'classnames';
import { Folder, FolderOpen, HardDrive, PlugZap, Server, Terminal } from 'lucide-react';
import React from 'react';

import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
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
import { InputContextMenuItem } from '../components/ui/input-context-menu';
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

const ComponentsField: React.FC = () => {
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
        onSelect: (target) => {
          target.focus({ preventScroll: true });
          target.setRangeText('node-{env}.prod', target.selectionStart ?? 0, target.selectionEnd ?? 0, 'end');
        },
      },
      {
        key: 'normalize-host-lowercase',
        label: 'Normalize to Lowercase',
        onSelect: (target) => {
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
        onSelect: (target) => {
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

  return (
    <div className="flex flex-col gap-4">
      <div className="text-lg font-semibold">{t('componentsPlayground.title')}</div>

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
