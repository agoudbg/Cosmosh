import type { components } from '@cosmosh/api-contract';
import classNames from 'classnames';
import { Check } from 'lucide-react';
import React from 'react';

import { formStyles } from './form-styles';
import { menuStyles } from './menu-styles';

type SshTag = components['schemas']['SshTag'];

const RESERVED_TAG_NAME = 'favorite';

const isReservedTagName = (name: string): boolean => {
  return name.trim().toLowerCase() === RESERVED_TAG_NAME;
};

/**
 * Props for the tag input component used to select and create SSH tags.
 */
export type TagInputProps = {
  tags: SshTag[];
  selectedTagIds: string[];
  menuTitle: string;
  inputPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  onSelectedTagIdsChange: (nextTagIds: string[]) => void;
  onCreateTag: (name: string) => Promise<SshTag | null>;
};

/**
 * Renders a compact tag selector with checkbox list and inline tag creation input.
 */
export const TagInput: React.FC<TagInputProps> = ({
  tags,
  selectedTagIds,
  menuTitle,
  inputPlaceholder,
  emptyText,
  disabled = false,
  onSelectedTagIdsChange,
  onCreateTag,
}) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [draftName, setDraftName] = React.useState<string>('');
  const [isCommitting, setIsCommitting] = React.useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = React.useState<boolean>(false);
  const [activeMenuIndex, setActiveMenuIndex] = React.useState<number>(0);

  const normalizedDraftName = draftName.trim();
  const availableTags = React.useMemo(() => {
    return tags.filter((tag) => !isReservedTagName(tag.name));
  }, [tags]);
  const selectedTagIdSet = React.useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const selectedTags = React.useMemo(() => {
    return availableTags.filter((tag) => selectedTagIdSet.has(tag.id));
  }, [availableTags, selectedTagIdSet]);

  const filteredTags = React.useMemo(() => {
    if (!normalizedDraftName) {
      return availableTags;
    }

    const keyword = normalizedDraftName.toLowerCase();
    return availableTags.filter((tag) => tag.name.toLowerCase().includes(keyword));
  }, [availableTags, normalizedDraftName]);

  const toggleTag = React.useCallback(
    (tagId: string, checked: boolean) => {
      if (checked) {
        if (selectedTagIds.includes(tagId)) {
          return;
        }

        onSelectedTagIdsChange([...selectedTagIds, tagId]);
        return;
      }

      onSelectedTagIdsChange(selectedTagIds.filter((id) => id !== tagId));
    },
    [onSelectedTagIdsChange, selectedTagIds],
  );

  const addOrCreateByName = React.useCallback(
    async (name: string): Promise<string | null> => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return null;
      }

      if (isReservedTagName(normalizedName)) {
        return null;
      }

      const existingTag = availableTags.find((tag) => tag.name.toLowerCase() === normalizedName.toLowerCase());
      if (existingTag) {
        return existingTag.id;
      }

      const createdTag = await onCreateTag(normalizedName);
      return createdTag?.id ?? null;
    },
    [availableTags, onCreateTag],
  );

  const commitDraftAsTags = React.useCallback(async () => {
    if (disabled || isCommitting || normalizedDraftName.length === 0) {
      return;
    }

    const names = normalizedDraftName
      .split(/[\n,，;；]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (names.length === 0) {
      return;
    }

    setIsCommitting(true);
    try {
      const nextTagIds = [...selectedTagIds];
      for (const name of names) {
        const tagId = await addOrCreateByName(name);
        if (!tagId || nextTagIds.includes(tagId)) {
          continue;
        }

        nextTagIds.push(tagId);
      }

      onSelectedTagIdsChange(nextTagIds);
      setDraftName('');
    } finally {
      setIsCommitting(false);
    }
  }, [addOrCreateByName, disabled, isCommitting, normalizedDraftName, onSelectedTagIdsChange, selectedTagIds]);

  const removeLastSelectedTag = React.useCallback(() => {
    if (selectedTags.length === 0) {
      return;
    }

    const lastTag = selectedTags[selectedTags.length - 1];
    onSelectedTagIdsChange(selectedTagIds.filter((id) => id !== lastTag.id));
  }, [onSelectedTagIdsChange, selectedTagIds, selectedTags]);

  React.useEffect(() => {
    if (filteredTags.length === 0) {
      setActiveMenuIndex(0);
      return;
    }

    if (activeMenuIndex >= filteredTags.length) {
      setActiveMenuIndex(filteredTags.length - 1);
    }
  }, [activeMenuIndex, filteredTags.length]);

  React.useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const closeMenuOnOutsideClick = (event: MouseEvent) => {
      const rootElement = rootRef.current;
      if (!rootElement || !(event.target instanceof Node)) {
        return;
      }

      if (!rootElement.contains(event.target)) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeMenuOnOutsideClick);
    return () => {
      document.removeEventListener('mousedown', closeMenuOnOutsideClick);
    };
  }, [isMenuOpen]);

  return (
    <div
      ref={rootRef}
      className="relative grid gap-2"
      onBlurCapture={(event) => {
        const nextFocusTarget = event.relatedTarget;
        if (nextFocusTarget instanceof Node && event.currentTarget.contains(nextFocusTarget)) {
          return;
        }

        setIsMenuOpen(false);
      }}
    >
      <div
        className={classNames(
          formStyles.input,
          'h-auto min-h-[34px] flex-wrap items-center gap-1.5 py-1.5',
          'outline outline-1 outline-transparent focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-outline',
        )}
      >
        {selectedTags.map((tag) => (
          <span
            key={tag.id}
            className="-ms-1 me-1 inline-flex items-center gap-1 rounded-[10px] border border-home-divider bg-form-control-hover px-2 py-0.5 text-xs text-form-text"
          >
            <span>{tag.name}</span>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex h-4 w-4 items-center justify-center rounded-[6px] outline-none hover:bg-form-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-outline disabled:opacity-50"
              aria-label={`Remove ${tag.name}`}
              onClick={() => toggleTag(tag.id, false)}
            >
              ×
            </button>
          </span>
        ))}

        <input
          value={draftName}
          placeholder={inputPlaceholder}
          disabled={disabled || isCommitting}
          className="placeholder:text-form-text-muted/80 -ms-1 min-w-[120px] flex-1 bg-transparent text-sm text-form-text outline-none focus:outline-none focus:ring-0"
          onFocus={() => setIsMenuOpen(true)}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!isMenuOpen) {
                setIsMenuOpen(true);
                setActiveMenuIndex(0);
                return;
              }

              setActiveMenuIndex((previous) => {
                if (filteredTags.length === 0) {
                  return 0;
                }

                return Math.min(previous + 1, filteredTags.length - 1);
              });
              return;
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (!isMenuOpen) {
                setIsMenuOpen(true);
                setActiveMenuIndex(0);
                return;
              }

              setActiveMenuIndex((previous) => {
                if (filteredTags.length === 0) {
                  return 0;
                }

                return Math.max(previous - 1, 0);
              });
              return;
            }

            if (event.key === 'Escape') {
              setIsMenuOpen(false);
              return;
            }

            if (event.key === 'Backspace' && normalizedDraftName.length === 0) {
              removeLastSelectedTag();
              return;
            }

            if (event.key === 'Tab') {
              setIsMenuOpen(false);
              return;
            }

            if (event.key !== 'Enter') {
              return;
            }

            event.preventDefault();

            if (isMenuOpen && filteredTags[activeMenuIndex]) {
              const activeTag = filteredTags[activeMenuIndex];
              toggleTag(activeTag.id, !selectedTagIds.includes(activeTag.id));
              setDraftName('');
              return;
            }

            void commitDraftAsTags();
          }}
        />
      </div>

      {isMenuOpen ? (
        <div className={classNames('absolute left-0 right-0 top-[calc(100%+6px)] z-20', menuStyles.content)}>
          <div className={menuStyles.label}>{menuTitle}</div>
          <div className="max-h-40 space-y-0.5 overflow-auto">
            {filteredTags.length > 0 ? (
              filteredTags.map((tag) => {
                const checked = selectedTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    tabIndex={-1}
                    className={classNames(
                      menuStyles.item,
                      'w-full',
                      filteredTags[activeMenuIndex]?.id === tag.id && 'bg-menu-control-hover',
                      disabled && 'pointer-events-none opacity-50',
                    )}
                    onClick={() => toggleTag(tag.id, !checked)}
                    onMouseEnter={() => setActiveMenuIndex(filteredTags.findIndex((item) => item.id === tag.id))}
                  >
                    <span className={menuStyles.itemIndicator}>{checked ? <Check className="h-4 w-4" /> : null}</span>
                    <span className={menuStyles.leadingIconSlot} />
                    <span>{tag.name}</span>
                  </button>
                );
              })
            ) : (
              <div className="text-menu-text-muted px-2.5 py-1.5 text-sm">{emptyText}</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
