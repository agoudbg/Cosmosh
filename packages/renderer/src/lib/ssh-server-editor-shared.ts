import type { components } from '@cosmosh/api-contract';
import {
  DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
  type SshServerProxyMode,
  type TerminalClipboardAccess,
} from '@cosmosh/api-contract';

import { pickRandomEntityVisual } from './entity-visuals';

export type SshAuthType = components['schemas']['SshAuthType'];
export type SshServerListItem = components['schemas']['SshServerListItem'];
export type SshKeychainListItem = components['schemas']['SshKeychainListItem'];

export type ServerEditorFormState = {
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
  disableCharacterWidthCompatibilityMode: boolean;
  terminalClipboardAccess: TerminalClipboardAccess;
  proxyMode: SshServerProxyMode;
  proxyUrl: string;
};

export type ServerCredentialCache = {
  authType: SshAuthType;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
};

export type ServerEditorCredentialMode = {
  selectedKeychain: SshKeychainListItem | null;
  sharedKeychains: SshKeychainListItem[];
  isUsingHiddenKeychain: boolean;
  isUsingInlineCredentials: boolean;
  requiresPassword: boolean;
  requiresPrivateKey: boolean;
};

export type CredentialRequirementMode = {
  requiresPassword: boolean;
  requiresPrivateKey: boolean;
};

/**
 * Normalizes a server credential snapshot from backend responses.
 *
 * @param snapshot Backend credential snapshot.
 * @returns Normalized credential cache shape used by the editor state.
 */
export const mapCredentialSnapshotToCache = (snapshot: {
  authType: SshAuthType;
  password?: string | null;
  privateKey?: string | null;
  privateKeyPassphrase?: string | null;
}): ServerCredentialCache => {
  return {
    authType: snapshot.authType,
    password: snapshot.password ?? '',
    privateKey: snapshot.privateKey ?? '',
    privateKeyPassphrase: snapshot.privateKeyPassphrase ?? '',
  };
};

/**
 * Applies submitted credential fields to the local cache while preserving existing values
 * for fields intentionally omitted from update payloads.
 *
 * @param previousCredentials The last cached credentials for the server.
 * @param submittedPayload The credential fields sent to the backend.
 * @returns The next cache snapshot that matches submitted intent.
 */
export const applySubmittedCredentialsToCache = (
  previousCredentials: ServerCredentialCache | undefined,
  submittedPayload: {
    authType: SshAuthType;
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
  },
): ServerCredentialCache => {
  return {
    authType: submittedPayload.authType,
    password: submittedPayload.password ?? previousCredentials?.password ?? '',
    privateKey: submittedPayload.privateKey ?? previousCredentials?.privateKey ?? '',
    privateKeyPassphrase: submittedPayload.privateKeyPassphrase ?? previousCredentials?.privateKeyPassphrase ?? '',
  };
};

export const createInitialServerFormState = (defaultServerNoteTemplate = ''): ServerEditorFormState => {
  const visual = pickRandomEntityVisual('server', `${Date.now()}:${Math.random()}`);

  return {
    name: '',
    iconKey: visual.iconKey,
    colorKey: visual.colorKey,
    note: defaultServerNoteTemplate,
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    keychainId: '',
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    folderId: '',
    tagIds: [],
    strictHostKey: true,
    enableSshCompression: false,
    disableCharacterWidthCompatibilityMode: false,
    terminalClipboardAccess: DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
    proxyMode: 'default',
    proxyUrl: '',
  };
};

export const parsePort = (value: string): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
};

export const mapServerToFormState = (server: SshServerListItem): ServerEditorFormState => {
  return {
    name: server.name,
    iconKey: server.iconKey,
    colorKey: server.colorKey,
    note: server.note ?? '',
    host: server.host,
    port: String(server.port),
    username: server.username,
    authType: server.authType,
    keychainId: server.keychainId,
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
    folderId: server.folder?.id ?? '',
    tagIds: (server.tags ?? []).map((tag) => tag.id),
    strictHostKey: server.strictHostKey ?? true,
    enableSshCompression: server.enableSshCompression ?? false,
    disableCharacterWidthCompatibilityMode: server.disableCharacterWidthCompatibilityMode ?? false,
    terminalClipboardAccess: server.terminalClipboardAccess ?? DEFAULT_TERMINAL_CLIPBOARD_ACCESS,
    proxyMode: server.proxyMode ?? 'default',
    proxyUrl: server.proxyUrl ?? '',
  };
};

/**
 * Derives auth-type-only credential requirements.
 *
 * @param authType Authentication type selected in form state.
 * @returns Credential requirement flags independent of keychain selection.
 */
export const deriveCredentialMode = (authType: SshAuthType): CredentialRequirementMode => {
  return {
    requiresPassword: authType === 'password' || authType === 'both',
    requiresPrivateKey: authType === 'key' || authType === 'both',
  };
};

/**
 * Derives credential mode flags from keychain selection and auth type.
 *
 * @param params Derivation input values.
 * @param params.keychainId Currently selected keychain id from form state.
 * @param params.keychains Available keychain options.
 * @param params.authType Authentication type selected in form state.
 * @returns Derived credential mode values for rendering and validation.
 */
export const deriveServerEditorCredentialMode = (params: {
  keychainId: string;
  keychains: SshKeychainListItem[];
  authType: SshAuthType;
}): ServerEditorCredentialMode => {
  const credentialMode = deriveCredentialMode(params.authType);
  const selectedKeychain = params.keychainId
    ? (params.keychains.find((item) => item.id === params.keychainId) ?? null)
    : null;
  const sharedKeychains = params.keychains.filter((item) => item.visibility === 'shared');
  const isUsingHiddenKeychain = selectedKeychain?.visibility === 'hidden';
  const isUsingInlineCredentials = !params.keychainId || isUsingHiddenKeychain || !selectedKeychain;

  return {
    selectedKeychain,
    sharedKeychains,
    isUsingHiddenKeychain,
    isUsingInlineCredentials,
    requiresPassword: isUsingInlineCredentials && credentialMode.requiresPassword,
    requiresPrivateKey: isUsingInlineCredentials && credentialMode.requiresPrivateKey,
  };
};
