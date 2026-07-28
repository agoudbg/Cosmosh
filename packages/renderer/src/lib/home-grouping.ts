/**
 * Minimal folder metadata required by Home grouping.
 */
export type HomeFolderReference = {
  id: string;
  name: string;
};

/**
 * Home entity shape accepted by folder grouping.
 */
export type HomeFolderGroupableItem = {
  folder?: HomeFolderReference | null;
};

/**
 * A rendered Home group containing entities from one folder.
 */
export type HomeFolderGroup<T> = {
  key: string;
  title: string;
  items: T[];
};

type GroupHomeItemsByFolderOptions<T> = {
  keyPrefix: string;
  noFolderTitle: string;
  sortItems: (items: T[]) => T[];
};

/**
 * Groups Home entities by their single folder assignment and appends unassigned
 * entities as the final group.
 *
 * @param items Entities visible in the current Home scope.
 * @param options Group key, fallback title, and within-group sorting behavior.
 * @returns Non-empty folder groups ordered by folder name, with the unassigned group last.
 */
export const groupHomeItemsByFolder = <T extends HomeFolderGroupableItem>(
  items: readonly T[],
  options: GroupHomeItemsByFolderOptions<T>,
): HomeFolderGroup<T>[] => {
  const folderGroups = new Map<string, { title: string; items: T[] }>();
  const unassignedItems: T[] = [];

  items.forEach((item) => {
    if (!item.folder) {
      unassignedItems.push(item);
      return;
    }

    const existingGroup = folderGroups.get(item.folder.id);
    if (existingGroup) {
      existingGroup.items.push(item);
      return;
    }

    folderGroups.set(item.folder.id, {
      title: item.folder.name,
      items: [item],
    });
  });

  const groups = Array.from(folderGroups.entries())
    .sort((left, right) => {
      const titleOrder = left[1].title.localeCompare(right[1].title);
      return titleOrder !== 0 ? titleOrder : left[0].localeCompare(right[0]);
    })
    .map(([folderId, group]) => ({
      key: `${options.keyPrefix}:folder:${folderId}`,
      title: group.title,
      items: options.sortItems(group.items),
    }));

  if (unassignedItems.length > 0) {
    groups.push({
      key: `${options.keyPrefix}:folder:none`,
      title: options.noFolderTitle,
      items: options.sortItems(unassignedItems),
    });
  }

  return groups;
};
