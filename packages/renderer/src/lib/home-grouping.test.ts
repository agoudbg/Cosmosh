import assert from 'node:assert/strict';
import test from 'node:test';

import { groupHomeItemsByFolder, type HomeFolderGroupableItem } from './home-grouping.ts';

type TestItem = HomeFolderGroupableItem & {
  id: string;
  name: string;
};

/**
 * Sorts fixture items by name to verify that caller-owned sorting is preserved.
 *
 * @param items Folder-group fixtures.
 * @returns A name-sorted copy of the fixtures.
 */
const sortItemsByName = (items: TestItem[]): TestItem[] => {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
};

test('Home folder grouping orders named folders and keeps unassigned items last', () => {
  const groups = groupHomeItemsByFolder<TestItem>(
    [
      { id: 'unassigned', name: 'Unassigned' },
      { id: 'beta-2', name: 'Beta Two', folder: { id: 'folder-b', name: 'Beta' } },
      { id: 'alpha-2', name: 'Alpha Two', folder: { id: 'folder-a', name: 'Alpha' } },
      { id: 'alpha-1', name: 'Alpha One', folder: { id: 'folder-a', name: 'Alpha' } },
    ],
    {
      keyPrefix: 'server',
      noFolderTitle: 'No folder',
      sortItems: sortItemsByName,
    },
  );

  assert.deepEqual(
    groups.map((group) => ({
      key: group.key,
      title: group.title,
      itemIds: group.items.map((item) => item.id),
    })),
    [
      {
        key: 'server:folder:folder-a',
        title: 'Alpha',
        itemIds: ['alpha-1', 'alpha-2'],
      },
      {
        key: 'server:folder:folder-b',
        title: 'Beta',
        itemIds: ['beta-2'],
      },
      {
        key: 'server:folder:none',
        title: 'No folder',
        itemIds: ['unassigned'],
      },
    ],
  );
});

test('Home folder grouping omits groups that have no visible items', () => {
  const groups = groupHomeItemsByFolder<TestItem>([], {
    keyPrefix: 'keychain',
    noFolderTitle: 'No folder',
    sortItems: sortItemsByName,
  });

  assert.deepEqual(groups, []);
});
