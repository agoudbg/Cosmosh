import type { ApiSshCreateServerRequest, components } from '@cosmosh/api-contract';
import React from 'react';

import {
  createSshFolder,
  createSshServer,
  createSshTag,
  listSshFolders,
  listSshServers,
  listSshTags,
} from '../lib/backend';
import { t } from '../lib/i18n';

type SshServerListItem = components['schemas']['SshServerListItem'];
type SshFolder = components['schemas']['SshFolder'];
type SshTag = components['schemas']['SshTag'];
type SshAuthType = components['schemas']['SshAuthType'];

type CreateServerFormState = {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  folderId: string;
  note: string;
};

const createInitialFormState = (): CreateServerFormState => {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    folderId: '',
    note: '',
  };
};

const SSHEditorMock: React.FC = () => {
  const [servers, setServers] = React.useState<SshServerListItem[]>([]);
  const [folders, setFolders] = React.useState<SshFolder[]>([]);
  const [tags, setTags] = React.useState<SshTag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = React.useState<string[]>([]);
  const [formState, setFormState] = React.useState<CreateServerFormState>(createInitialFormState);
  const [newFolderName, setNewFolderName] = React.useState('');
  const [newTagName, setNewTagName] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmittingServer, setIsSubmittingServer] = React.useState(false);
  const [isSubmittingFolder, setIsSubmittingFolder] = React.useState(false);
  const [isSubmittingTag, setIsSubmittingTag] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const reloadAll = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [serversResponse, foldersResponse, tagsResponse] = await Promise.all([
        listSshServers(),
        listSshFolders(),
        listSshTags(),
      ]);

      setServers(serversResponse.data.items);
      setFolders(foldersResponse.data.items);
      setTags(tagsResponse.data.items);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load SSH resources.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  const onFormChange = <K extends keyof CreateServerFormState>(key: K, value: CreateServerFormState[K]) => {
    setFormState((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const onToggleTag = (tagId: string) => {
    setSelectedTagIds((previous) => {
      if (previous.includes(tagId)) {
        return previous.filter((id) => id !== tagId);
      }

      return [...previous, tagId];
    });
  };

  const onSubmitServer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmittingServer(true);

    try {
      const payload: ApiSshCreateServerRequest = {
        name: formState.name,
        host: formState.host,
        port: Number(formState.port),
        username: formState.username,
        authType: formState.authType,
        password: formState.password || undefined,
        privateKey: formState.privateKey || undefined,
        privateKeyPassphrase: formState.privateKeyPassphrase || undefined,
        folderId: formState.folderId || undefined,
        tagIds: selectedTagIds,
        note: formState.note || undefined,
      };

      await createSshServer(payload);
      setFormState(createInitialFormState());
      setSelectedTagIds([]);
      setSuccessMessage('SSH server created successfully.');
      await reloadAll();
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create SSH server.');
    } finally {
      setIsSubmittingServer(false);
    }
  };

  const onCreateFolder = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!newFolderName.trim()) {
      setErrorMessage('Folder name is required.');
      return;
    }

    setIsSubmittingFolder(true);
    try {
      await createSshFolder({
        name: newFolderName.trim(),
      });
      setNewFolderName('');
      setSuccessMessage('Folder created successfully.');
      await reloadAll();
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create folder.');
    } finally {
      setIsSubmittingFolder(false);
    }
  };

  const onCreateTag = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!newTagName.trim()) {
      setErrorMessage('Tag name is required.');
      return;
    }

    setIsSubmittingTag(true);
    try {
      await createSshTag({
        name: newTagName.trim(),
      });
      setNewTagName('');
      setSuccessMessage('Tag created successfully.');
      await reloadAll();
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create tag.');
    } finally {
      setIsSubmittingTag(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1>{t('ssh.title')}</h1>

      {isLoading && <p>{t('ssh.loading')}</p>}
      {errorMessage && <p>{errorMessage}</p>}
      {successMessage && <p>{successMessage}</p>}

      <section className="space-y-2">
        <h2>{t('ssh.createFolderTitle')}</h2>
        <div className="flex gap-2">
          <input
            value={newFolderName}
            placeholder={t('ssh.folderNamePlaceholder')}
            className="border px-2 py-1"
            onChange={(event) => setNewFolderName(event.target.value)}
          />
          <button
            type="button"
            disabled={isSubmittingFolder}
            className="border px-2 py-1"
            onClick={() => void onCreateFolder()}
          >
            {isSubmittingFolder ? t('ssh.creating') : t('ssh.createFolderButton')}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2>{t('ssh.createTagTitle')}</h2>
        <div className="flex gap-2">
          <input
            value={newTagName}
            placeholder={t('ssh.tagNamePlaceholder')}
            className="border px-2 py-1"
            onChange={(event) => setNewTagName(event.target.value)}
          />
          <button
            type="button"
            disabled={isSubmittingTag}
            className="border px-2 py-1"
            onClick={() => void onCreateTag()}
          >
            {isSubmittingTag ? t('ssh.creating') : t('ssh.createTagButton')}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2>{t('ssh.createServerTitle')}</h2>
        <form
          className="space-y-2"
          onSubmit={(event) => void onSubmitServer(event)}
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              value={formState.name}
              placeholder={t('ssh.serverNamePlaceholder')}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('name', event.target.value)}
            />
            <input
              value={formState.host}
              placeholder={t('ssh.hostPlaceholder')}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('host', event.target.value)}
            />
            <input
              value={formState.port}
              placeholder={t('ssh.portPlaceholder')}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('port', event.target.value)}
            />
            <input
              value={formState.username}
              placeholder={t('ssh.usernamePlaceholder')}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('username', event.target.value)}
            />
            <select
              value={formState.authType}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('authType', event.target.value as SshAuthType)}
            >
              <option value="password">password</option>
              <option value="key">key</option>
              <option value="both">both</option>
            </select>
            <select
              value={formState.folderId}
              className="border px-2 py-1"
              onChange={(event) => onFormChange('folderId', event.target.value)}
            >
              <option value="">{t('ssh.noFolder')}</option>
              {folders.map((folder) => (
                <option
                  key={folder.id}
                  value={folder.id}
                >
                  {folder.name}
                </option>
              ))}
            </select>
          </div>

          {(formState.authType === 'password' || formState.authType === 'both') && (
            <input
              value={formState.password}
              placeholder={t('ssh.passwordPlaceholder')}
              className="border px-2 py-1"
              type="password"
              onChange={(event) => onFormChange('password', event.target.value)}
            />
          )}

          {(formState.authType === 'key' || formState.authType === 'both') && (
            <textarea
              value={formState.privateKey}
              placeholder={t('ssh.privateKeyPlaceholder')}
              className="border px-2 py-1"
              rows={4}
              onChange={(event) => onFormChange('privateKey', event.target.value)}
            />
          )}

          {(formState.authType === 'key' || formState.authType === 'both') && (
            <input
              value={formState.privateKeyPassphrase}
              placeholder={t('ssh.privateKeyPassphrasePlaceholder')}
              className="border px-2 py-1"
              type="password"
              onChange={(event) => onFormChange('privateKeyPassphrase', event.target.value)}
            />
          )}

          <textarea
            value={formState.note}
            placeholder={t('ssh.notePlaceholder')}
            className="border px-2 py-1"
            rows={3}
            onChange={(event) => onFormChange('note', event.target.value)}
          />

          <fieldset className="space-y-1">
            <legend>{t('ssh.tagsLegend')}</legend>
            {tags.map((tag) => (
              <label
                key={tag.id}
                className="mr-3 inline-flex items-center gap-1"
              >
                <input
                  type="checkbox"
                  checked={selectedTagIds.includes(tag.id)}
                  onChange={() => onToggleTag(tag.id)}
                />
                {tag.name}
              </label>
            ))}
          </fieldset>

          <button
            type="submit"
            disabled={isSubmittingServer}
            className="border px-2 py-1"
          >
            {isSubmittingServer ? t('ssh.creating') : t('ssh.createServerButton')}
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h2>{t('ssh.serverListTitle')}</h2>
        <div className="overflow-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr>
                <th className="border px-2 py-1 text-left">{t('ssh.columnName')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnHost')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnUser')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnAuth')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnFolder')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnTags')}</th>
                <th className="border px-2 py-1 text-left">{t('ssh.columnLastLogin')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td className="border px-2 py-1">{server.name}</td>
                  <td className="border px-2 py-1">{`${server.host}:${server.port}`}</td>
                  <td className="border px-2 py-1">{server.username}</td>
                  <td className="border px-2 py-1">
                    {server.authType} | pwd:{String(server.hasPassword)} | key:{String(server.hasPrivateKey)}
                  </td>
                  <td className="border px-2 py-1">{server.folder?.name ?? '-'}</td>
                  <td className="border px-2 py-1">{(server.tags ?? []).map((tag) => tag.name).join(', ') || '-'}</td>
                  <td className="border px-2 py-1">{server.lastLoginAudit?.attemptedAt ?? '-'}</td>
                </tr>
              ))}
              {servers.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="border px-2 py-2 text-center"
                  >
                    {t('ssh.emptyServers')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default SSHEditorMock;
