import React from 'react';

import { Checkbox } from '../components/ui/checkbox';
import { Label } from '../components/ui/label';
import { getBackendRuntimeTarget, testBackendPing } from '../lib/backend';
import type { TabIconKey } from '../types/tabs';

type BackendPingState =
  | { status: 'idle'; message: string }
  | { status: 'loading'; message: string }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

type DebugProps = {
  onOpenSSH: (openInNewTab: boolean) => void;
  onOpenSettings: (openInNewTab: boolean) => void;
  onOpenSettingsEditor: (openInNewTab: boolean) => void;
  onOpenComponentsField: (openInNewTab: boolean) => void;
  onOpenSshEditor: (openInNewTab: boolean) => void;
  onRenameTab: (title: string) => void;
  onChangeIcon: (iconKey: TabIconKey) => void;
  activeTabTitle: string;
  activeTabIcon: TabIconKey;
};

const TAB_ICON_OPTIONS: Array<{ value: TabIconKey; label: string }> = [
  { value: 'home', label: 'Home' },
  { value: 'ssh', label: 'SSH' },
  { value: 'settings', label: 'Settings' },
  { value: 'file', label: 'File' },
  { value: 'terminal', label: 'Terminal' },
];

type NavigationEntry = {
  id: string;
  pageName: string;
  onClick: (openInNewTab: boolean) => void;
};

const Debug: React.FC<DebugProps> = ({
  onOpenSSH,
  onOpenSettings,
  onOpenSettingsEditor,
  onOpenComponentsField,
  onOpenSshEditor,
  onRenameTab,
  onChangeIcon,
  activeTabTitle,
  activeTabIcon,
}) => {
  const [draftTitle, setDraftTitle] = React.useState<string>(activeTabTitle);
  const [openInNewTab, setOpenInNewTab] = React.useState<boolean>(true);
  const [backendPingState, setBackendPingState] = React.useState<BackendPingState>({
    status: 'idle',
    message: 'Not tested',
  });
  const backendRuntime = React.useMemo(() => getBackendRuntimeTarget(), []);

  const navigationEntries: NavigationEntry[] = [
    { id: 'ssh', pageName: 'SSH', onClick: onOpenSSH },
    { id: 'ssh-editor', pageName: 'SSH Editor', onClick: onOpenSshEditor },
    { id: 'settings', pageName: 'Settings', onClick: onOpenSettings },
    { id: 'settings-editor', pageName: 'Settings Editor', onClick: onOpenSettingsEditor },
    {
      id: 'components-playground',
      pageName: 'Components Playground',
      onClick: onOpenComponentsField,
    },
  ];

  React.useEffect(() => {
    setDraftTitle(activeTabTitle);
  }, [activeTabTitle]);

  const handleBackendPing = async () => {
    setBackendPingState({ status: 'loading', message: 'Testing...' });

    try {
      const result = await testBackendPing();
      setBackendPingState({
        status: 'success',
        message: `OK • ${result.code} • ${result.data.capabilities.join(', ')}`,
      });
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Unknown error';
      setBackendPingState({ status: 'error', message: `Failed • ${nextMessage}` });
    }
  };

  const applyTabTitle = () => {
    onRenameTab(draftTitle.trim() || 'Untitled');
  };

  return (
    <div className="flex flex-col gap-4 p-2">
      <div className="text-lg font-semibold">Debug</div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Open Pages</div>
        <div className="mb-2 flex items-center gap-2">
          <Checkbox
            id="debug-open-in-new-tab"
            checked={openInNewTab}
            onCheckedChange={(value) => setOpenInNewTab(value === true)}
          />
          <Label htmlFor="debug-open-in-new-tab">Open in new tab</Label>
        </div>
        <div className="flex flex-col gap-1">
          {navigationEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex w-full items-center justify-between rounded-md bg-bg-subtle px-3 py-2 text-left text-sm transition-colors hover:bg-menu-control-hover"
              aria-label={`Open ${entry.pageName}`}
              data-testid={`debug-open-${entry.id}`}
              onClick={() => entry.onClick(openInNewTab)}
            >
              <span className="font-medium">{entry.pageName}</span>
              <span className="text-xs text-header-text-muted">{openInNewTab ? 'New tab' : 'Current tab'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Backend Diagnostics</div>
        <button
          type="button"
          className="debug-button"
          disabled={backendPingState.status === 'loading'}
          onClick={handleBackendPing}
        >
          Test Backend API
        </button>
        <div className="text-muted mt-2 text-sm">
          Backend ({backendRuntime}): {backendPingState.message}
        </div>
        <div className="border-border-subtle mt-3 rounded-md border bg-bg-subtle p-3 text-xs text-header-text-muted">
          SQLCipher fallback currently requires environment bootstrap when secure storage is unavailable. Configure the
          temporary master-password environment path until the dedicated set/unlock password dialog is wired.
        </div>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Tab Debug Tools</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Name</span>
            <input
              className="debug-input"
              value={draftTitle}
              placeholder="Tab name"
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="debug-button"
            onClick={applyTabTitle}
          >
            Apply Name
          </button>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Icon</span>
            <select
              className="debug-select"
              value={activeTabIcon}
              onChange={(event) => onChangeIcon(event.target.value as TabIconKey)}
            >
              {TAB_ICON_OPTIONS.map((iconOption) => (
                <option
                  key={iconOption.value}
                  value={iconOption.value}
                >
                  {iconOption.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
};

export default Debug;
