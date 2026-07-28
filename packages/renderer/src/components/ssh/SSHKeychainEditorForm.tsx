import type { components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import { FolderPlus } from 'lucide-react';
import React from 'react';

import { getEntityColorClassName, isEntityColorKey, renderEntityIcon } from '../../lib/entity-visuals';
import { t } from '../../lib/i18n';
import type { KeychainFormState } from '../../lib/ssh-keychain-editor-shared';
import EntityIcon from '../home/EntityIcon';
import EntityVisualPicker from '../home/EntityVisualPicker';
import { Form, FormControl, FormField, FormLabel, FormMessage, FormSectionHeading } from '../ui/form';
import { Input } from '../ui/input';
import type { InputContextMenuItem } from '../ui/input-context-menu-registry';
import { PasswordField } from '../ui/password-field';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { TagInput } from '../ui/tag-input';
import { Textarea } from '../ui/textarea';
import SSHFolderSelectItem from './SSHFolderSelectItem';

type SshFolder = components['schemas']['SshFolder'];
type SshKeychainListItem = components['schemas']['SshKeychainListItem'];
type SshTag = components['schemas']['SshTag'];

type SSHKeychainEditorFormProps = {
  formId?: string;
  formState: KeychainFormState;
  activeKeychain: SshKeychainListItem | null;
  isSubmitting: boolean;
  requiresPassword: boolean;
  requiresPrivateKey: boolean;
  folders: SshFolder[];
  tags: SshTag[];
  privateKeyContextMenuItems: InputContextMenuItem[];
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCreateFolder: (options?: { selectOnCreate?: boolean }) => void;
  onCreateTag: (name: string) => Promise<SshTag | null>;
  onChangeForm: <K extends keyof KeychainFormState>(key: K, value: KeychainFormState[K]) => void;
};

const NO_FOLDER_SELECT_VALUE = '__none__';
const CREATE_FOLDER_SELECT_VALUE = '__create_folder__';

/**
 * Renders the SSH keychain edit form body used by the keychain page.
 *
 * @param props Component props.
 * @returns Keychain editor form element.
 */
const SSHKeychainEditorForm: React.FC<SSHKeychainEditorFormProps> = ({
  formId = 'ssh-keychain-form',
  formState,
  activeKeychain,
  isSubmitting,
  requiresPassword,
  requiresPrivateKey,
  folders,
  tags,
  privateKeyContextMenuItems,
  onSubmit,
  onCreateFolder,
  onCreateTag,
  onChangeForm,
}) => {
  return (
    <Form
      id={formId}
      className="mx-auto grid max-w-4xl gap-4 pb-4"
      onSubmit={onSubmit}
    >
      <section className="grid gap-3">
        <div className="flex items-end justify-between gap-4">
          <EntityVisualPicker
            visual={{
              iconKey: formState.iconKey,
              colorKey: isEntityColorKey(formState.colorKey) ? formState.colorKey : 'emerald',
            }}
            label={t('home.iconSearchPlaceholder')}
            onChange={(nextVisual) => {
              onChangeForm('iconKey', nextVisual.iconKey);
              onChangeForm('colorKey', nextVisual.colorKey);
            }}
          >
            <button
              type="button"
              aria-label={t('home.editVisual')}
            >
              <EntityIcon
                icon={
                  <span
                    className={classNames(
                      'inline-flex h-full w-full items-center justify-center rounded-md',
                      getEntityColorClassName(isEntityColorKey(formState.colorKey) ? formState.colorKey : 'emerald'),
                    )}
                  >
                    {renderEntityIcon(formState.iconKey)}
                  </span>
                }
                tone="flat"
              />
            </button>
          </EntityVisualPicker>

          <FormField className="flex-1">
            <FormLabel htmlFor="ssh-keychain-name">{t('ssh.columnName')}</FormLabel>
            <FormControl>
              <Input
                id="ssh-keychain-name"
                value={formState.name}
                placeholder={t('ssh.serverNamePlaceholder')}
                className="w-[280px]"
                onChange={(event) => onChangeForm('name', event.target.value)}
              />
            </FormControl>
          </FormField>
        </div>
      </section>

      <section className="grid gap-3">
        <FormSectionHeading>{t('ssh.sectionAuthentication')}</FormSectionHeading>

        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <FormField>
            <FormLabel htmlFor="ssh-keychain-auth-type">{t('ssh.columnAuth')}</FormLabel>
            <FormControl>
              <Select
                value={formState.authType}
                onValueChange={(value) => {
                  if (value === 'password' || value === 'key' || value === 'both') {
                    onChangeForm('authType', value);
                  }
                }}
              >
                <SelectTrigger id="ssh-keychain-auth-type">
                  <SelectValue placeholder={t('ssh.authTypePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">{t('ssh.authTypePassword')}</SelectItem>
                  <SelectItem value="key">{t('ssh.authTypeKey')}</SelectItem>
                  <SelectItem value="both">{t('ssh.authTypeBoth')}</SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
          </FormField>
        </div>

        {requiresPassword ? (
          <FormField>
            <FormLabel htmlFor="ssh-keychain-password">{t('ssh.passwordLabel')}</FormLabel>
            <FormControl>
              <PasswordField
                id="ssh-keychain-password"
                value={formState.password}
                placeholder={
                  activeKeychain?.hasPassword ? t('ssh.passwordSavedPlaceholder') : t('ssh.passwordPlaceholder')
                }
                onChange={(event) => onChangeForm('password', event.target.value)}
              />
            </FormControl>
            {activeKeychain?.hasPassword && !formState.password.trim() ? (
              <FormMessage>{t('ssh.passwordSavedHint')}</FormMessage>
            ) : null}
          </FormField>
        ) : null}

        {requiresPrivateKey ? (
          <>
            <FormField>
              <FormLabel htmlFor="ssh-keychain-private-key">{t('ssh.privateKeyLabel')}</FormLabel>
              <FormControl>
                <Textarea
                  id="ssh-keychain-private-key"
                  rows={6}
                  value={formState.privateKey}
                  placeholder={
                    activeKeychain?.hasPrivateKey
                      ? t('ssh.privateKeySavedPlaceholder')
                      : t('ssh.privateKeyImportPlaceholder')
                  }
                  contextMenuItems={privateKeyContextMenuItems}
                  onChange={(event) => onChangeForm('privateKey', event.target.value)}
                />
              </FormControl>
              <FormMessage>
                {formState.privateKey.length > 0 && formState.privateKey.length < 32 ? t('ssh.privateKeyTooShort') : ''}
              </FormMessage>
            </FormField>

            <FormField>
              <FormLabel htmlFor="ssh-keychain-private-key-passphrase">{t('ssh.privateKeyPassphraseLabel')}</FormLabel>
              <FormControl>
                <PasswordField
                  id="ssh-keychain-private-key-passphrase"
                  value={formState.privateKeyPassphrase}
                  placeholder={t('ssh.optionalPlaceholder')}
                  onChange={(event) => onChangeForm('privateKeyPassphrase', event.target.value)}
                />
              </FormControl>
            </FormField>
          </>
        ) : null}
      </section>

      <section className="grid gap-3">
        <FormSectionHeading>{t('ssh.sectionSettings')}</FormSectionHeading>
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <FormField>
            <FormLabel htmlFor="ssh-keychain-folder">{t('sshKeychain.folderLabel')}</FormLabel>
            <FormControl>
              <Select
                value={formState.folderId || NO_FOLDER_SELECT_VALUE}
                onValueChange={(value) => {
                  if (value === CREATE_FOLDER_SELECT_VALUE) {
                    onCreateFolder({ selectOnCreate: true });
                    return;
                  }

                  onChangeForm('folderId', value === NO_FOLDER_SELECT_VALUE ? '' : value);
                }}
              >
                <SelectTrigger id="ssh-keychain-folder">
                  <SelectValue placeholder={t('sshKeychain.folderPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FOLDER_SELECT_VALUE}>{t('sshKeychain.noFolder')}</SelectItem>
                  {folders.map((folder) => (
                    <SSHFolderSelectItem
                      key={folder.id}
                      folder={folder}
                    />
                  ))}
                  <SelectSeparator />
                  <SelectItem
                    value={CREATE_FOLDER_SELECT_VALUE}
                    icon={FolderPlus}
                  >
                    {t('sshKeychain.createFolderAction')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
          </FormField>

          <FormField>
            <FormLabel htmlFor="ssh-keychain-tags">{t('sshKeychain.tagsLabel')}</FormLabel>
            <FormControl>
              <TagInput
                inputId="ssh-keychain-tags"
                tags={tags}
                selectedTagIds={formState.tagIds}
                menuTitle={t('sshKeychain.tagsLabel')}
                inputPlaceholder={t('sshKeychain.tagPlaceholder')}
                emptyText={t('ssh.emptyTags')}
                removeTagLabel={(tagName) => t('sshKeychain.removeTagLabel', { tagName })}
                disabled={isSubmitting}
                onCreateTag={onCreateTag}
                onSelectedTagIdsChange={(nextTagIds) => onChangeForm('tagIds', nextTagIds)}
              />
            </FormControl>
          </FormField>
        </div>
        <FormField>
          <FormLabel htmlFor="ssh-keychain-note">{t('ssh.noteLabel')}</FormLabel>
          <FormControl>
            <Textarea
              id="ssh-keychain-note"
              rows={4}
              value={formState.note}
              placeholder={t('ssh.notePlaceholder')}
              onChange={(event) => onChangeForm('note', event.target.value)}
            />
          </FormControl>
        </FormField>
      </section>
    </Form>
  );
};

export default SSHKeychainEditorForm;
