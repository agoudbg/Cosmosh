import type { SettingsValues } from '@cosmosh/api-contract';
import React from 'react';

type TerminalTextDropMode = SettingsValues['terminalTextDropMode'];

type UseTerminalTextDropZoneOptions = {
  mode: TerminalTextDropMode;
  isConnected: boolean;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  internalDragMimeType: string;
  onDropText: (text: string) => void;
};

type UseTerminalTextDropZoneResult = {
  isVisible: boolean;
  isActive: boolean;
  centerX: number | null;
  handleWrapperDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  handleWrapperDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  handleWrapperDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  handleWrapperDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  handleZoneDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  handleZoneDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  handleZoneDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  handleZoneDrop: (event: React.DragEvent<HTMLDivElement>) => void;
};

const hasTextPayload = (dragTypes: string[]): boolean => {
  return dragTypes.some((type) => {
    return type === 'text/plain' || type === 'text' || type === 'Text';
  });
};

const useTerminalTextDropZone = ({
  mode,
  isConnected,
  wrapperRef,
  terminalContainerRef,
  internalDragMimeType,
  onDropText,
}: UseTerminalTextDropZoneOptions): UseTerminalTextDropZoneResult => {
  const dragOverlayDepthRef = React.useRef<number>(0);
  const lastDragOverAtRef = React.useRef<number>(0);
  const [isVisible, setIsVisible] = React.useState<boolean>(false);
  const [isActive, setIsActive] = React.useState<boolean>(false);
  const [centerX, setCenterX] = React.useState<number | null>(null);

  const hideDropZone = React.useCallback(() => {
    dragOverlayDepthRef.current = 0;
    lastDragOverAtRef.current = 0;
    setIsVisible(false);
    setIsActive(false);
  }, []);

  const supportsTextDrag = React.useCallback(
    (event: React.DragEvent<HTMLElement>): boolean => {
      if (!isConnected || mode === 'off') {
        return false;
      }

      const dragTypes = Array.from(event.dataTransfer.types);
      if (!hasTextPayload(dragTypes)) {
        return false;
      }

      if (mode === 'external' && dragTypes.includes(internalDragMimeType)) {
        return false;
      }

      return true;
    },
    [internalDragMimeType, isConnected, mode],
  );

  React.useEffect(() => {
    if (!isConnected || mode === 'off') {
      hideDropZone();
    }
  }, [hideDropZone, isConnected, mode]);

  React.useLayoutEffect(() => {
    if (!isVisible) {
      setCenterX(null);
      return;
    }

    const wrapperElement = wrapperRef.current;
    const terminalElement = terminalContainerRef.current;
    if (!wrapperElement) {
      return;
    }

    const syncDropZoneCenter = (): void => {
      const wrapperRect = wrapperElement.getBoundingClientRect();
      const terminalRect = terminalElement?.getBoundingClientRect();
      if (!terminalRect) {
        setCenterX(wrapperRect.width / 2);
        return;
      }

      setCenterX(terminalRect.left - wrapperRect.left + terminalRect.width / 2);
    };

    syncDropZoneCenter();

    const resizeObserver = new ResizeObserver(() => {
      syncDropZoneCenter();
    });

    resizeObserver.observe(wrapperElement);
    if (terminalElement) {
      resizeObserver.observe(terminalElement);
    }

    window.addEventListener('resize', syncDropZoneCenter);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncDropZoneCenter);
    };
  }, [isVisible, terminalContainerRef, wrapperRef]);

  React.useEffect(() => {
    if (!isVisible) {
      return;
    }

    const handleWindowDragEnd = (): void => {
      hideDropZone();
    };

    const handleWindowDrop = (): void => {
      hideDropZone();
    };

    const handleWindowBlur = (): void => {
      hideDropZone();
    };

    window.addEventListener('dragend', handleWindowDragEnd);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('blur', handleWindowBlur);

    const heartbeatTimerId = window.setInterval(() => {
      const lastDragOverAt = lastDragOverAtRef.current;
      if (lastDragOverAt === 0) {
        return;
      }

      if (Date.now() - lastDragOverAt > 320) {
        hideDropZone();
      }
    }, 140);

    return () => {
      window.removeEventListener('dragend', handleWindowDragEnd);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('blur', handleWindowBlur);
      window.clearInterval(heartbeatTimerId);
    };
  }, [hideDropZone, isVisible]);

  const handleWrapperDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      lastDragOverAtRef.current = Date.now();
      dragOverlayDepthRef.current += 1;
      setIsVisible(true);
      setIsActive(false);
    },
    [supportsTextDrag],
  );

  const handleWrapperDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      lastDragOverAtRef.current = Date.now();
      setIsVisible(true);
    },
    [supportsTextDrag],
  );

  const handleWrapperDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      const nextTarget = event.relatedTarget;
      if (nextTarget === null) {
        event.preventDefault();
        hideDropZone();
        return;
      }

      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      event.preventDefault();
      dragOverlayDepthRef.current = Math.max(0, dragOverlayDepthRef.current - 1);
      if (dragOverlayDepthRef.current === 0) {
        hideDropZone();
      }
    },
    [hideDropZone, supportsTextDrag],
  );

  const handleWrapperDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      hideDropZone();
    },
    [hideDropZone, supportsTextDrag],
  );

  const handleZoneDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      lastDragOverAtRef.current = Date.now();
      setIsActive(true);
    },
    [supportsTextDrag],
  );

  const handleZoneDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      lastDragOverAtRef.current = Date.now();
      setIsActive(true);
    },
    [supportsTextDrag],
  );

  const handleZoneDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsActive(false);
    },
    [supportsTextDrag],
  );

  const handleZoneDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!supportsTextDrag(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      hideDropZone();

      const droppedText = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text');
      if (!droppedText) {
        return;
      }

      onDropText(droppedText);
    },
    [hideDropZone, onDropText, supportsTextDrag],
  );

  return {
    isVisible,
    isActive,
    centerX,
    handleWrapperDragEnter,
    handleWrapperDragOver,
    handleWrapperDragLeave,
    handleWrapperDrop,
    handleZoneDragEnter,
    handleZoneDragOver,
    handleZoneDragLeave,
    handleZoneDrop,
  };
};

export { useTerminalTextDropZone };
