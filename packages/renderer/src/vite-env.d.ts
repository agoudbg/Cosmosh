// / <reference types="vite/client" />

interface Window {
  electron?: {
    send: (channel: string, data: unknown) => void;
    on: (channel: string, func: (...args: unknown[]) => void) => void;
    once: (channel: string, func: (...args: unknown[]) => void) => void;
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    platform: NodeJS.Platform;
  };
}
