import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isLegalDocumentId, type LegalDocumentId } from '@cosmosh/api-contract';
import { app, shell } from 'electron';
import JSZip from 'jszip';

const LEGAL_DOCUMENT_FILE_NAMES: Readonly<Record<LegalDocumentId, string>> = {
  project: 'LICENSE',
  chromium: 'LICENSES.chromium.html.zip',
  'third-party': 'THIRD-PARTY-NOTICES.html',
};

const CHROMIUM_LICENSE_ENTRY_NAME = 'LICENSES.chromium.html';
const LEGAL_DOCUMENT_TEMP_DIRECTORY_NAME = 'cosmosh-legal-documents';

/**
 * Ensures the temporary legal-document directory is a private real directory.
 *
 * @returns Absolute path to the private temporary directory.
 * @throws When an existing path is not a real directory.
 */
const ensureTemporaryLegalDirectory = async (): Promise<string> => {
  const directoryPath = path.join(app.getPath('temp'), LEGAL_DOCUMENT_TEMP_DIRECTORY_NAME);

  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Legal document temporary path is not a real directory.');
  }

  if (process.platform !== 'win32') {
    await fs.chmod(directoryPath, 0o700);
  }

  return directoryPath;
};

/**
 * Escapes text before placing it inside a generated HTML document.
 *
 * @param value Plain text to escape.
 * @returns HTML-safe text.
 */
const escapeHtml = (value: string): string => {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
};

/**
 * Wraps a plain-text license in a browser-readable document without changing its text.
 *
 * @param title Browser document title.
 * @param text License text.
 * @returns Complete HTML document.
 */
const createPlainTextBrowserDocument = (title: string, text: string): string => {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root { color-scheme: light dark; }',
    'body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }',
    'pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 14px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }',
    '</style>',
    '</head>',
    '<body>',
    `<pre>${escapeHtml(text)}</pre>`,
    '</body>',
    '</html>',
  ].join('\n');
};

/**
 * Returns trusted legal-document roots for the current packaged or development runtime.
 *
 * @returns Candidate directories that may contain packaged legal documents.
 */
const getLegalDocumentRoots = (): string[] => {
  const appPath = app.getAppPath();
  const workspaceRoot = path.resolve(__dirname, '../../..');
  const developmentReleaseRoot = path.join(workspaceRoot, 'packages', 'main', 'release', 'win-unpacked');
  const candidateRoots = app.isPackaged
    ? [path.dirname(process.resourcesPath), process.resourcesPath, appPath]
    : [developmentReleaseRoot, workspaceRoot, appPath, path.dirname(appPath)];

  return [...new Set(candidateRoots.map((candidate) => path.resolve(candidate)))];
};

/**
 * Resolves one allow-listed legal document from the application output.
 *
 * @param documentId Legal document identifier selected by the renderer.
 * @returns Existing absolute source path.
 * @throws When the packaged document is missing or is not a regular file.
 */
const resolveLegalDocumentPath = async (documentId: LegalDocumentId): Promise<string> => {
  const fileName = LEGAL_DOCUMENT_FILE_NAMES[documentId];

  for (const root of getLegalDocumentRoots()) {
    const candidatePath = path.join(root, fileName);

    try {
      const stats = await fs.stat(candidatePath);
      if (stats.isFile()) {
        return candidatePath;
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Legal document is missing: ${fileName}`);
};

/**
 * Writes a browser-ready legal document into the per-user temporary directory.
 *
 * @param fileName Fixed file name for the generated document.
 * @param contents Document contents.
 * @returns Absolute temporary file path.
 */
const writeTemporaryLegalDocument = async (fileName: string, contents: string | Uint8Array): Promise<string> => {
  const directoryPath = await ensureTemporaryLegalDirectory();
  const filePath = path.join(directoryPath, fileName);

  try {
    const existingFileStats = await fs.lstat(filePath);
    if (existingFileStats.isSymbolicLink()) {
      throw new Error('Legal document temporary file is a symbolic link.');
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }

  await fs.writeFile(filePath, contents, { mode: 0o600, flag: 'w' });
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
  }

  return filePath;
};

/**
 * Converts a packaged legal document into a browser-readable file.
 *
 * @param documentId Legal document identifier.
 * @param sourcePath Trusted packaged source path.
 * @returns Absolute path to the file that should be opened externally.
 */
const materializeBrowserDocument = async (documentId: LegalDocumentId, sourcePath: string): Promise<string> => {
  if (documentId === 'third-party') {
    return sourcePath;
  }

  if (documentId === 'project') {
    const licenseText = await fs.readFile(sourcePath, 'utf8');
    const browserDocument = createPlainTextBrowserDocument('Cosmosh Project License', licenseText);
    return writeTemporaryLegalDocument('project-license.html', browserDocument);
  }

  const archive = await JSZip.loadAsync(await fs.readFile(sourcePath));
  const licenseEntry = archive.file(CHROMIUM_LICENSE_ENTRY_NAME);
  if (!licenseEntry) {
    throw new Error(`Chromium license archive is missing ${CHROMIUM_LICENSE_ENTRY_NAME}`);
  }

  return writeTemporaryLegalDocument('LICENSES.chromium.html', await licenseEntry.async('nodebuffer'));
};

/**
 * Opens one packaged legal document in the operating system's default browser.
 *
 * Chromium's compressed license is extracted to a fixed temporary path first so users
 * can read the original HTML without adding the uncompressed document to the package.
 *
 * @param value Untrusted renderer payload.
 * @returns True when the document was handed to the system opener.
 */
export const openLegalDocument = async (value: unknown): Promise<boolean> => {
  if (!isLegalDocumentId(value)) {
    return false;
  }

  try {
    const sourcePath = await resolveLegalDocumentPath(value);
    const browserDocumentPath = await materializeBrowserDocument(value, sourcePath);
    await shell.openExternal(pathToFileURL(browserDocumentPath).toString());
    return true;
  } catch (error: unknown) {
    console.error(`[legal-documents] Failed to open ${value}.`, error);
    return false;
  }
};
