import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts sensitive SSH credential text with AES-256-GCM and serializes iv/tag/ciphertext as hex tuple.
 */
export const encryptSensitiveValue = (input: string, key: Buffer): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
};

/**
 * Decrypts payload produced by encryptSensitiveValue and returns UTF-8 plaintext.
 */
export const decryptSensitiveValue = (input: string, key: Buffer): string => {
  const parts = input.split(':');
  if (parts.length !== 3) {
    throw new Error('Encrypted payload format is invalid.');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};
