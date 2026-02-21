export const menuStyles = {
  content:
    'z-50 min-w-[180px] max-h-[min(560px,calc(100vh-16px))] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[14px] bg-bg-subtle p-[4px] text-sm text-header-text shadow-menu backdrop-blur-[4px] [-webkit-app-region:no-drag]',
  contentCloseMotion:
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-10 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-150 data-[state=closed]:ease-in',
  item: 'relative flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 outline-none hover:bg-menu-control-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-menu-control-hover [-webkit-app-region:no-drag]',
  inset: 'pl-8',
  subTrigger: 'hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover',
  label: 'px-2.5 py-1.5 text-xs text-header-text-muted',
  separator: 'bg-menu-divider my-1 mx-2.5 h-px',
  separatorInset: 'bg-menu-divider my-1 ml-9 mr-2.5 h-px',
  menubarSeparator: 'menu-menubar-separator bg-menu-divider mx-[6px] h-[18px] w-[2px] flex-shrink-0',
  shortcut: 'ml-auto text-xs text-header-text-muted',
  iconSlot: 'flex h-4 w-4 items-center justify-center',
  leadingIconSlot: 'inline-flex h-4 w-4 shrink-0 items-center justify-center',
  itemIndicator: 'absolute left-2 inline-flex h-4 w-4 items-center justify-center',
  iconOnlyControl: 'w-[34px] justify-center px-0',
  control:
    'menu-menubar-control inline-flex h-[34px] items-center gap-2 rounded-[14px] bg-menu-control px-2.5 text-sm text-header-text outline-none shadow-menu backdrop-blur-[4px] hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover data-[state=on]:bg-menu-control-hover [-webkit-app-region:no-drag]',
  menubarRoot:
    'menu-menubar-root inline-flex h-[42px] items-center rounded-[18px] bg-menu-control p-[4px] shadow-menu backdrop-blur-[4px] [&>.menu-menubar-separator]:bg-menu-divider [-webkit-app-region:no-drag]',
  menubarTrigger:
    'menu-menubar-trigger inline-flex h-[34px] select-none items-center gap-2 rounded-[14px] bg-menu-control px-2.5 text-sm outline-none hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover data-[highlighted]:bg-menu-control-hover [-webkit-app-region:no-drag]',
  toggleGroupRoot:
    'menu-toggle-group-root inline-flex h-[42px] items-center rounded-[18px] bg-menu-control p-[4px] shadow-menu backdrop-blur-[4px] [-webkit-app-region:no-drag]',
  toggleGroupItem:
    'menu-toggle-group-item inline-flex h-[34px] select-none items-center gap-2 rounded-[14px] bg-menu-control px-2.5 text-sm outline-none hover:bg-menu-control-hover data-[state=on]:bg-home-chip-active [-webkit-app-region:no-drag]',
};
