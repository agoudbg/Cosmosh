import { CheckCircle2, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import React from 'react';

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  type ToastVariant,
  ToastViewport,
} from '../components/ui/toast';
import { toastStyles } from '../components/ui/toast-styles';
import { ToastContext, type ToastContextValue, type ToastPayload } from './toast-context';

type ToastItem = ToastPayload & {
  id: string;
  open: boolean;
  variant: ToastVariant;
  duration: number;
};

const DEFAULT_DURATION = 3200;
const EXIT_ANIMATION_MS = 190;
const iconMap: Record<ToastVariant, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: CircleAlert,
};

const createToastId = (): string => {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const AppToastProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const setOpenState = React.useCallback((id: string, open: boolean) => {
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, open } : item)));
  }, []);

  const push = React.useCallback((payload: ToastPayload) => {
    setItems((previous) => [
      ...previous,
      {
        id: createToastId(),
        open: true,
        variant: payload.variant ?? 'info',
        duration: payload.duration ?? DEFAULT_DURATION,
        title: payload.title,
        description: payload.description,
      },
    ]);
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      push,
      info: (description, title) => {
        push({ variant: 'info', title, description });
      },
      success: (description, title) => {
        push({ variant: 'success', title, description });
      },
      warning: (description, title) => {
        push({ variant: 'warning', title, description });
      },
      error: (description, title) => {
        push({ variant: 'error', title, description, duration: 4200 });
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      <ToastProvider swipeDirection="down">
        {children}
        {items.map((item) => {
          const Icon = iconMap[item.variant];
          return (
            <Toast
              key={item.id}
              open={item.open}
              variant={item.variant}
              className={item.title ? undefined : 'items-center'}
              duration={item.duration}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                  setOpenState(item.id, false);
                  window.setTimeout(() => {
                    dismiss(item.id);
                  }, EXIT_ANIMATION_MS);
                }
              }}
            >
              <span className={toastStyles.icon}>
                <Icon className={toastStyles.variant[item.variant]} />
              </span>
              <div className="min-w-0 flex-1">
                {item.title ? (
                  <>
                    <ToastTitle>{item.title}</ToastTitle>
                    <ToastDescription>{item.description}</ToastDescription>
                  </>
                ) : (
                  <ToastTitle>{item.description}</ToastTitle>
                )}
              </div>
              <ToastClose />
            </Toast>
          );
        })}
        <ToastViewport />
      </ToastProvider>
    </ToastContext.Provider>
  );
};

export { AppToastProvider };
