import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiSftpEntry } from '@cosmosh/api-contract';

import { isSftpTextPreviewEntry, resolveSftpPreviewLanguage } from './sftp-utils';

/**
 * Creates a regular SFTP file entry for preview-classification tests.
 *
 * @param name Remote file name.
 * @param extension Optional API-provided extension override.
 * @returns Complete SFTP entry fixture.
 */
const createFileEntry = (name: string, extension = ''): ApiSftpEntry => ({
  name,
  path: `/srv/${name}`,
  parentPath: '/srv',
  type: 'file',
  size: 128,
  mode: 0o100644,
  permissions: '-rw-r--r--',
  permissionOctal: '0644',
  uid: 1000,
  gid: 1000,
  modifiedAt: '2026-07-27T00:00:00.000Z',
  accessedAt: '2026-07-27T00:00:00.000Z',
  extension,
  shellEscapedPath: `'/srv/${name}'`,
  isHidden: name.startsWith('.'),
});

test('SFTP text preview recognizes expanded source, config, data, and documentation extensions', () => {
  const supportedNames = [
    'workflow.ahk',
    'template.j2',
    'request.http',
    'map.geojson',
    'scene.wgsl',
    'project.storyboard',
    'main.rs',
    'app.svelte',
    'schema.graphql',
    'deployment.tf',
    'service.timer',
    'settings.jsonc',
    'events.ndjson',
    'notes.rst',
    'style.less',
    'public.pem',
  ];

  supportedNames.forEach((name) => {
    assert.equal(isSftpTextPreviewEntry(createFileEntry(name)), true, name);
  });
});

test('SFTP text preview recognizes conventional extensionless names and variants', () => {
  const supportedNames = [
    '.bash_history',
    '.env.production',
    '.mysql_history',
    '.node_repl_history',
    '.psql_history',
    '.python_history',
    '.tool-versions',
    '.zshrc',
    '.zsh_history',
    'CODEOWNERS',
    'CONTRIBUTING',
    'CMakeLists.txt',
    'Containerfile.dev',
    'Dockerfile.production',
    'Earthfile',
    'Fastfile',
    'Jenkinsfile',
    'Jenkinsfile.dev',
    'LICENSE',
    'LICENSE-APACHE',
    'Podfile',
    'SECURITY',
  ];

  supportedNames.forEach((name) => {
    assert.equal(isSftpTextPreviewEntry(createFileEntry(name)), true, name);
  });
});

test('SFTP text preview keeps known binary formats and non-file entries unsupported', () => {
  const unsupportedNames = ['archive.zip', 'certificate.der', 'database.sqlite', 'document.pdf', 'image.png'];

  unsupportedNames.forEach((name) => {
    assert.equal(isSftpTextPreviewEntry(createFileEntry(name)), false, name);
  });

  assert.equal(
    isSftpTextPreviewEntry({
      ...createFileEntry('README.md'),
      type: 'directory',
    }),
    false,
  );
});

test('SFTP preview language mapping covers newly supported web, data, and shell variants', () => {
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('index.cjs')), 'javascript');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('worker.mts')), 'typescript');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('settings.jsonc')), 'json');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('map.geojson')), 'json');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('guide.mdx')), 'markdown');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('guide.qmd')), 'markdown');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('style.less')), 'css');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('app.svelte')), 'html');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('template.j2')), 'html');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('project.storyboard')), 'html');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.env.local')), 'shell');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.bashrc')), 'shell');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.bash_history')), 'shell');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.psql_history')), 'sql');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.python_history')), 'python');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('.node_repl_history')), 'javascript');
  assert.equal(resolveSftpPreviewLanguage(createFileEntry('main.rs')), 'plaintext');
});
