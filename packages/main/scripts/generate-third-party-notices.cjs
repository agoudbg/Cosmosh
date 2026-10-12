'use strict';

const fs = require('node:fs/promises');
const { builtinModules } = require('node:module');
const path = require('node:path');

const NOTICE_FILE_NAME = 'THIRD-PARTY-NOTICES.html';
const PROJECT_LICENSE_FILE_NAME = 'LICENSE';
const WORKSPACE_PACKAGE_PREFIX = '@cosmosh/';
const WORKSPACE_MANIFESTS = [
  'packages/main/package.json',
  'packages/backend/package.json',
  'packages/renderer/package.json',
  'packages/i18n/package.json',
];
const GENERATED_DATA_DEPENDENCIES = [
  {
    name: '@withfig/autocomplete',
    packageRootRelativePath: 'packages/backend',
  },
];
const LEGAL_FILE_NAME_PATTERN = /^(?:licen[cs]e(?:s)?|notice(?:s)?|copying|patents)(?:[._-].*)?$/i;
const BUILTIN_MODULE_NAMES = new Set([...builtinModules, ...builtinModules.map((moduleName) => 'node:' + moduleName)]);
const LICENSE_OVERRIDE_DIRECTORY = path.join(__dirname, 'license-overrides');
const SUPPLEMENTAL_LICENSE_OVERRIDES = {
  '@xterm/addon-serialize': {
    fileName: 'xtermjs-license.txt',
    source: 'https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/LICENSE',
    note: 'Copied from the xterm.js monorepo license at the commit recorded by this package.',
  },
  'react-remove-scroll-bar': {
    fileName: 'react-remove-scroll-bar-license.txt',
    source: 'https://github.com/theKashey/react-remove-scroll-bar',
    note: 'Supplemental MIT text. The npm package declares MIT but does not include a root-level license file.',
  },
};

/**
 * Escapes dynamic text before it is inserted into generated HTML.
 *
 * @param {unknown} value Value to escape.
 * @returns {string} HTML-safe text.
 */
const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * Returns an HTTP(S) URL suitable for an external link.
 *
 * @param {unknown} value Candidate URL value.
 * @returns {string | null} Safe URL or null when the value is not an HTTP(S) URL.
 */
const toSafeHttpUrl = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Normalizes npm author metadata for display.
 *
 * @param {unknown} author Package author metadata.
 * @returns {string} Human-readable author value.
 */
const normalizeAuthor = (author) => {
  if (typeof author === 'string') {
    return author;
  }

  if (!author || typeof author !== 'object') {
    return '';
  }

  const authorRecord = /** @type {{ name?: unknown; email?: unknown; url?: unknown }} */ (author);
  const name = typeof authorRecord.name === 'string' ? authorRecord.name : '';
  const email = typeof authorRecord.email === 'string' ? authorRecord.email : '';
  const url = typeof authorRecord.url === 'string' ? authorRecord.url : '';

  return [name, email && '<' + email + '>', url].filter(Boolean).join(' ');
};

/**
 * Normalizes npm repository metadata for display.
 *
 * @param {unknown} repository Package repository metadata.
 * @returns {string} Repository value.
 */
const normalizeRepository = (repository) => {
  if (typeof repository === 'string') {
    return repository;
  }

  if (!repository || typeof repository !== 'object') {
    return '';
  }

  const repositoryRecord = /** @type {{ url?: unknown }} */ (repository);
  return typeof repositoryRecord.url === 'string' ? repositoryRecord.url : '';
};

/**
 * Normalizes npm license metadata for display.
 *
 * @param {Record<string, any>} packageJson Parsed package manifest.
 * @returns {string} License declaration.
 */
const normalizeLicense = (packageJson) => {
  const license = packageJson.license;
  if (typeof license === 'string') {
    return license;
  }

  if (license && typeof license === 'object') {
    const licenseRecord = /** @type {{ type?: unknown; url?: unknown }} */ (license);
    return [licenseRecord.type, licenseRecord.url].filter((value) => typeof value === 'string').join(' - ');
  }

  const licenses = packageJson.licenses;
  if (Array.isArray(licenses)) {
    return licenses
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        if (entry && typeof entry === 'object') {
          const entryRecord = /** @type {{ type?: unknown; url?: unknown }} */ (entry);
          return [entryRecord.type, entryRecord.url].filter((value) => typeof value === 'string').join(' - ');
        }

        return '';
      })
      .filter(Boolean)
      .join(', ');
  }

  return 'License not declared in package.json';
};

/**
 * Finds the package root containing an entry point.
 *
 * @param {string} entryPath Resolved package entry path.
 * @param {string} expectedPackageName Package name to match.
 * @returns {Promise<string>} Package root path.
 * @throws {Error} If the package root cannot be found.
 */
const findPackageRootFromEntry = async (entryPath, expectedPackageName) => {
  let cursor = path.dirname(entryPath);

  while (true) {
    const packageJsonPath = path.join(cursor, 'package.json');

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      if (packageJson && packageJson.name === expectedPackageName) {
        return cursor;
      }
    } catch {
      // Continue walking until the filesystem root.
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error('Unable to locate package root for ' + expectedPackageName + ' from ' + entryPath);
    }

    cursor = parent;
  }
};

/**
 * Resolves a package root using the same Node resolution rules as the app build.
 *
 * @param {string} packageName Package name to resolve.
 * @param {string[]} resolvePaths Resolution roots.
 * @returns {Promise<string>} Absolute package root path.
 */
const resolvePackageRoot = async (packageName, resolvePaths) => {
  try {
    const resolvedEntryPath = require.resolve(packageName, { paths: resolvePaths });
    return await findPackageRootFromEntry(resolvedEntryPath, packageName);
  } catch (resolutionError) {
    const packageSegments = packageName.split('/');
    const candidateRoots = resolvePaths.flatMap((resolvePath) => [
      path.join(resolvePath, 'node_modules', ...packageSegments),
      path.join(resolvePath, ...packageSegments),
    ]);

    for (const candidateRoot of candidateRoots) {
      try {
        const packageJson = JSON.parse(await fs.readFile(path.join(candidateRoot, 'package.json'), 'utf8'));
        if (packageJson && packageJson.name === packageName) {
          return candidateRoot;
        }
      } catch {
        // Keep trying the next Node-compatible package root.
      }
    }

    throw resolutionError;
  }
};

/**
 * Returns dependency names from a package manifest while excluding workspace packages and Node built-ins.
 *
 * @param {Record<string, any>} manifest Parsed package manifest.
 * @returns {Array<{ name: string; optional: boolean }>} Dependency names.
 */
const getDependencyNames = (manifest) => {
  const requiredNames = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false }));
  const optionalNames = Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true }));

  return [...requiredNames, ...optionalNames].filter(
    ({ name }) => !name.startsWith(WORKSPACE_PACKAGE_PREFIX) && !BUILTIN_MODULE_NAMES.has(name),
  );
};

/**
 * Collects one package and its production dependency closure.
 *
 * @param {string} packageName Package name to collect.
 * @param {string[]} resolvePaths Resolution roots for the package.
 * @param {Map<string, any>} collectedPackages Package-root keyed collection.
 * @param {Set<string>} resolvingPackages Packages currently being resolved.
 * @returns {Promise<void>} Resolves after the package closure is collected.
 */
const collectPackageRecursively = async (packageName, resolvePaths, collectedPackages, resolvingPackages) => {
  const packageRoot = await resolvePackageRoot(packageName, resolvePaths);
  const packageKey = path.resolve(packageRoot);

  if (collectedPackages.has(packageKey) || resolvingPackages.has(packageKey)) {
    return;
  }

  resolvingPackages.add(packageKey);

  try {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    if (!packageJson.name || packageJson.name.startsWith(WORKSPACE_PACKAGE_PREFIX)) {
      return;
    }

    collectedPackages.set(packageKey, {
      name: packageJson.name,
      root: packageRoot,
      manifest: packageJson,
      licenseFiles: [],
    });

    const childResolvePaths = [packageRoot, ...resolvePaths];
    for (const { name: dependencyName, optional } of getDependencyNames(packageJson)) {
      try {
        await collectPackageRecursively(dependencyName, childResolvePaths, collectedPackages, resolvingPackages);
      } catch (error) {
        if (optional && error && error.code === 'MODULE_NOT_FOUND') {
          continue;
        }

        throw new Error('Failed to resolve ' + dependencyName + ', required by ' + packageJson.name, { cause: error });
      }
    }
  } finally {
    resolvingPackages.delete(packageKey);
  }
};

/**
 * Reads a workspace package manifest.
 *
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} relativeManifestPath Workspace-relative manifest path.
 * @returns {Promise<{ root: string; manifest: Record<string, any> }>} Manifest details.
 */
const readWorkspaceManifest = async (workspaceRoot, relativeManifestPath) => {
  const manifestPath = path.join(workspaceRoot, relativeManifestPath);
  const rawManifest = await fs.readFile(manifestPath, 'utf8');

  return {
    root: path.dirname(manifestPath),
    manifest: JSON.parse(rawManifest),
  };
};

/**
 * Collects all non-workspace packages used by the shipped app and generated backend data.
 *
 * @param {string} workspaceRoot Absolute workspace root.
 * @returns {Promise<Array<{ name: string; root: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string }> }>>} Sorted package records.
 */
const collectThirdPartyPackages = async (workspaceRoot) => {
  const collectedPackages = new Map();
  const resolvingPackages = new Set();
  const manifests = await Promise.all(
    WORKSPACE_MANIFESTS.map((relativePath) => readWorkspaceManifest(workspaceRoot, relativePath)),
  );

  for (const { root, manifest } of manifests) {
    for (const { name: dependencyName } of getDependencyNames(manifest)) {
      await collectPackageRecursively(
        dependencyName,
        [root, path.join(workspaceRoot, 'node_modules')],
        collectedPackages,
        resolvingPackages,
      );
    }
  }

  for (const generatedDependency of GENERATED_DATA_DEPENDENCIES) {
    const packageRoot = path.join(workspaceRoot, generatedDependency.packageRootRelativePath);
    await collectPackageRecursively(
      generatedDependency.name,
      [packageRoot, path.join(workspaceRoot, 'node_modules')],
      collectedPackages,
      resolvingPackages,
    );
  }

  return [...collectedPackages.values()].sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Reads root-level legal notice files from a package.
 *
 * @param {string} packageRoot Absolute package root.
 * @returns {Promise<Array<{ name: string; text: string; supplemental: boolean }>>} Readable legal notice files.
 */
const readPackageLegalFiles = async (packageRoot) => {
  const entries = await fs.readdir(packageRoot, { withFileTypes: true });
  const legalFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !LEGAL_FILE_NAME_PATTERN.test(entry.name)) {
      continue;
    }

    const filePath = path.join(packageRoot, entry.name);
    const contents = await fs.readFile(filePath);
    legalFiles.push({
      name: entry.name,
      text: contents.includes(0) ? '[Binary legal notice omitted from the HTML export.]' : contents.toString('utf8'),
      supplemental: false,
    });
  }

  return legalFiles.sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Reads a repository-maintained license override for a package whose published artifact omits its legal file.
 *
 * @param {{ name: string }} packageRecord Package identity.
 * @returns {Promise<Array<{ name: string; text: string; supplemental: boolean; source: string; note: string }>>} Supplemental legal files.
 * @throws {Error} If a configured supplemental file cannot be read.
 */
const readSupplementalLegalFiles = async (packageRecord) => {
  const override = SUPPLEMENTAL_LICENSE_OVERRIDES[packageRecord.name];
  if (!override) {
    return [];
  }

  const filePath = path.join(LICENSE_OVERRIDE_DIRECTORY, override.fileName);

  try {
    return [
      {
        name: 'LICENSE',
        text: await fs.readFile(filePath, 'utf8'),
        supplemental: true,
        source: override.source,
        note: override.note,
      },
    ];
  } catch (error) {
    throw new Error('Failed to read supplemental license for ' + packageRecord.name, { cause: error });
  }
};

/**
 * Adds legal file contents to package records.
 *
 * @param {Array<{ name: string; root: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string; supplemental: boolean }> }>} packages Package records.
 * @returns {Promise<Array<{ name: string; root: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string; supplemental: boolean; source?: string; note?: string }> }>} Enriched package records.
 */
const enrichPackageLegalFiles = async (packages) => {
  for (const packageRecord of packages) {
    packageRecord.licenseFiles = await readPackageLegalFiles(packageRecord.root);

    if (packageRecord.licenseFiles.length === 0) {
      packageRecord.licenseFiles = await readSupplementalLegalFiles(packageRecord);
    }
  }

  return packages;
};

/**
 * Returns the directory where legal files belong for a packaged application.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @returns {string} Absolute legal-files directory.
 */
const getLegalFilesDirectory = (context) => {
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas';
  const productFilename = context.packager?.appInfo?.productFilename;

  if (isMac && productFilename) {
    return path.join(context.appOutDir, productFilename + '.app', 'Contents', 'Resources');
  }

  return context.appOutDir;
};

/**
 * Renders an external link when the package metadata provides a safe HTTP(S) URL.
 *
 * @param {unknown} value Candidate URL.
 * @param {string} fallback Fallback text.
 * @returns {string} Rendered HTML link or escaped fallback text.
 */
const renderExternalLink = (value, fallback) => {
  const safeUrl = toSafeHttpUrl(value);
  return safeUrl ? '<a href="' + escapeHtml(safeUrl) + '">' + escapeHtml(safeUrl) + '</a>' : escapeHtml(fallback);
};

/**
 * Renders one package metadata row.
 *
 * @param {{ name: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string; supplemental?: boolean }> }} packageRecord Package record.
 * @param {number} index Stable package index.
 * @returns {string} Rendered table row.
 */
const renderPackageRow = (packageRecord, index) => {
  const { manifest, name, licenseFiles } = packageRecord;
  const homepage = manifest.homepage || normalizeRepository(manifest.repository);
  const legalFileSummary =
    licenseFiles.length > 0
      ? licenseFiles.map((file) => file.name + (file.supplemental ? ' (supplemental)' : '')).join(', ')
      : 'None found';

  return [
    '<tr>',
    '<td><a href="#package-' + (index + 1) + '">' + escapeHtml(name) + '</a></td>',
    '<td>' + escapeHtml(manifest.version ?? 'Unknown') + '</td>',
    '<td>' + escapeHtml(normalizeLicense(manifest)) + '</td>',
    '<td>' + escapeHtml(normalizeAuthor(manifest.author) || 'Not declared') + '</td>',
    '<td>' + renderExternalLink(homepage, 'Not declared') + '</td>',
    '<td>' + escapeHtml(legalFileSummary) + '</td>',
    '</tr>',
  ].join('');
};

/**
 * Renders one package's full license section.
 *
 * @param {{ name: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string; supplemental?: boolean; source?: string; note?: string }> }} packageRecord Package record.
 * @param {number} index Stable package index.
 * @returns {string} Rendered package section.
 */
const renderPackageSection = (packageRecord, index) => {
  const { manifest, name, licenseFiles } = packageRecord;
  const legalText =
    licenseFiles.length > 0
      ? licenseFiles
          .map(
            (file) =>
              '<h4>' +
              escapeHtml(file.name + (file.supplemental ? ' (supplemental)' : '')) +
              '</h4><pre>' +
              escapeHtml(file.text) +
              '</pre>' +
              (file.supplemental
                ? '<p class="muted"><strong>Supplemental source:</strong> ' +
                  renderExternalLink(file.source, 'Not declared') +
                  '<br><span>' +
                  escapeHtml(file.note || '') +
                  '</span></p>'
                : ''),
          )
          .join('')
      : '<p class="missing">No root-level license or notice file was found. The package.json declaration is shown above.</p>';
  const homepage = manifest.homepage || normalizeRepository(manifest.repository);

  return [
    '<article id="package-' + (index + 1) + '">',
    '<h3>' + escapeHtml(name) + ' ' + escapeHtml(manifest.version ?? '') + '</h3>',
    '<p><strong>License:</strong> ' + escapeHtml(normalizeLicense(manifest)) + '</p>',
    '<p><strong>Author:</strong> ' + escapeHtml(normalizeAuthor(manifest.author) || 'Not declared') + '</p>',
    '<p><strong>Source:</strong> ' + renderExternalLink(homepage, 'Not declared') + '</p>',
    legalText,
    '</article>',
  ].join('');
};

/**
 * Renders the complete third-party notice document.
 *
 * @param {string} applicationVersion Application version displayed in the document.
 * @param {Array<{ name: string; root: string; manifest: Record<string, any>; licenseFiles: Array<{ name: string; text: string; supplemental?: boolean }> }>} packages Package records.
 * @returns {string} Complete HTML document.
 */
const renderNoticeDocument = (applicationVersion, packages) => {
  const packageRows = packages.map(renderPackageRow).join('');
  const packageSections = packages.map(renderPackageSection).join('');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Cosmosh Third-Party Open Source Notices</title>',
    '  <style>',
    '    :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
    '    body { margin: 0; background: Canvas; color: CanvasText; line-height: 1.5; }',
    '    main { max-width: 1180px; margin: 0 auto; padding: 32px; }',
    '    h1, h2, h3, h4 { line-height: 1.2; }',
    '    h1 { margin-top: 0; }',
    '    h2 { margin-top: 40px; border-bottom: 1px solid #999; padding-bottom: 8px; }',
    '    h3 { margin-bottom: 8px; }',
    '    h4 { margin-bottom: 4px; }',
    '    .table-wrap { overflow-x: auto; }',
    '    table { width: 100%; min-width: 900px; border-collapse: collapse; font-size: 14px; }',
    '    th, td { border: 1px solid #999; padding: 8px; text-align: left; vertical-align: top; }',
    '    th { background: #e8e8e8; }',
    '    pre { overflow: auto; white-space: pre-wrap; border: 1px solid #bbb; padding: 16px; background: #f5f5f5; }',
    '    article { scroll-margin-top: 16px; }',
    '    article + article { margin-top: 40px; }',
    '    .muted { opacity: 0.78; }',
    '    .missing { color: #a33; }',
    '    @media (prefers-color-scheme: dark) { th { background: #303030; } pre { background: #202020; } }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Cosmosh Third-Party Open Source Notices</h1>',
    '    <p class="muted">Generated for Cosmosh ' +
      escapeHtml(applicationVersion) +
      ' from the production dependency closures used by the main process, backend, renderer, and i18n packages.</p>',
    '    <p>The project license is provided separately as <a href="' +
      PROJECT_LICENSE_FILE_NAME +
      '">' +
      PROJECT_LICENSE_FILE_NAME +
      '</a>.</p>',
    '    <h2>Bundled runtime notices</h2>',
    '    <ul>',
    '      <li><a href="LICENSE.electron.txt">LICENSE.electron.txt</a> contains the Electron license notice.</li>',
    '      <li><a href="LICENSES.chromium.html.zip">LICENSES.chromium.html.zip</a> contains the complete Chromium license document.</li>',
    '    </ul>',
    '    <h2>Dependency index (' + packages.length + ' packages)</h2>',
    '    <div class="table-wrap">',
    '    <table>',
    '      <thead><tr><th>Package</th><th>Version</th><th>License</th><th>Author</th><th>Source</th><th>Legal files</th></tr></thead>',
    '      <tbody>' + packageRows + '</tbody>',
    '    </table>',
    '    </div>',
    '    <h2>Full license and notice texts</h2>',
    '    ' + packageSections,
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
};

/**
 * Generates an uncompressed third-party license document in the packaged application.
 *
 * @param {import('electron-builder').AfterPackContext} context electron-builder afterPack context.
 * @returns {Promise<string>} Absolute path to the generated HTML document.
 */
const generateThirdPartyNotices = async (context) => {
  const workspaceRoot = path.resolve(context.packager.projectDir, '../..');
  const packages = await enrichPackageLegalFiles(await collectThirdPartyPackages(workspaceRoot));
  const outputDirectory = getLegalFilesDirectory(context);
  const outputPath = path.join(outputDirectory, NOTICE_FILE_NAME);
  const applicationVersion = context.packager.appInfo.version;

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(outputPath, renderNoticeDocument(applicationVersion, packages), 'utf8');

  return outputPath;
};

module.exports = generateThirdPartyNotices;
module.exports.NOTICE_FILE_NAME = NOTICE_FILE_NAME;
module.exports.PROJECT_LICENSE_FILE_NAME = PROJECT_LICENSE_FILE_NAME;
module.exports.getLegalFilesDirectory = getLegalFilesDirectory;
module.exports.collectThirdPartyPackages = collectThirdPartyPackages;
