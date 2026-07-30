import type { components } from '@cosmosh/api-contract';
import { FileUp, RefreshCcw } from 'lucide-react';
import React from 'react';

import { listSshKeychains, listSshTags } from '../../lib/backend';
import { t } from '../../lib/i18n';
import { mergeKeychainListItems, upsertKeychainListItem } from '../../lib/ssh-keychain-editor-shared';
import { createPrivateKeyImportContextMenuItems, importPrivateKeyFromFile } from '../../lib/ssh-private-key-import';
import {
  buildInlineCredentialKeychainEditorFormState,
  createServerEditorTag,
  saveServerFromEditor,
} from '../../lib/ssh-server-editor-actions';
import {
  applySubmittedCredentialsToCache,
  createInitialServerFormState,
  deriveServerEditorCredentialMode,
  mapServerToFormState,
  type ServerCredentialCache,
  type ServerEditorFormState,
  type SshServerListItem,
} from '../../lib/ssh-server-editor-shared';
import { useToast } from '../../lib/toast-context';
import { useCreateFolderDialog } from '../../lib/use-create-folder-dialog';
import { useKeychainEditorDialogState } from '../../lib/use-keychain-editor-dialog-state';
import { useKeychainCredentials, useServerCredentialsRefresh } from '../../lib/use-server-credentials';
import CreateFolderDialog from '../home/CreateFolderDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../ui/dialog';
import type { InputContextMenuItem } from '../ui/input-context-menu-registry';
import SSHKeychainEditorDialog from './SSHKeychainEditorDialog';
import SSHServerEditorForm, {
  SSH_SERVER_ADD_KEYCHAIN_SELECT_VALUE,
  SSH_SERVER_INLINE_KEYCHAIN_SELECT_VALUE,
} from './SSHServerEditorForm';

type SshFolder = components['schemas']['SshFolder'];
type SshTag = components['schemas']['SshTag'];
type SshKeychainListItem = components['schemas']['SshKeychainListItem'];

type SSHServerEditorDialogProps = {
  open: boolean;
  serverId: string | null;
  initialFolderId?: string;
  servers: SshServerListItem[];
  folders: SshFolder[];
  defaultServerNoteTemplate: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
};

const SSHServerEditorDialog: React.FC<SSHServerEditorDialogProps> = ({
  open,
  serverId,
  initialFolderId,
  servers,
  folders,
  defaultServerNoteTemplate,
  onOpenChange,
  onSaved,
}) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const [tags, setTags] = React.useState<SshTag[]>([]);
  const [keychains, setKeychains] = React.useState<SshKeychainListItem[]>([]);
  const [editorFolders, setEditorFolders] = React.useState<SshFolder[]>(folders);
  const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
  const [formState, setFormState] = React.useState<ServerEditorFormState>(() =>
    createInitialServerFormState(defaultServerNoteTemplate),
  );
  const stableServerIdRef = React.useRef<string | null>(serverId);
  const initializedEditorTargetRef = React.useRef<string | null | undefined>(undefined);
  const formStateRef = React.useRef<ServerEditorFormState>(formState);
  const credentialsCacheRef = React.useRef<Record<string, ServerCredentialCache>>({});
  const savedKeychainsRef = React.useRef<SshKeychainListItem[]>([]);
  const displayServerId = open ? serverId : stableServerIdRef.current;

  React.useEffect(() => {
    if (!open) {
      return;
    }

    stableServerIdRef.current = serverId;
  }, [open, serverId]);

  const activeServer = React.useMemo(() => {
    if (!displayServerId) {
      return null;
    }

    return servers.find((server) => server.id === displayServerId) ?? null;
  }, [displayServerId, servers]);

  React.useEffect(() => {
    formStateRef.current = formState;
  }, [formState]);

  React.useEffect(() => {
    if (!open) {
      initializedEditorTargetRef.current = undefined;
      savedKeychainsRef.current = [];
      return;
    }

    /**
     * During one open session, keep user edits stable.
     * Parent list refreshes (servers/folders) may happen while the dialog is open
     * or closing, and should not rehydrate the form unless the edit target changes.
     */
    if (initializedEditorTargetRef.current === serverId) {
      return;
    }
    initializedEditorTargetRef.current = serverId;

    setEditorFolders(folders);

    if (serverId) {
      const targetServer = servers.find((server) => server.id === serverId);
      if (!targetServer) {
        notifyWarning(t('ssh.validationServerNotFound'));
        onOpenChange(false);
        return;
      }

      setFormState({
        ...mapServerToFormState(targetServer),
        ...(credentialsCacheRef.current[serverId] ?? {}),
      });
      return;
    }

    const nextFormState = createInitialServerFormState(defaultServerNoteTemplate);
    if (initialFolderId) {
      nextFormState.folderId = initialFolderId;
    }
    setFormState(nextFormState);
  }, [defaultServerNoteTemplate, folders, initialFolderId, notifyWarning, onOpenChange, open, serverId, servers]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const loadReferences = async () => {
      try {
        const [tagsResponse, keychainsResponse] = await Promise.all([listSshTags(), listSshKeychains()]);
        if (cancelled) {
          return;
        }

        setTags(tagsResponse.data.items);
        setKeychains(mergeKeychainListItems(keychainsResponse.data.items, savedKeychainsRef.current));
      } catch (error: unknown) {
        if (!cancelled) {
          notifyError(error instanceof Error ? error.message : t('ssh.editorLoadFailed'));
        }
      }
    };

    void loadReferences();

    return () => {
      cancelled = true;
    };
  }, [notifyError, open]);

  const { refreshServerCredentials } = useServerCredentialsRefresh({
    enabled: open,
    serverId,
    onCredentialsLoaded: (nextCredentials) => {
      if (!serverId) {
        return;
      }

      credentialsCacheRef.current[serverId] = nextCredentials;
      setFormState((previous) => ({
        ...previous,
        ...nextCredentials,
      }));
    },
    onLoadFailed: () => {
      notifyError(t('ssh.credentialsLoadFailed'));
    },
  });

  useKeychainCredentials({
    enabled: open,
    keychainId: formState.keychainId || null,
    onCredentialsLoaded: (nextCredentials) => {
      setFormState((previous) => ({
        ...previous,
        ...nextCredentials,
      }));
    },
    onLoadFailed: () => {
      notifyError(t('ssh.credentialsLoadFailed'));
    },
  });

  const { sharedKeychains, isUsingInlineCredentials, requiresPassword, requiresPrivateKey } = React.useMemo(() => {
    return deriveServerEditorCredentialMode({
      keychainId: formState.keychainId,
      keychains,
      authType: formState.authType,
    });
  }, [formState.authType, formState.keychainId, keychains]);

  const keychainSelectValue = isUsingInlineCredentials ? SSH_SERVER_INLINE_KEYCHAIN_SELECT_VALUE : formState.keychainId;

  const {
    isKeychainEditorDialogOpen,
    activeKeychainEditorId,
    keychainEditorInitialFormState,
    openCreateKeychainDialog,
    openEditKeychainDialog,
    closeKeychainEditorDialog,
  } = useKeychainEditorDialogState({
    keychains: sharedKeychains,
    onKeychainNotFound: () => {
      notifyWarning(t('ssh.validationKeychainNotFound'));
    },
  });

  const createFolderDialog = useCreateFolderDialog({
    onCreated: (createdFolder, options) => {
      setEditorFolders((previous) => {
        if (previous.some((folder) => folder.id === createdFolder.id)) {
          return previous;
        }

        return [...previous, createdFolder];
      });

      if (options.selectOnCreate) {
        setFormState((previous) => ({
          ...previous,
          folderId: createdFolder.id,
        }));
      }
    },
  });

  const onChangeForm = React.useCallback(
    <K extends keyof ServerEditorFormState>(key: K, value: ServerEditorFormState[K]) => {
      setFormState((previous) => ({
        ...previous,
        [key]: value,
      }));
    },
    [],
  );

  const onHostChange = React.useCallback(
    (nextHost: string) => {
      onChangeForm('host', nextHost);

      if (!serverId && !formStateRef.current.name.trim()) {
        onChangeForm('name', nextHost);
      }
    },
    [onChangeForm, serverId],
  );

  const onCreateTag = React.useCallback(
    async (name: string): Promise<SshTag | null> => {
      return createServerEditorTag({
        name,
        tags,
        onTagCreated: (createdTag) => {
          setTags((previous) => [...previous, createdTag]);
        },
        onError: notifyError,
        createTagFailedMessage: t('ssh.createTagFailed'),
      });
    },
    [notifyError, tags],
  );

  const importServerPrivateKeyFromFile = React.useCallback(async () => {
    const importedKey = await importPrivateKeyFromFile({
      onSuccess: notifySuccess,
      onError: notifyError,
      importSuccessMessage: t('ssh.privateKeyImportSuccess'),
      importFailedMessage: t('ssh.privateKeyImportFailed'),
    });

    if (importedKey) {
      onChangeForm('privateKey', importedKey.content);
    }
  }, [notifyError, notifySuccess, onChangeForm]);

  const privateKeyContextMenuItems = React.useMemo<InputContextMenuItem[]>(() => {
    return createPrivateKeyImportContextMenuItems({
      icon: FileUp,
      label: t('ssh.privateKeyImportAction'),
      onImport: importServerPrivateKeyFromFile,
    });
  }, [importServerPrivateKeyFromFile]);

  const openSelectedKeychainEditor = React.useCallback(() => {
    if (!formState.keychainId) {
      return;
    }

    openEditKeychainDialog(formState.keychainId);
  }, [formState.keychainId, openEditKeychainDialog]);

  const saveInlineCredentialsToSharedKeychain = React.useCallback(() => {
    openCreateKeychainDialog(buildInlineCredentialKeychainEditorFormState(formState));
  }, [formState, openCreateKeychainDialog]);

  const refreshServerCredentialsAfterSave = React.useCallback(
    async (savedServerId: string): Promise<void> => {
      await refreshServerCredentials(savedServerId, {
        onCredentialsLoaded: (nextCredentials) => {
          credentialsCacheRef.current[savedServerId] = nextCredentials;
          if (serverId === savedServerId) {
            setFormState((previous) => ({
              ...previous,
              ...nextCredentials,
            }));
          }
        },
        onLoadFailed: () => {
          notifyWarning(t('ssh.credentialsLoadFailed'));
        },
      });
    },
    [notifyWarning, refreshServerCredentials, serverId],
  );

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      setIsSubmitting(true);
      try {
        const result = await saveServerFromEditor({
          serverId,
          activeServer,
          formState,
          isUsingInlineCredentials,
          requiresPassword,
          requiresPrivateKey,
          onWarning: notifyWarning,
          validationRequiredFieldsMessage: t('ssh.validationRequiredFields'),
          validationInvalidPortMessage: t('ssh.validationInvalidPort'),
          validationServerNotFoundMessage: t('ssh.validationServerNotFound'),
          validationPasswordRequiredMessage: t('ssh.validationPasswordRequired'),
          validationPrivateKeyRequiredMessage: t('ssh.validationPrivateKeyRequired'),
          validationProxyUrlMessage: t('ssh.validationProxyUrl'),
        });
        if (!result) {
          return;
        }

        const savedServerId = serverId ?? result.savedServer.id;
        if (isUsingInlineCredentials) {
          credentialsCacheRef.current[savedServerId] = applySubmittedCredentialsToCache(
            credentialsCacheRef.current[savedServerId],
            result.submittedCredentialPayload,
          );
        }

        await refreshServerCredentialsAfterSave(savedServerId);
        await onSaved();
        notifySuccess(serverId ? t('ssh.serverUpdatedSuccessfully') : t('ssh.serverCreatedSuccessfully'));
        onOpenChange(false);
      } catch (error: unknown) {
        notifyError(error instanceof Error ? error.message : t('ssh.saveServerFailed'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      activeServer,
      formState,
      isUsingInlineCredentials,
      notifyError,
      notifySuccess,
      notifyWarning,
      onOpenChange,
      onSaved,
      refreshServerCredentialsAfterSave,
      requiresPassword,
      requiresPrivateKey,
      serverId,
    ],
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && isSubmitting) {
            return;
          }

          onOpenChange(nextOpen);
        }}
      >
        <DialogContent
          showCloseButton={!isSubmitting}
          className="h-[min(760px,92vh)] !max-w-5xl grid-rows-[auto,minmax(0,1fr),auto] gap-0 p-0"
        >
          <DialogHeader className="px-6">
            <DialogTitle>{displayServerId ? t('home.contextEdit') : t('home.quickAddServer')}</DialogTitle>
            <DialogDescription className="sr-only">{t('ssh.serverEditorDialogDescription')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-hidden">
            <SSHServerEditorForm
              formId="home-ssh-editor-form"
              formState={formState}
              activeServer={activeServer}
              isSubmitting={isSubmitting}
              sharedKeychains={sharedKeychains}
              folders={editorFolders}
              tags={tags}
              keychainSelectValue={keychainSelectValue}
              isUsingInlineCredentials={isUsingInlineCredentials}
              requiresPassword={requiresPassword}
              requiresPrivateKey={requiresPrivateKey}
              privateKeyContextMenuItems={privateKeyContextMenuItems}
              onSubmit={(event) => {
                void onSubmit(event);
              }}
              onHostChange={onHostChange}
              onCreateFolder={(options) => {
                createFolderDialog.openCreateFolderDialog(options);
              }}
              onCreateTag={onCreateTag}
              onOpenSelectedKeychainEditor={openSelectedKeychainEditor}
              onSaveInlineCredentialsToSharedKeychain={saveInlineCredentialsToSharedKeychain}
              onKeychainSelectValueChange={(value) => {
                if (value === SSH_SERVER_ADD_KEYCHAIN_SELECT_VALUE) {
                  openCreateKeychainDialog();
                  return;
                }

                onChangeForm('keychainId', value === SSH_SERVER_INLINE_KEYCHAIN_SELECT_VALUE ? '' : value);
              }}
              onChangeForm={onChangeForm}
            />
          </div>

          <DialogFooter className="border-t border-dialog-border">
            <DialogSecondaryButton
              disabled={isSubmitting}
              onClick={() => onOpenChange(false)}
            >
              {t('home.actionCancel')}
            </DialogSecondaryButton>
            <DialogPrimaryButton
              type="submit"
              form="home-ssh-editor-form"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <RefreshCcw
                  size={16}
                  className="animate-spin"
                />
              ) : null}
              {isSubmitting ? t('ssh.saving') : displayServerId ? t('ssh.saveChanges') : t('ssh.createServerButton')}
            </DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SSHKeychainEditorDialog
        open={isKeychainEditorDialogOpen}
        keychainId={activeKeychainEditorId}
        initialFormState={keychainEditorInitialFormState}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeKeychainEditorDialog();
          }
        }}
        onSaved={(savedKeychain) => {
          savedKeychainsRef.current = upsertKeychainListItem(savedKeychainsRef.current, savedKeychain);
          setKeychains((previous) => upsertKeychainListItem(previous, savedKeychain));
          onChangeForm('keychainId', savedKeychain.id);
        }}
      />

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
    </>
  );
};

export default SSHServerEditorDialog;
