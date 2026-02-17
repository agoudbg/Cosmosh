import type React from 'react';

type CollisionPaddingObject = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type CollisionPaddingInput = number | Partial<CollisionPaddingObject> | undefined;

export const resolveViewportMenuBounds = (): React.CSSProperties => {
  if (typeof window === 'undefined') {
    return {
      maxWidth: 420,
      maxHeight: 560,
    };
  }

  return {
    maxWidth: Math.max(180, Math.min(420, window.innerWidth - 16)),
    maxHeight: Math.max(120, Math.min(560, window.innerHeight - 16)),
  };
};

export const normalizeCollisionPadding = (
  collisionPadding: CollisionPaddingInput,
  defaultPadding = 8,
): CollisionPaddingObject | Partial<CollisionPaddingObject> => {
  if (typeof collisionPadding === 'number') {
    return {
      top: collisionPadding,
      right: collisionPadding,
      bottom: collisionPadding,
      left: collisionPadding,
    };
  }

  if (collisionPadding && typeof collisionPadding === 'object') {
    return collisionPadding;
  }

  return {
    top: defaultPadding,
    right: defaultPadding,
    bottom: defaultPadding,
    left: defaultPadding,
  };
};
