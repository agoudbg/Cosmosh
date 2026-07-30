import React from 'react';

import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { getBackendRuntimeTarget, testBackendPing } from '../lib/backend';
import { readEnableHeapSnapshotPreference, writeEnableHeapSnapshotPreference } from '../lib/debug-tools';
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
  onRenameTab: (title: string) => void;
  onChangeIcon: (iconKey: TabIconKey) => void;
  showSystemMonitorOverlay: boolean;
  onShowSystemMonitorOverlayChange: (nextVisible: boolean) => void;
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
  onRenameTab,
  onChangeIcon,
  showSystemMonitorOverlay,
  onShowSystemMonitorOverlayChange,
  activeTabTitle,
  activeTabIcon,
}) => {
  const [draftTitle, setDraftTitle] = React.useState<string>(activeTabTitle);
  const [openInNewTab, setOpenInNewTab] = React.useState<boolean>(true);
  const [backendPingState, setBackendPingState] = React.useState<BackendPingState>({
    status: 'idle',
    message: 'Not tested',
  });
  const [enableHeapSnapshotExport, setEnableHeapSnapshotExport] = React.useState<boolean>(() => {
    return readEnableHeapSnapshotPreference();
  });
  const [heapSnapshotStatus, setHeapSnapshotStatus] = React.useState<string>('Not exported');
  const backendRuntime = React.useMemo(() => getBackendRuntimeTarget(), []);

  const navigationEntries: NavigationEntry[] = [
    { id: 'ssh', pageName: 'SSH', onClick: onOpenSSH },
    { id: 'settings', pageName: 'Settings', onClick: onOpenSettings },
    { id: 'settings-editor', pageName: 'Settings Editor', onClick: onOpenSettingsEditor },
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

  const handleToggleHeapSnapshotExport = (nextEnabled: boolean) => {
    setEnableHeapSnapshotExport(nextEnabled);
    writeEnableHeapSnapshotPreference(nextEnabled);
  };

  const handleExportMainHeapSnapshot = async () => {
    const electronBridge = window.electron;
    if (!electronBridge?.exportMainHeapSnapshot) {
      setHeapSnapshotStatus('Main process export is unavailable in this runtime.');
      return;
    }

    setHeapSnapshotStatus('Exporting main heap snapshot...');

    try {
      const result = await electronBridge.exportMainHeapSnapshot();
      if (result.ok) {
        setHeapSnapshotStatus(result.filePath ? `Exported: ${result.filePath}` : 'Export completed.');
        return;
      }

      setHeapSnapshotStatus(result.message ? `Failed: ${result.message}` : 'Failed: unknown error');
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Unknown error';
      setHeapSnapshotStatus(`Failed: ${nextMessage}`);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-2">
      <div className="text-lg font-semibold">Debug</div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">System Monitor Overlay</div>
        <div className="mb-2 flex items-center gap-2">
          <Checkbox
            id="debug-show-system-monitor"
            checked={showSystemMonitorOverlay}
            onCheckedChange={(value) => onShowSystemMonitorOverlayChange(value === true)}
          />
          <Label htmlFor="debug-show-system-monitor">Show system usage overlay</Label>
        </div>
        <div className="text-muted text-sm">
          Overlay shows main CPU usage, main/renderer memory, renderer JS heap (V8 JavaScript heap), and FPS.
        </div>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Main Process Heap Snapshot</div>
        <div className="mb-2 flex items-center gap-2">
          <Checkbox
            id="debug-enable-main-heap-snapshot"
            checked={enableHeapSnapshotExport}
            onCheckedChange={(value) => handleToggleHeapSnapshotExport(value === true)}
          />
          <Label htmlFor="debug-enable-main-heap-snapshot">Enable main heap snapshot export</Label>
        </div>

        {enableHeapSnapshotExport ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="ghost"
              className="!justify-start"
              onClick={handleExportMainHeapSnapshot}
            >
              Export Main Heap Snapshot
            </Button>
            <div className="text-muted break-all text-xs">{heapSnapshotStatus}</div>
          </div>
        ) : (
          <div className="text-muted text-sm">Enable this toggle first to expose heap snapshot controls.</div>
        )}
      </div>

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
            <Button
              key={entry.id}
              variant="ghost"
              className="w-full !justify-between rounded-md px-3 text-left"
              aria-label={`Open ${entry.pageName}`}
              data-testid={`debug-open-${entry.id}`}
              onClick={() => entry.onClick(openInNewTab)}
            >
              <span className="font-medium">{entry.pageName}</span>
              <span className="text-xs text-header-text-muted">{openInNewTab ? 'New tab' : 'Current tab'}</span>
            </Button>
          ))}
        </div>
      </div>

      <div className="debug-panel">
        <div className="mb-2 text-sm font-semibold">Backend Diagnostics</div>
        <Button
          variant="ghost"
          className="!justify-start"
          disabled={backendPingState.status === 'loading'}
          onClick={handleBackendPing}
        >
          Test Backend API
        </Button>
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
          <div className="flex items-center gap-2 text-sm">
            <Label
              htmlFor="debug-tab-title"
              className="px-0 text-header-text-muted"
            >
              Name
            </Label>
            <div className="w-[180px]">
              <Input
                id="debug-tab-title"
                value={draftTitle}
                placeholder="Tab name"
                onChange={(event) => setDraftTitle(event.target.value)}
              />
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={applyTabTitle}
          >
            Apply Name
          </Button>
          <div className="flex items-center gap-2 text-sm">
            <Label
              htmlFor="debug-tab-icon"
              className="px-0 text-header-text-muted"
            >
              Icon
            </Label>
            <div className="w-[180px]">
              <Select
                value={activeTabIcon}
                onValueChange={(value) => onChangeIcon(value as TabIconKey)}
              >
                <SelectTrigger id="debug-tab-icon">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TAB_ICON_OPTIONS.map((iconOption) => (
                    <SelectItem
                      key={iconOption.value}
                      value={iconOption.value}
                    >
                      {iconOption.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Debug;
