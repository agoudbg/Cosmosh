import type { components } from '@cosmosh/api-contract';
import { validateProxyUrl } from '@cosmosh/api-contract';

import { createSshServer, createSshTag, updateSshServer } from './backend';
import { isEntityColorKey } from './entity-visuals';
import type { KeychainEditorInitialFormState } from './ssh-keychain-editor-shared';
import {
  parsePort,
  type ServerEditorFormState,
  type SshAuthType,
  type SshServerListItem,
} from './ssh-server-editor-shared';

type SshTag = components['schemas']['SshTag'];

type CreateServerEditorTagParams = {
  name: string;
  tags: SshTag[];
  onTagCreated: (tag: SshTag) => void;
  onError: (message: string) => void;
  createTagFailedMessage: string;
};

/**
 * Creates a tag by name only when it does not exist yet and returns the resolved tag.
 *
 * @param params Tag creation parameters.
 * @param params.name User-entered tag name.
 * @param params.tags Current known tags.
 * @param params.onTagCreated Callback to append a newly created tag.
 * @param params.onError Error notifier callback.
 * @param params.createTagFailedMessage Localized fallback error message.
 * @returns The existing/created tag, or null when creation is aborted/failed.
 */
export const createServerEditorTag = async ({
  name,
  tags,
  onTagCreated,
  onError,
  createTagFailedMessage,
}: CreateServerEditorTagParams): Promise<SshTag | null> => {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  const existingTag = tags.find((tag) => tag.name.toLowerCase() === normalizedName.toLowerCase());
  if (existingTag) {
    return existingTag;
  }

  try {
    const createdResponse = await createSshTag({ name: normalizedName });
    const createdTag = createdResponse.data.item;
    onTagCreated(createdTag);
    return createdTag;
  } catch (error: unknown) {
    onError(error instanceof Error ? error.message : createTagFailedMessage);
    return null;
  }
};

/**
 * Credential fields that were intentionally submitted with a server save request.
 */
export type ServerCredentialSubmission = {
  authType: SshAuthType;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
};

type SaveServerFromEditorParams = {
  serverId: string | null;
  activeServer: SshServerListItem | null;
  formState: ServerEditorFormState;
  isUsingInlineCredentials: boolean;
  requiresPassword: boolean;
  requiresPrivateKey: boolean;
  onWarning: (message: string) => void;
  validationRequiredFieldsMessage: string;
  validationInvalidPortMessage: string;
  validationServerNotFoundMessage: string;
  validationPasswordRequiredMessage: string;
  validationPrivateKeyRequiredMessage: string;
  validationProxyUrlMessage: string;
};

/**
 * Persisted server result plus the credential fields needed to refresh local editor caches.
 */
export type SaveServerFromEditorResult = {
  savedServer: SshServerListItem;
  submittedCredentialPayload: ServerCredentialSubmission;
};

/**
 * Persists SSH server editor form state with validation shared by the full editor and dialog editor.
 *
 * @param params Save parameters.
 * @param params.serverId Server id in edit mode, null in create mode.
 * @param params.activeServer Active server metadata used for credential placeholder validation.
 * @param params.formState Current server form state.
 * @param params.isUsingInlineCredentials Whether credentials should be submitted with the server payload.
 * @param params.requiresPassword Whether password is required by current credential mode.
 * @param params.requiresPrivateKey Whether private key is required by current credential mode.
 * @param params.onWarning Warning notifier callback.
 * @param params.validationRequiredFieldsMessage Localized required-fields warning.
 * @param params.validationInvalidPortMessage Localized invalid-port warning.
 * @param params.validationServerNotFoundMessage Localized missing-server warning.
 * @param params.validationPasswordRequiredMessage Localized password-required warning.
 * @param params.validationPrivateKeyRequiredMessage Localized private-key-required warning.
 * @returns Save result containing persisted server and submitted credential payload, or null when validation blocks save.
 */
export const saveServerFromEditor = async ({
  serverId,
  activeServer,
  formState,
  isUsingInlineCredentials,
  requiresPassword,
  requiresPrivateKey,
  onWarning,
  validationRequiredFieldsMessage,
  validationInvalidPortMessage,
  validationServerNotFoundMessage,
  validationPasswordRequiredMessage,
  validationPrivateKeyRequiredMessage,
  validationProxyUrlMessage,
}: SaveServerFromEditorParams): Promise<SaveServerFromEditorResult | null> => {
  const port = parsePort(formState.port);
  if (!formState.name.trim() || !formState.host.trim() || !formState.username.trim()) {
    onWarning(validationRequiredFieldsMessage);
    return null;
  }

  if (port === null) {
    onWarning(validationInvalidPortMessage);
    return null;
  }

  if (serverId && !activeServer) {
    onWarning(validationServerNotFoundMessage);
    return null;
  }

  if (requiresPassword && !formState.password.trim() && !activeServer?.hasPassword) {
    onWarning(validationPasswordRequiredMessage);
    return null;
  }

  if (requiresPrivateKey && !formState.privateKey.trim() && !activeServer?.hasPrivateKey) {
    onWarning(validationPrivateKeyRequiredMessage);
    return null;
  }

  if (formState.proxyMode === 'custom' && !validateProxyUrl(formState.proxyUrl).valid) {
    onWarning(validationProxyUrlMessage);
    return null;
  }

  const selectedKeychainId = isUsingInlineCredentials ? undefined : formState.keychainId || undefined;
  const submittedCredentialPayload: ServerCredentialSubmission = {
    authType: formState.authType,
    password: formState.password.trim() || undefined,
    privateKey: formState.privateKey.trim() || undefined,
    privateKeyPassphrase: formState.privateKeyPassphrase.trim() || undefined,
  };
  const payload = {
    name: formState.name.trim(),
    host: formState.host.trim(),
    port,
    username: formState.username.trim(),
    keychainId: selectedKeychainId,
    authType: isUsingInlineCredentials ? submittedCredentialPayload.authType : undefined,
    iconKey: formState.iconKey,
    colorKey: isEntityColorKey(formState.colorKey) ? formState.colorKey : undefined,
    password: isUsingInlineCredentials ? submittedCredentialPayload.password : undefined,
    privateKey: isUsingInlineCredentials ? submittedCredentialPayload.privateKey : undefined,
    privateKeyPassphrase: isUsingInlineCredentials ? submittedCredentialPayload.privateKeyPassphrase : undefined,
    folderId: formState.folderId || undefined,
    tagIds: formState.tagIds,
    note: formState.note.trim() || undefined,
    strictHostKey: formState.strictHostKey,
    enableSshCompression: formState.enableSshCompression,
    disableCharacterWidthCompatibilityMode: formState.disableCharacterWidthCompatibilityMode,
    terminalClipboardAccess: formState.terminalClipboardAccess,
    proxyMode: formState.proxyMode,
    proxyUrl: formState.proxyUrl.trim() || undefined,
  };

  const savedServer = serverId
    ? (await updateSshServer(serverId, payload)).data.item
    : (await createSshServer(payload)).data.item;

  return {
    savedServer,
    submittedCredentialPayload,
  };
};

type InlineCredentialKeychainDraftSource = Pick<
  ServerEditorFormState,
  | 'name'
  | 'iconKey'
  | 'colorKey'
  | 'authType'
  | 'password'
  | 'privateKey'
  | 'privateKeyPassphrase'
  | 'folderId'
  | 'tagIds'
>;

/**
 * Builds keychain editor draft values from inline server credential fields.
 *
 * @param formState Source server form values.
 * @returns Initial keychain dialog form state.
 */
export const buildInlineCredentialKeychainEditorFormState = (
  formState: InlineCredentialKeychainDraftSource,
): KeychainEditorInitialFormState => {
  return {
    name: formState.name.trim() ? `${formState.name.trim()} Keychain` : '',
    iconKey: formState.iconKey,
    colorKey: formState.colorKey,
    authType: formState.authType,
    password: formState.password,
    privateKey: formState.privateKey,
    privateKeyPassphrase: formState.privateKeyPassphrase,
    folderId: formState.folderId,
    tagIds: [...formState.tagIds],
  };
};
