import React from 'react';

import type { ToastVariant } from '../components/ui/toast';

type ToastPayload = {
  title?: string;
  description: string;
  variant?: ToastVariant;
  duration?: number;
};

type ToastContextValue = {
  push: (payload: ToastPayload) => void;
  info: (description: string, title?: string) => void;
  success: (description: string, title?: string) => void;
  warning: (description: string, title?: string) => void;
  error: (description: string, title?: string) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

const useToast = (): ToastContextValue => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within AppToastProvider.');
  }

  return context;
};

export type { ToastPayload, ToastContextValue };

export { ToastContext, useToast };
