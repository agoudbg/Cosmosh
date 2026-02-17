export type HomeIconKey = 'Folder' | 'Folders' | 'Package2' | 'Network' | 'Cloud' | 'Database' | 'Server' | 'HardDrive';

export type HomeColorKey = 'slate' | 'blue' | 'emerald' | 'violet' | 'amber' | 'rose' | 'cyan';

export type HomeVisual = {
  iconKey: HomeIconKey;
  colorKey: HomeColorKey;
};

export type HomeVisualOverride = {
  iconKey?: HomeIconKey;
  colorKey?: HomeColorKey;
  imageUrl?: string;
};

type VisualTarget = 'folder' | 'server';

type HomeVisualStore = {
  folder: Record<string, HomeVisualOverride>;
  server: Record<string, HomeVisualOverride>;
};

const folderIconPool: HomeIconKey[] = ['Folder', 'Folders', 'Package2', 'Network', 'Cloud', 'Database'];
const colorPool: HomeColorKey[] = ['slate', 'blue', 'emerald', 'violet', 'amber', 'rose', 'cyan'];
const HOME_VISUALS_STORAGE_KEY = 'cosmosh.home.visual-overrides.v1';

const hashString = (value: string): number => {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  return hash >>> 0;
};

const pickBySeed = <T>(seed: string, pool: T[]): T => {
  const value = hashString(seed);
  return pool[value % pool.length];
};

const emptyStore = (): HomeVisualStore => {
  return {
    folder: {},
    server: {},
  };
};

const readVisualStore = (): HomeVisualStore => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyStore();
  }

  try {
    const rawValue = window.localStorage.getItem(HOME_VISUALS_STORAGE_KEY);
    if (!rawValue) {
      return emptyStore();
    }

    const parsed = JSON.parse(rawValue) as Partial<HomeVisualStore>;
    return {
      folder: parsed.folder ?? {},
      server: parsed.server ?? {},
    };
  } catch {
    return emptyStore();
  }
};

const writeVisualStore = (store: HomeVisualStore): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(HOME_VISUALS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore persistence errors in non-persistent runtime.
  }
};

const sanitizeVisualOverride = (input: HomeVisualOverride): HomeVisualOverride => {
  const iconKey = input.iconKey && folderIconPool.includes(input.iconKey) ? input.iconKey : undefined;
  const colorKey = input.colorKey && colorPool.includes(input.colorKey) ? input.colorKey : undefined;
  const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';

  return {
    iconKey,
    colorKey,
    imageUrl: imageUrl || undefined,
  };
};

const pickDefaultVisual = (seed: string): HomeVisual => {
  return {
    iconKey: pickBySeed(seed, folderIconPool),
    colorKey: pickBySeed(`${seed}:folder-color`, colorPool),
  };
};

export const pickFolderVisual = (seed: string): HomeVisual => {
  return pickDefaultVisual(seed);
};

export const pickServerVisual = (seed: string): HomeVisual => {
  // Server visuals are temporarily aligned with folder random logic.
  return pickDefaultVisual(seed);
};

export const resolveHomeVisual = (
  target: VisualTarget,
  id: string,
  seed: string,
): HomeVisual & { imageUrl?: string } => {
  const overrides = readVisualStore();
  const override = sanitizeVisualOverride(overrides[target][id] ?? {});
  const fallback = target === 'folder' ? pickFolderVisual(seed) : pickServerVisual(seed);

  return {
    iconKey: override.iconKey ?? fallback.iconKey,
    colorKey: override.colorKey ?? fallback.colorKey,
    imageUrl: override.imageUrl,
  };
};

export const setHomeVisualOverride = (target: VisualTarget, id: string, override: HomeVisualOverride): void => {
  const store = readVisualStore();
  const sanitized = sanitizeVisualOverride(override);

  store[target][id] = sanitized;
  writeVisualStore(store);
};

export const clearHomeVisualOverride = (target: VisualTarget, id: string): void => {
  const store = readVisualStore();

  delete store[target][id];
  writeVisualStore(store);
};

export const getHomeVisualCustomizationOptions = () => {
  return {
    iconPool: folderIconPool,
    colorPool,
    supportsImageUpload: true,
  };
};

export const colorKeyToClassName = (colorKey: HomeColorKey): string => {
  return {
    slate: 'bg-home-icon-slate text-home-icon-slate-ink',
    blue: 'bg-home-icon-blue text-home-icon-blue-ink',
    emerald: 'bg-home-icon-emerald text-home-icon-emerald-ink',
    violet: 'bg-home-icon-violet text-home-icon-violet-ink',
    amber: 'bg-home-icon-amber text-home-icon-amber-ink',
    rose: 'bg-home-icon-rose text-home-icon-rose-ink',
    cyan: 'bg-home-icon-cyan text-home-icon-cyan-ink',
  }[colorKey];
};
