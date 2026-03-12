export const formStyles = {
  root: 'grid gap-4',
  field: 'grid gap-2',
  label: 'px-2.5 text-sm text-form-text-muted',
  inlineLabel: 'px-0 !text-form-text',
  helperText: 'px-2.5 text-xs text-form-text-muted',
  message: 'text-xs text-form-message-error',
  input:
    'menu-menubar-field flex h-[34px] w-full rounded-lg bg-form-control px-2.5 text-sm text-form-text outline-none placeholder:text-form-text-muted/80 hover:bg-form-control-hover disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  textarea:
    'menu-menubar-field flex min-h-[92px] w-full resize-y rounded-lg bg-form-control px-2.5 py-2 text-sm text-form-text outline-none placeholder:text-form-text-muted/80 hover:bg-form-control-hover disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  button:
    'menu-menubar-field inline-flex h-[34px] items-center justify-center gap-2 rounded-lg bg-form-control px-3 text-sm text-form-text outline-none hover:bg-form-control-hover disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  buttonInverted:
    'menu-menubar-field inline-flex h-[34px] items-center justify-center gap-2 rounded-lg bg-form-text px-3 text-sm text-bg outline-none hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  buttonGhost:
    'menu-menubar-field inline-flex h-[34px] items-center justify-center gap-2 rounded-lg bg-transparent px-3 text-sm text-form-text outline-none hover:bg-form-control-hover disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  checkbox:
    'peer inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[8px] bg-form-control text-form-text outline-none hover:bg-form-control-hover data-[state=checked]:bg-form-active data-[state=unchecked]:text-form-text-muted disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  switchRoot:
    'inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-form-switch-track-off p-[2px] outline-none transition-colors hover:bg-form-switch-track-off data-[state=checked]:bg-form-switch-track-on disabled:cursor-not-allowed disabled:opacity-50 [-webkit-app-region:no-drag]',
  switchThumb:
    'block h-4 w-4 rounded-full bg-form-thumb-off transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-form-thumb-on data-[state=unchecked]:translate-x-0',
  sliderRoot: 'relative flex h-5 w-full touch-none select-none items-center [-webkit-app-region:no-drag]',
  sliderTrack: 'relative h-1.5 grow overflow-hidden rounded-full bg-form-control',
  sliderRange: 'absolute h-full bg-form-active',
  sliderThumb:
    'block h-4 w-4 rounded-full bg-form-active outline-none hover:opacity-90 disabled:pointer-events-none disabled:opacity-50',
  passwordToggle:
    'absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[8px] outline-none text-form-text-muted hover:bg-form-control-hover hover:text-form-text',
};
