import { type Terminal } from '@xterm/xterm';
import React from 'react';

import type { TerminalSelectionAnchor, TerminalSelectionBarPosition, TerminalSelectionBounds } from './ssh-types';

type UseSshSelectionBarParams = {
  terminalRef: React.RefObject<Terminal | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  selectionBarRef: React.RefObject<HTMLDivElement | null>;
  selectionPointerClientXRef: React.RefObject<number | null>;
  enabled: boolean;
};

type UseSshSelectionBarResult = {
  selectionAnchor: TerminalSelectionAnchor | null;
  selectionBarPosition: TerminalSelectionBarPosition | null;
  dismissedSelectionText: string | null;
  refreshSelectionAnchor: () => void;
  dismissSelectionBar: () => void;
  clearSelectionOverlay: () => void;
};

/**
 * Computes terminal selection anchor and floating selection bar placement.
 *
 * @param params Hook inputs and ref handles used for geometry calculations.
 * @returns Selection state and interaction handlers for SSH selection toolbar.
 */
export const useSshSelectionBar = (params: UseSshSelectionBarParams): UseSshSelectionBarResult => {
  const { terminalRef, terminalContainerRef, wrapperRef, selectionBarRef, selectionPointerClientXRef, enabled } =
    params;

  const [selectionAnchor, setSelectionAnchor] = React.useState<TerminalSelectionAnchor | null>(null);
  const [selectionBarPosition, setSelectionBarPosition] = React.useState<TerminalSelectionBarPosition | null>(null);
  const [dismissedSelectionText, setDismissedSelectionText] = React.useState<string | null>(null);

  /**
   * Resolves aggregate bounds of current xterm selection blocks.
   *
   * @returns Unified selection bounds or `null` when selection is unavailable.
   */
  const resolveSelectionBounds = React.useCallback((): TerminalSelectionBounds | null => {
    const containerElement = terminalContainerRef.current;
    if (!containerElement) {
      return null;
    }

    const selectionLayer = containerElement.querySelector('.xterm-selection');
    if (!selectionLayer) {
      return null;
    }

    const selectionBlocks = selectionLayer.querySelectorAll('div');
    if (selectionBlocks.length === 0) {
      return null;
    }

    let top = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let anchorLeft = Number.POSITIVE_INFINITY;
    let anchorRight = Number.NEGATIVE_INFINITY;

    selectionBlocks.forEach((block) => {
      const rect = block.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      if (rect.top < top - 0.5) {
        top = rect.top;
        anchorLeft = rect.left;
      } else if (Math.abs(rect.top - top) <= 0.5) {
        anchorLeft = Math.min(anchorLeft, rect.left);
      }

      if (rect.bottom > bottom + 0.5) {
        bottom = rect.bottom;
        anchorRight = rect.right;
      } else if (Math.abs(rect.bottom - bottom) <= 0.5) {
        anchorRight = Math.max(anchorRight, rect.right);
      }

      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    });

    if (
      !Number.isFinite(top) ||
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(bottom) ||
      !Number.isFinite(anchorLeft) ||
      !Number.isFinite(anchorRight)
    ) {
      return null;
    }

    return {
      anchorLeft,
      anchorRight,
      top,
      left,
      right,
      bottom,
    };
  }, [terminalContainerRef]);

  /**
   * Refreshes terminal text selection anchor state.
   *
   * @returns Nothing.
   */
  const refreshSelectionAnchor = React.useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setSelectionAnchor(null);
      return;
    }

    const selectionText = terminal.getSelection();
    const normalizedText = selectionText.trim();
    if (normalizedText.length === 0) {
      setSelectionAnchor(null);
      return;
    }

    const bounds = resolveSelectionBounds();
    if (!bounds) {
      setSelectionAnchor(null);
      return;
    }

    setSelectionAnchor({
      selectionText,
      ...bounds,
      pointerClientX: selectionPointerClientXRef.current,
    });
  }, [resolveSelectionBounds, selectionPointerClientXRef, terminalRef]);

  React.useLayoutEffect(() => {
    if (!selectionAnchor || !enabled || dismissedSelectionText === selectionAnchor.selectionText) {
      setSelectionBarPosition(null);
      return;
    }

    const wrapperElement = wrapperRef.current;
    const selectionBarElement = selectionBarRef.current;
    if (!wrapperElement) {
      return;
    }

    const terminalBoundsElement = terminalContainerRef.current;

    const wrapperRect = wrapperElement.getBoundingClientRect();
    const placementBoundsRect = terminalBoundsElement?.getBoundingClientRect() ?? wrapperRect;
    const barWidth = selectionBarElement?.offsetWidth ?? 320;
    const barHeight = selectionBarElement?.offsetHeight ?? 42;
    const edgePadding = 8;
    const gap = 8;

    const selectionTop = selectionAnchor.top - wrapperRect.top;
    const selectionBottom = selectionAnchor.bottom - wrapperRect.top;
    const selectionLeft = selectionAnchor.anchorLeft - wrapperRect.left;
    const pointerBasedRight =
      selectionAnchor.pointerClientX !== null &&
      selectionAnchor.pointerClientX >= selectionAnchor.left &&
      selectionAnchor.pointerClientX <= selectionAnchor.right
        ? selectionAnchor.pointerClientX
        : null;
    const selectionRight = (pointerBasedRight ?? selectionAnchor.anchorRight) - wrapperRect.left;
    const boundsTop = placementBoundsRect.top - wrapperRect.top;
    const boundsBottom = placementBoundsRect.bottom - wrapperRect.top;

    const canPlaceAbove = selectionTop - gap - barHeight >= boundsTop + edgePadding;
    const canPlaceBelow = selectionBottom + gap + barHeight <= boundsBottom - edgePadding;
    const horizontalPadding = canPlaceAbove ? edgePadding : 0;
    const minLeftBound = placementBoundsRect.left - wrapperRect.left + horizontalPadding;
    const maxLeftBound = placementBoundsRect.right - wrapperRect.left - horizontalPadding - barWidth;

    if (!canPlaceAbove && !canPlaceBelow) {
      setSelectionBarPosition(null);
      return;
    }

    const unclampedLeft = canPlaceAbove ? selectionLeft : selectionRight - barWidth;
    const maxLeft = Math.max(minLeftBound, maxLeftBound);
    const left = Math.max(minLeftBound, Math.min(unclampedLeft, maxLeft));
    const top = canPlaceAbove ? selectionTop - gap - barHeight : selectionBottom + gap;

    setSelectionBarPosition({
      left,
      top,
    });
  }, [dismissedSelectionText, enabled, selectionAnchor, selectionBarRef, terminalContainerRef, wrapperRef]);

  React.useEffect(() => {
    if (!selectionAnchor) {
      setDismissedSelectionText(null);
      return;
    }

    if (dismissedSelectionText && dismissedSelectionText !== selectionAnchor.selectionText) {
      setDismissedSelectionText(null);
    }
  }, [dismissedSelectionText, selectionAnchor]);

  /**
   * Hides current selection bar until selection text changes.
   *
   * @returns Nothing.
   */
  const dismissSelectionBar = React.useCallback(() => {
    if (!selectionAnchor?.selectionText) {
      return;
    }

    setDismissedSelectionText(selectionAnchor.selectionText);
    setSelectionBarPosition(null);
  }, [selectionAnchor]);

  /**
   * Clears any rendered selection overlay state.
   *
   * @returns Nothing.
   */
  const clearSelectionOverlay = React.useCallback(() => {
    setSelectionAnchor(null);
    setSelectionBarPosition(null);
    setDismissedSelectionText(null);
  }, []);

  return {
    selectionAnchor,
    selectionBarPosition,
    dismissedSelectionText,
    refreshSelectionAnchor,
    dismissSelectionBar,
    clearSelectionOverlay,
  };
};
