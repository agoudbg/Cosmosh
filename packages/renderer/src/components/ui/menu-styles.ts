export const menuStyles = {
  content:
    'z-50 min-w-[180px] overflow-hidden rounded-[14px] bg-bg-subtle p-[4px] text-sm text-header-text shadow-soft backdrop-blur-[4px] [-webkit-app-region:no-drag]',
  item: 'relative flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 outline-none hover:bg-menu-control-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-menu-control-hover [-webkit-app-region:no-drag]',
  inset: 'pl-8',
  subTrigger: 'hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover',
  label: 'px-2.5 py-1.5 text-xs text-header-text-muted',
  separator: 'bg-divider -mx-1 my-1 h-px',
  shortcut: 'ml-auto text-xs text-header-text-muted',
  iconSlot: 'flex h-4 w-4 items-center justify-center',
  leadingIconSlot: 'inline-flex h-4 w-4 shrink-0 items-center justify-center',
  itemIndicator: 'absolute left-2 inline-flex h-4 w-4 items-center justify-center',
  iconOnlyControl: 'w-[34px] justify-center px-0',
  control:
    'inline-flex h-[34px] items-center gap-2 rounded-[14px] bg-menu-control px-2.5 text-sm text-header-text outline-none shadow-soft backdrop-blur-[4px] hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover data-[state=on]:bg-menu-control-hover [-webkit-app-region:no-drag]',
  menubarRoot:
    'inline-flex h-[42px] items-center gap-1.5 rounded-[18px] bg-menu-control p-[4px] shadow-soft backdrop-blur-[4px] [-webkit-app-region:no-drag]',
  menubarTrigger:
    'inline-flex h-[34px] select-none items-center gap-2 rounded-[14px] bg-menu-control px-2.5 text-sm outline-none hover:bg-menu-control-hover data-[state=open]:bg-menu-control-hover data-[highlighted]:bg-menu-control-hover [-webkit-app-region:no-drag]',
};
