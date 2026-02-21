export const toastStyles = {
  viewport:
    'pointer-events-none fixed bottom-6 left-1/2 z-[70] flex w-auto max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-col items-center gap-2 outline-none',
  root: 'menu-menubar-field pointer-events-auto relative inline-flex w-fit min-w-[260px] max-w-[calc(100vw-1rem)] items-start gap-2 rounded-[16px] border border-toast-border bg-toast-surface px-3 py-2.5 text-toast-text shadow-soft outline-none backdrop-blur-[6px] data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-toast-swipe-out',
  icon: 'inline-flex h-5 w-5 shrink-0 items-center justify-center self-center',
  title: 'text-[15px] font-semibold text-toast-text',
  description: 'text-[14px] text-toast-text-muted',
  closeButton:
    'inline-flex h-7 w-7 items-center justify-center rounded-[10px] text-toast-text-muted outline-none hover:bg-form-control hover:text-toast-text',
  variant: {
    info: 'text-toast-icon-info',
    success: 'text-toast-icon-success',
    warning: 'text-toast-icon-warning',
    error: 'text-toast-icon-error',
  },
} as const;
