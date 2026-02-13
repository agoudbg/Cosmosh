import classNames from 'classnames';
import { Folder, FolderOpen, HardDrive, PlugZap, Server, Terminal } from 'lucide-react';
import React from 'react';

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { getLocale, setLocale, t } from '../lib/i18n';

const ComponentsField: React.FC = () => {
  const [checked, setChecked] = React.useState<boolean>(true);
  const [compactMode, setCompactMode] = React.useState<boolean>(false);
  const [density, setDensity] = React.useState<string>('compact');
  const [profile, setProfile] = React.useState<string>('prod');
  const [sshMode, setSshMode] = React.useState<string>('shell');
  const [locale, setLocaleState] = React.useState<'en' | 'zh-CN'>(getLocale());

  const handleToggleLocale = React.useCallback(async () => {
    const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
    const syncedLocale = await setLocale(nextLocale);
    setLocaleState(syncedLocale);
  }, [locale]);

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
