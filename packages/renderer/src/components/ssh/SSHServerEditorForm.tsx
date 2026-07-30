import type { components } from '@cosmosh/api-contract';
import {
  DEFAULT_MCP_SERVER_COMMAND_POLICY,
  DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
  isMcpServerCommandPolicy,
  isTerminalClipboardAccess,
  MCP_SERVER_COMMAND_POLICY_OPTIONS,
  type McpServerCommandPolicy,
  type SshServerProxyMode,
  TERMINAL_CLIPBOARD_ACCESS_OPTIONS,
  type TerminalClipboardAccess,
} from '@cosmosh/api-contract';
import classNames from 'classnames';
import { Edit, FolderPlus, Network, Save, Server, Sparkles, Wrench } from 'lucide-react';
import React from 'react';

import { getEntityColorClassName, isEntityColorKey, renderEntityIcon } from '../../lib/entity-visuals';
import { t } from '../../lib/i18n';
import EntityIcon from '../home/EntityIcon';
import EntityVisualPicker from '../home/EntityVisualPicker';
import SplitWorkbenchLayout, { SplitWorkbenchMainPanel } from '../layout/SplitWorkbenchLayout';
import { Button } from '../ui/button';
import { Form, FormControl, FormField, FormLabel, FormMessage, FormSectionHeading } from '../ui/form';
import { FormLabelWithTooltip } from '../ui/form-label-with-tooltip';
import { formStyles } from '../ui/form-styles';
import { Input } from '../ui/input';
import type { InputContextMenuItem } from '../ui/input-context-menu-registry';
import { LabelWithTooltip } from '../ui/label-with-tooltip';
import { PasswordField } from '../ui/password-field';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { SidebarNav, type SidebarNavItem } from '../ui/sidebar-nav';
import { Switch } from '../ui/switch';
import { TagInput } from '../ui/tag-input';
import { Textarea } from '../ui/textarea';
import SSHFolderSelectItem from './SSHFolderSelectItem';

type SshAuthType = components['schemas']['SshAuthType'];
type SshFolder = components['schemas']['SshFolder'];
type SshKeychainListItem = components['schemas']['SshKeychainListItem'];
type SshServerListItem = components['schemas']['SshServerListItem'];
type SshTag = components['schemas']['SshTag'];

type ServerEditorFormState = {
  name: string;
  iconKey: string;
  colorKey: string;
  note: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  keychainId: string;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  folderId: string;
  tagIds: string[];
  strictHostKey: boolean;
  enableSshCompression: boolean;
  remoteEnhancementsEnabled: boolean;
  disableCharacterWidthCompatibilityMode: boolean;
  terminalClipboardAccess: TerminalClipboardAccess;
  mcpCommandPolicy: McpServerCommandPolicy;
  proxyMode: SshServerProxyMode;
  proxyUrl: string;
};

type SSHServerEditorFormProps = {
  formId?: string;
  formState: ServerEditorFormState;
  activeServer: SshServerListItem | null;
  isSubmitting: boolean;
  sharedKeychains: SshKeychainListItem[];
  folders: SshFolder[];
  tags: SshTag[];
  keychainSelectValue: string;
  isUsingInlineCredentials: boolean;
  requiresPassword: boolean;
  requiresPrivateKey: boolean;
  privateKeyContextMenuItems: InputContextMenuItem[];
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onHostChange: (nextHost: string) => void;
  onCreateFolder: (options?: { selectOnCreate?: boolean }) => void;
  onCreateTag: (name: string) => Promise<SshTag | null>;
  onOpenSelectedKeychainEditor: () => void;
  onSaveInlineCredentialsToSharedKeychain: () => void | Promise<void>;
  onKeychainSelectValueChange: (value: string) => void;
  onChangeForm: <K extends keyof ServerEditorFormState>(key: K, value: ServerEditorFormState[K]) => void;
};

const NO_FOLDER_SELECT_VALUE = '__none__';
const CREATE_FOLDER_SELECT_VALUE = '__create_folder__';

type ServerEditorCategoryId = 'information' | 'connection' | 'enhancements' | 'advanced';

const SERVER_EDITOR_CATEGORY_IDS = [
  'information',
  'connection',
  'enhancements',
  'advanced',
] as const satisfies readonly ServerEditorCategoryId[];

const serverEditorCategoryIconMap: Record<ServerEditorCategoryId, React.ComponentType<{ className?: string }>> = {
  information: Server,
  connection: Network,
  enhancements: Sparkles,
  advanced: Wrench,
};

/**
 * Renders the SSH server edit form body used by the SSH editor page.
 *
 * @param props Component props.
 * @returns Server editor form element.
 */
const SSHServerEditorForm: React.FC<SSHServerEditorFormProps> = ({
  formId = 'ssh-editor-form',
  formState,
  activeServer,
  isSubmitting,
  sharedKeychains,
  folders,
  tags,
  keychainSelectValue,
  isUsingInlineCredentials,
  requiresPassword,
  requiresPrivateKey,
  privateKeyContextMenuItems,
  onSubmit,
  onHostChange,
  onCreateFolder,
  onCreateTag,
  onOpenSelectedKeychainEditor,
  onSaveInlineCredentialsToSharedKeychain,
  onKeychainSelectValueChange,
  onChangeForm,
}) => {
  const contentStartRef = React.useRef<HTMLDivElement | null>(null);
  const [activeCategoryId, setActiveCategoryId] = React.useState<ServerEditorCategoryId>('information');

  React.useLayoutEffect(() => {
    // Each category is a separate settings surface and should open from its first field.
    contentStartRef.current?.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'nearest' });
  }, [activeCategoryId]);

  const categoryItems = SERVER_EDITOR_CATEGORY_IDS.map((categoryId): SidebarNavItem<ServerEditorCategoryId> => {
    const Icon = serverEditorCategoryIconMap[categoryId];

    return {
      icon: <Icon className="h-4 w-4" />,
      id: categoryId,
      label: t(`ssh.serverEditorCategories.${categoryId}`),
    };
  });

  return (
    <Form
      id={formId}
      className="h-full min-h-0 !gap-0"
      onSubmit={onSubmit}
    >
      <SplitWorkbenchLayout
        sidebar={
          <div className="gutter-box-y min-h-0 flex-1 overflow-auto pb-2">
            <SidebarNav
              activeId={activeCategoryId}
              ariaLabel={t('ssh.serverEditorCategoryNavLabel')}
              items={categoryItems}
              onSelect={setActiveCategoryId}
            />
          </div>
        }
        sidebarClassName="flex h-full w-[175px] shrink-0 flex-col"
        main={
          <SplitWorkbenchMainPanel
            header={null}
            headerClassName="hidden"
            body={
              <div className="mx-auto max-w-4xl pb-4">
                <div
                  ref={contentStartRef}
                  aria-hidden="true"
                />

                <div className="grid gap-8">
                  <section className={activeCategoryId === 'information' ? 'grid gap-3' : 'hidden'}>
                    <div className="flex items-end justify-between gap-4">
                      <FormField className="flex-1">
                        <FormLabel htmlFor="ssh-editor-name">{t('ssh.columnName')}</FormLabel>
                        <FormControl className="flex items-center gap-2">
                          <div className="ms-2.5">
                            <EntityVisualPicker
                              visual={{
                                iconKey: formState.iconKey,
                                colorKey: isEntityColorKey(formState.colorKey) ? formState.colorKey : 'blue',
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
                                        getEntityColorClassName(
                                          isEntityColorKey(formState.colorKey) ? formState.colorKey : 'blue',
                                        ),
                                      )}
                                    >
                                      {renderEntityIcon(formState.iconKey)}
                                    </span>
                                  }
                                  tone="flat"
                                />
                              </button>
                            </EntityVisualPicker>
                          </div>
                          <Input
                            id="ssh-editor-name"
                            value={formState.name}
                            placeholder={t('ssh.serverNamePlaceholder')}
                            className="min-w-0 flex-1"
                            onChange={(event) => onChangeForm('name', event.target.value)}
                          />
                        </FormControl>
                      </FormField>
                    </div>
                  </section>

                  <section className={activeCategoryId === 'connection' ? 'grid gap-3' : 'hidden'}>
                    <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-[5fr_2fr]">
                      <FormField>
                        <FormLabel htmlFor="ssh-editor-host">{t('ssh.columnHost')}</FormLabel>
                        <FormControl>
                          <Input
                            id="ssh-editor-host"
                            value={formState.host}
                            placeholder={t('ssh.hostPlaceholder')}
                            onChange={(event) => onHostChange(event.target.value)}
                          />
                        </FormControl>
                      </FormField>

                      <FormField>
                        <FormLabel htmlFor="ssh-editor-port">{t('ssh.columnPort')}</FormLabel>
                        <FormControl>
                          <Input
                            id="ssh-editor-port"
                            value={formState.port}
                            placeholder={t('ssh.portPlaceholder')}
                            inputMode="numeric"
                            onChange={(event) => onChangeForm('port', event.target.value)}
                          />
                        </FormControl>
                      </FormField>
                    </div>
                  </section>

                  <section className={activeCategoryId === 'connection' ? 'grid gap-3' : 'hidden'}>
                    <FormSectionHeading>{t('ssh.sectionAuthentication')}</FormSectionHeading>

                    <div className="grid gap-3">
                      <FormField>
                        <FormLabel htmlFor="ssh-editor-username">{t('ssh.columnUser')}</FormLabel>
                        <FormControl>
                          <Input
                            id="ssh-editor-username"
                            value={formState.username}
                            placeholder={t('ssh.usernamePlaceholder')}
                            onChange={(event) => onChangeForm('username', event.target.value)}
                          />
                        </FormControl>
                      </FormField>

                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                        <FormField>
                          <FormLabel htmlFor="ssh-editor-keychain">{t('ssh.keychainLabel')}</FormLabel>
                          <FormControl>
                            <Select
                              value={keychainSelectValue}
                              onValueChange={(value) => {
                                onKeychainSelectValueChange(value);
                              }}
                            >
                              <SelectTrigger id="ssh-editor-keychain">
                                <SelectValue placeholder={t('ssh.keychainSelectPlaceholder')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={SSH_SERVER_INLINE_KEYCHAIN_SELECT_VALUE}>
                                  {t('ssh.keychainOptionInline')}
                                </SelectItem>
                                {sharedKeychains.length > 0 && <SelectSeparator />}
                                {sharedKeychains.map((keychain) => (
                                  <SelectItem
                                    key={keychain.id}
                                    value={keychain.id}
                                  >
                                    {keychain.name}
                                  </SelectItem>
                                ))}
                                <SelectSeparator />
                                <SelectItem value={SSH_SERVER_ADD_KEYCHAIN_SELECT_VALUE}>
                                  {t('ssh.keychainOptionCreate')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </FormControl>
                        </FormField>

                        <FormField>
                          <FormLabel>&nbsp;</FormLabel>
                          <FormControl>
                            {!isUsingInlineCredentials ? (
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={onOpenSelectedKeychainEditor}
                              >
                                <Edit size={16} />
                                {t('ssh.keychainEditCredentials')}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                disabled={isSubmitting}
                                onClick={() => {
                                  void onSaveInlineCredentialsToSharedKeychain();
                                }}
                              >
                                <Save size={16} />
                                {t('ssh.saveInlineCredentialsToKeychain')}
                              </Button>
                            )}
                          </FormControl>
                        </FormField>
                      </div>
                    </div>

                    {isUsingInlineCredentials ? (
                      <FormField>
                        <FormLabel htmlFor="ssh-editor-auth-type">{t('ssh.columnAuth')}</FormLabel>
                        <FormControl>
                          <Select
                            value={formState.authType}
                            onValueChange={(value) => {
                              if (value === 'password' || value === 'key' || value === 'both') {
                                onChangeForm('authType', value);
                              }
                            }}
                          >
                            <SelectTrigger id="ssh-editor-auth-type">
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
                    ) : null}

                    {requiresPassword ? (
                      <FormField>
                        <FormLabel htmlFor="ssh-editor-password">{t('ssh.passwordLabel')}</FormLabel>
                        <FormControl>
                          <PasswordField
                            id="ssh-editor-password"
                            value={formState.password}
                            placeholder={
                              activeServer?.hasPassword
                                ? t('ssh.passwordSavedPlaceholder')
                                : t('ssh.passwordPlaceholder')
                            }
                            onChange={(event) => onChangeForm('password', event.target.value)}
                          />
                        </FormControl>
                        {activeServer?.hasPassword && !formState.password.trim() ? (
                          <FormMessage>{t('ssh.passwordSavedHint')}</FormMessage>
                        ) : null}
                      </FormField>
                    ) : null}

                    {requiresPrivateKey ? (
                      <>
                        <FormField>
                          <FormLabel htmlFor="ssh-editor-private-key">{t('ssh.privateKeyLabel')}</FormLabel>
                          <FormControl>
                            <Textarea
                              id="ssh-editor-private-key"
                              value={formState.privateKey}
                              placeholder={
                                activeServer?.hasPrivateKey
                                  ? t('ssh.privateKeySavedPlaceholder')
                                  : t('ssh.privateKeyImportPlaceholder')
                              }
                              rows={5}
                              contextMenuItems={privateKeyContextMenuItems}
                              onChange={(event) => onChangeForm('privateKey', event.target.value)}
                            />
                          </FormControl>
                          <FormMessage>
                            {formState.privateKey.length > 0 && formState.privateKey.length < 32
                              ? t('ssh.privateKeyTooShort')
                              : ''}
                          </FormMessage>
                        </FormField>

                        <FormField>
                          <FormLabel htmlFor="ssh-editor-private-key-passphrase">
                            {t('ssh.privateKeyPassphraseLabel')}
                          </FormLabel>
                          <FormControl>
                            <PasswordField
                              id="ssh-editor-private-key-passphrase"
                              value={formState.privateKeyPassphrase}
                              placeholder={t('ssh.optionalPlaceholder')}
                              onChange={(event) => onChangeForm('privateKeyPassphrase', event.target.value)}
                            />
                          </FormControl>
                        </FormField>
                      </>
                    ) : null}
                  </section>

                  <section className={activeCategoryId === 'enhancements' ? 'grid gap-8' : 'hidden'}>
                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionTerminalEnhancements')}</FormSectionHeading>
                      <div className="flex items-center gap-2.5 px-2.5">
                        <Switch
                          id="ssh-editor-remote-enhancements"
                          checked={formState.remoteEnhancementsEnabled}
                          onCheckedChange={(checkedState) => onChangeForm('remoteEnhancementsEnabled', checkedState)}
                        />
                        <LabelWithTooltip
                          htmlFor="ssh-editor-remote-enhancements"
                          tooltip={t('ssh.remoteEnhancementsTooltip')}
                          labelClassName={formStyles.inlineLabel}
                        >
                          {t('ssh.remoteEnhancements')}
                        </LabelWithTooltip>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionClipboardPermissions')}</FormSectionHeading>
                      <FormField>
                        <FormLabelWithTooltip
                          htmlFor="ssh-editor-terminal-clipboard-access"
                          tooltip={t('ssh.terminalClipboardAccessHint')}
                        >
                          {t('ssh.terminalClipboardAccessLabel')}
                        </FormLabelWithTooltip>
                        <FormControl>
                          <Select
                            value={formState.terminalClipboardAccess}
                            onValueChange={(value) => {
                              onChangeForm(
                                'terminalClipboardAccess',
                                isTerminalClipboardAccess(value) ? value : DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
                              );
                            }}
                          >
                            <SelectTrigger id="ssh-editor-terminal-clipboard-access">
                              <SelectValue placeholder={t('ssh.terminalClipboardAccessPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {TERMINAL_CLIPBOARD_ACCESS_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option}
                                  value={option}
                                >
                                  {t(`ssh.terminalClipboardAccessOptions.${option}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormField>
                    </div>

                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionMcp')}</FormSectionHeading>
                      <FormField>
                        <FormLabelWithTooltip
                          htmlFor="ssh-editor-mcp-command-policy"
                          tooltip={t('ssh.mcpCommandPolicyHint')}
                        >
                          {t('ssh.mcpCommandPolicyLabel')}
                        </FormLabelWithTooltip>
                        <FormControl>
                          <Select
                            value={formState.mcpCommandPolicy}
                            onValueChange={(value) => {
                              onChangeForm(
                                'mcpCommandPolicy',
                                isMcpServerCommandPolicy(value) ? value : DEFAULT_MCP_SERVER_COMMAND_POLICY,
                              );
                            }}
                          >
                            <SelectTrigger id="ssh-editor-mcp-command-policy">
                              <SelectValue placeholder={t('ssh.mcpCommandPolicyPlaceholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {MCP_SERVER_COMMAND_POLICY_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option}
                                  value={option}
                                >
                                  {t(`ssh.mcpCommandPolicyOptions.${option}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormField>
                    </div>
                  </section>

                  <section className={activeCategoryId === 'advanced' ? 'grid gap-8' : 'hidden'}>
                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionProxy')}</FormSectionHeading>
                      <FormField>
                        <FormLabelWithTooltip
                          htmlFor="ssh-editor-proxy-mode"
                          tooltip={t('ssh.proxyModeHint')}
                        >
                          {t('ssh.proxyModeLabel')}
                        </FormLabelWithTooltip>
                        <FormControl>
                          <Select
                            value={formState.proxyMode}
                            onValueChange={(value) => {
                              if (value === 'default' || value === 'off' || value === 'custom') {
                                onChangeForm('proxyMode', value);
                              }
                            }}
                          >
                            <SelectTrigger id="ssh-editor-proxy-mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">{t('ssh.proxyModeOptions.default')}</SelectItem>
                              <SelectItem value="off">{t('ssh.proxyModeOptions.off')}</SelectItem>
                              <SelectItem value="custom">{t('ssh.proxyModeOptions.custom')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormField>
                      {formState.proxyMode === 'custom' ? (
                        <FormField>
                          <FormLabelWithTooltip
                            htmlFor="ssh-editor-proxy-url"
                            tooltip={t('ssh.proxyUrlHint')}
                          >
                            {t('ssh.proxyUrlLabel')}
                          </FormLabelWithTooltip>
                          <FormControl>
                            <Input
                              id="ssh-editor-proxy-url"
                              value={formState.proxyUrl}
                              placeholder={t('ssh.proxyUrlPlaceholder')}
                              inputMode="url"
                              onChange={(event) => onChangeForm('proxyUrl', event.target.value)}
                            />
                          </FormControl>
                        </FormField>
                      ) : null}
                    </div>

                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionSecurity')}</FormSectionHeading>
                      <div className="flex items-center gap-2.5 px-2.5">
                        <Switch
                          id="ssh-editor-strict-host-key"
                          checked={formState.strictHostKey}
                          onCheckedChange={(checkedState) => onChangeForm('strictHostKey', checkedState)}
                        />
                        <LabelWithTooltip
                          htmlFor="ssh-editor-strict-host-key"
                          tooltip={t('ssh.strictHostKeyCheckingTooltip')}
                          labelClassName={formStyles.inlineLabel}
                        >
                          {t('ssh.strictHostKeyChecking')}
                        </LabelWithTooltip>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionCompatibility')}</FormSectionHeading>
                      <div className="flex items-center gap-2.5 px-2.5">
                        <Switch
                          id="ssh-editor-disable-character-width-compatibility-mode"
                          checked={formState.disableCharacterWidthCompatibilityMode}
                          onCheckedChange={(checkedState) =>
                            onChangeForm('disableCharacterWidthCompatibilityMode', checkedState)
                          }
                        />
                        <LabelWithTooltip
                          htmlFor="ssh-editor-disable-character-width-compatibility-mode"
                          tooltip={t('ssh.disableCharacterWidthCompatibilityModeTooltip')}
                          labelClassName={formStyles.inlineLabel}
                        >
                          {t('ssh.disableCharacterWidthCompatibilityMode')}
                        </LabelWithTooltip>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      <FormSectionHeading>{t('ssh.sectionTransport')}</FormSectionHeading>
                      <div className="flex items-center gap-2.5 px-2.5">
                        <Switch
                          id="ssh-editor-enable-compression"
                          checked={formState.enableSshCompression}
                          onCheckedChange={(checkedState) => onChangeForm('enableSshCompression', checkedState)}
                        />
                        <LabelWithTooltip
                          htmlFor="ssh-editor-enable-compression"
                          tooltip={t('ssh.enableSshCompressionTooltip')}
                          labelClassName={formStyles.inlineLabel}
                        >
                          {t('ssh.enableSshCompression')}
                        </LabelWithTooltip>
                      </div>
                    </div>
                  </section>

                  <section className={activeCategoryId === 'information' ? 'grid gap-3' : 'hidden'}>
                    <FormSectionHeading>{t('ssh.sectionSettings')}</FormSectionHeading>

                    <div className="grid gap-3">
                      <FormField>
                        <FormLabel htmlFor="ssh-editor-folder">{t('ssh.columnFolder')}</FormLabel>
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
                            <SelectTrigger id="ssh-editor-folder">
                              <SelectValue placeholder={t('ssh.noFolder')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_FOLDER_SELECT_VALUE}>{t('ssh.noFolder')}</SelectItem>
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
                                {t('home.quickAddFolder')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormField>

                      <FormField>
                        <FormLabel htmlFor="ssh-editor-tags">{t('ssh.tagsLegend')}</FormLabel>
                        <FormControl>
                          <TagInput
                            inputId="ssh-editor-tags"
                            tags={tags}
                            selectedTagIds={formState.tagIds}
                            menuTitle={t('ssh.tagsLegend')}
                            inputPlaceholder={t('ssh.tagNamePlaceholder')}
                            emptyText={t('ssh.emptyTags')}
                            removeTagLabel={(tagName) => t('ssh.removeTagLabel', { tagName })}
                            disabled={isSubmitting}
                            onSelectedTagIdsChange={(nextTagIds) => onChangeForm('tagIds', nextTagIds)}
                            onCreateTag={onCreateTag}
                          />
                        </FormControl>
                      </FormField>
                    </div>

                    <FormField>
                      <FormLabel htmlFor="ssh-editor-note">{t('ssh.noteLabel')}</FormLabel>
                      <FormControl>
                        <Textarea
                          id="ssh-editor-note"
                          value={formState.note}
                          placeholder={t('ssh.notePlaceholder')}
                          rows={4}
                          onChange={(event) => onChangeForm('note', event.target.value)}
                        />
                      </FormControl>
                    </FormField>
                  </section>
                </div>
              </div>
            }
          />
        }
      />
    </Form>
  );
};

export const SSH_SERVER_INLINE_KEYCHAIN_SELECT_VALUE = '__inline_keychain__';
export const SSH_SERVER_ADD_KEYCHAIN_SELECT_VALUE = '__add_keychain__';

export default SSHServerEditorForm;
