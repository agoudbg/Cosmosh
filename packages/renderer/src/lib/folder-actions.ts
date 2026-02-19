import { createSshFolder, deleteSshFolder, updateSshFolder } from './backend';

export const normalizeFolderName = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const createFolder = async (name: string): Promise<void> => {
  await createSshFolder({ name });
};

export const renameFolder = async (folderId: string, name: string): Promise<void> => {
  await updateSshFolder(folderId, { name });
};

export const removeFolder = async (folderId: string): Promise<void> => {
  const result = await deleteSshFolder(folderId);
  if (!result.success) {
    throw new Error('Failed to delete folder.');
  }
};
