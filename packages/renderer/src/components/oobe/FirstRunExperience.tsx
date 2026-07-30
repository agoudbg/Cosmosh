import type { SettingsValues } from '@cosmosh/api-contract';
import classNames from 'classnames';
import {
  BookOpen,
  Check,
  CircleHelp,
  FolderSync,
  Gauge,
  Github,
  Globe2,
  PanelsTopLeft,
  SquareTerminal,
} from 'lucide-react';
import React from 'react';

import { applyThemeSetting } from '../../lib/app-settings';
import { getAppSettings, updateAppSettings } from '../../lib/backend';
import { tForLocale } from '../../lib/i18n';
import { markOobeCompleted } from '../../lib/oobe';
import { updateSettingsStoreValues, useSettingsValues } from '../../lib/settings-store';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogPrimaryButton,
  DialogSecondaryButton,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

type OobeStep = 'welcome' | 'personalize' | 'ready';
type OobeLocale = SettingsValues['language'];
type OobeDraftSettings = Pick<
  SettingsValues,
  'language' | 'remoteEnhancementsEnabled' | 'terminalAutoCompleteEnabled' | 'terminalSelectionBarEnabled' | 'theme'
>;

type LanguageMenuProps = {
  iconOnly?: boolean;
  locale: OobeLocale;
  onLocaleChange: (locale: OobeLocale) => void;
};

type SettingLabelProps = {
  /** Canonical Settings description shown in a helper tooltip; omit it for self-explanatory settings. */
  description?: string;
  htmlFor: string;
  label: string;
};

type SwitchSettingProps = SettingLabelProps & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

type ThemeChoice = {
  /** Fixed-color backdrop of the miniature skeleton preview; must not follow the active theme. */
  previewClassName: string;
  /** Optional clipped second half painted over the backdrop (system theme split). */
  previewOverlayClassName?: string;
  /** Skeleton bar color that stays legible on the preview backdrop. */
  skeletonClassName: string;
  value: SettingsValues['theme'];
};

type ResourceCard = {
  descriptionKey: string;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: string;
  url: string;
};

const OOBE_STEPS: readonly OobeStep[] = ['welcome', 'personalize', 'ready'];
const THEME_CHOICES: readonly ThemeChoice[] = [
  { value: 'dark', previewClassName: 'bg-neutral-900', skeletonClassName: 'bg-neutral-600' },
  { value: 'light', previewClassName: 'bg-white', skeletonClassName: 'bg-neutral-300' },
  {
    value: 'auto',
    previewClassName: 'bg-neutral-900',
    // clip-path keeps the light half free of gradient anti-aliasing seams.
    previewOverlayClassName: 'bg-white [clip-path:polygon(100%_0,100%_100%,0_100%)]',
    skeletonClassName: 'bg-neutral-400',
  },
];
const RESOURCE_CARDS: readonly ResourceCard[] = [
  {
    titleKey: 'oobe.ready.resources.website.title',
    descriptionKey: 'oobe.ready.resources.website.description',
    icon: Globe2,
    url: 'https://cosmosh.pages.dev',
  },
  {
    titleKey: 'oobe.ready.resources.guide.title',
    descriptionKey: 'oobe.ready.resources.guide.description',
    icon: BookOpen,
    url: 'https://cosmosh.pages.dev/user/getting-started',
  },
  {
    titleKey: 'oobe.ready.resources.openSource.title',
    descriptionKey: 'oobe.ready.resources.openSource.description',
    icon: Github,
    url: 'https://github.com/agoudbg/cosmosh',
  },
];

/**
 * Selects the settings owned by the first-run personalization screen.
 *
 * @param values Complete application settings snapshot.
 * @returns OOBE-owned draft settings.
 */
const selectOobeDraftSettings = (values: SettingsValues): OobeDraftSettings => ({
  language: values.language,
  theme: values.theme,
  remoteEnhancementsEnabled: values.remoteEnhancementsEnabled,
  terminalAutoCompleteEnabled: values.terminalAutoCompleteEnabled,
  terminalSelectionBarEnabled: values.terminalSelectionBarEnabled,
});

/**
 * Renders the shared language selector used by the welcome and personalization screens.
 *
 * @param props Current locale, change callback, and trigger presentation.
 * @returns Localized language dropdown.
 */
const LanguageMenu: React.FC<LanguageMenuProps> = ({ iconOnly = false, locale, onLocaleChange }) => {
  const translate = React.useCallback((key: string) => tForLocale(locale, key), [locale]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={iconOnly ? undefined : 'oobe-language'}
          variant={iconOnly ? 'ghostIcon' : 'ghost'}
          className={classNames(!iconOnly && 'min-w-[150px] !justify-end')}
          aria-label={translate('oobe.languageMenu.label')}
        >
          {iconOnly ? <Globe2 className="h-4 w-4" /> : <span>{translate(`settings.options.language.${locale}`)}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        horizontalAlign="right"
        sideOffset={8}
      >
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => onLocaleChange(value as OobeLocale)}
        >
          <DropdownMenuRadioItem value="en">{tForLocale(locale, 'settings.options.language.en')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="zh-CN">
            {tForLocale(locale, 'settings.options.language.zh-CN')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Renders a setting label with the canonical Settings description in a tooltip.
 *
 * @param props Label text, control association, and helper description.
 * @returns Accessible setting label and tooltip.
 */
const SettingLabel: React.FC<SettingLabelProps> = ({ description, htmlFor, label }) => (
  <div className="flex min-w-0 items-center gap-1.5">
    <Label
      htmlFor={htmlFor}
      className="min-w-0 px-0 font-medium !text-form-text"
    >
      {label}
    </Label>
    {description ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-form-text-muted outline-none [-webkit-app-region:no-drag] hover:bg-form-control-hover hover:text-form-text"
            aria-label={description}
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[320px]">{description}</TooltipContent>
      </Tooltip>
    ) : null}
  </div>
);

/**
 * Renders a compact label-left, switch-right OOBE setting row.
 *
 * @param props Switch state, label, helper text, and change callback.
 * @returns OOBE switch setting row.
 */
const SwitchSetting: React.FC<SwitchSettingProps> = ({ checked, description, htmlFor, label, onCheckedChange }) => (
  <div className="flex min-h-[52px] items-center justify-between gap-4 border-b border-home-divider py-2.5 last:border-b-0">
    <SettingLabel
      description={description}
      htmlFor={htmlFor}
      label={label}
    />
    <Switch
      id={htmlFor}
      checked={checked}
      onCheckedChange={onCheckedChange}
    />
  </div>
);

/**
 * Presents Cosmosh's non-dismissible first-run experience.
 *
 * The workbench is not mounted behind this dialog. Completion persists settings
 * and the OOBE marker before reloading the renderer into the normal app shell.
 *
 * @returns First-run dialog occupying the renderer window.
 */
const FirstRunExperience: React.FC = () => {
  const settings = useSettingsValues();
  const hasEditedDraftRef = React.useRef<boolean>(false);
  const [draft, setDraft] = React.useState<OobeDraftSettings>(() => selectOobeDraftSettings(settings));
  const [step, setStep] = React.useState<OobeStep>('welcome');
  const [isCompleting, setIsCompleting] = React.useState<boolean>(false);
  const [isClosing, setIsClosing] = React.useState<boolean>(false);
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const locale = draft.language;
  const activeStepIndex = OOBE_STEPS.indexOf(step);
  const previousStep = activeStepIndex > 0 ? OOBE_STEPS[activeStepIndex - 1] : null;
  const translate = React.useCallback((key: string) => tForLocale(locale, key), [locale]);

  React.useEffect(() => {
    if (!hasEditedDraftRef.current) {
      setDraft(selectOobeDraftSettings(settings));
    }
  }, [settings]);

  /**
   * Applies one draft setting while preserving all other OOBE choices.
   * Theme edits preview immediately behind the OOBE transition surface.
   *
   * @param key OOBE-owned setting key.
   * @param value Next setting value.
   * @returns Nothing.
   */
  const updateDraft = React.useCallback(
    <K extends keyof OobeDraftSettings>(key: K, value: OobeDraftSettings[K]): void => {
      hasEditedDraftRef.current = true;
      setDraft((current) => ({
        ...current,
        [key]: value,
      }));
      if (key === 'theme') {
        applyThemeSetting(value as OobeDraftSettings['theme']);
      }
      setErrorMessage('');
    },
    [],
  );

  /**
   * Opens an approved Cosmosh resource through the preload bridge.
   *
   * @param targetUrl HTTPS resource URL.
   * @returns Nothing.
   */
  const openResource = React.useCallback(
    async (targetUrl: string): Promise<void> => {
      try {
        const opened = await window.electron?.openExternalUrl?.(targetUrl);
        if (!opened) {
          setErrorMessage(translate('oobe.errors.openResourceFailed'));
        }
      } catch {
        setErrorMessage(translate('oobe.errors.openResourceFailed'));
      }
    },
    [translate],
  );

  /**
   * Reloads the renderer into the normal app shell after settings persist.
   *
   * @returns Nothing.
   */
  const reloadRenderer = React.useCallback(async (): Promise<void> => {
    try {
      const reloadRequested = await window.electron?.reloadWebView?.();
      if (reloadRequested) {
        return;
      }
    } catch {
      // A renderer reload remains available when the Electron bridge rejects.
    }

    window.location.reload();
  }, []);

  /**
   * Persists personalized settings, records completion, then closes the dialog
   * and reloads only after the exit animation finishes.
   *
   * @returns Nothing.
   */
  const completeOobe = React.useCallback(async (): Promise<void> => {
    if (isCompleting) {
      return;
    }

    setIsCompleting(true);
    setErrorMessage('');

    try {
      const currentResponse = await getAppSettings();
      const updatedResponse = await updateAppSettings({
        scope: currentResponse.data.item.scope,
        values: {
          ...currentResponse.data.item.values,
          ...draft,
        },
      });

      await updateSettingsStoreValues(updatedResponse.data.item.values);

      if (!markOobeCompleted()) {
        throw new Error(translate('oobe.errors.persistCompletionFailed'));
      }

      setIsClosing(true);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : translate('oobe.errors.saveFailed'));
      setIsCompleting(false);
    }
  }, [draft, isCompleting, translate]);

  /**
   * Resolves the renderer reload once the closed-state dialog animation ends.
   * Falls back to a timed reload when the animation event never arrives
   * (for example under reduced motion).
   *
   * @returns Nothing.
   */
  const handleExitComplete = React.useCallback((): void => {
    void reloadRenderer();
  }, [reloadRenderer]);

  React.useEffect(() => {
    if (!isClosing) {
      return;
    }

    // Reduced-motion or interrupted animation frames can suppress animationend;
    // never let a missing event strand the user on a closed dialog.
    const fallbackTimer = window.setTimeout(() => {
      void reloadRenderer();
    }, 1000);

    return () => {
      window.clearTimeout(fallbackTimer);
    };
  }, [isClosing, reloadRenderer]);

  return (
    <TooltipProvider>
      {/* Full-screen title-bar-equivalent drag layer; the dialog surface opts out
          explicitly (app-region works as union/subtraction, not topmost hit-test),
          so only the window margins around the dialog drag. */}
      <div
        aria-hidden="true"
        className="fixed inset-0 [-webkit-app-region:drag]"
      />
      <div className="oobe-theme-transition h-screen w-screen overflow-hidden bg-bg text-text">
        <Dialog open={!isClosing}>
          <DialogContent
            showCloseButton={false}
            className="h-[calc(100vh-5rem)] max-h-[800px] !w-[calc(100%-5rem)] !max-w-[800px] grid-rows-[minmax(0,1fr)_auto] !gap-0 overflow-hidden !p-0 [-webkit-app-region:no-drag]"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onExitComplete={handleExitComplete}
          >
            <DialogTitle className="sr-only">{translate('oobe.dialogTitle')}</DialogTitle>
            <DialogDescription className="sr-only">{translate('oobe.dialogDescription')}</DialogDescription>

            <div className="relative min-h-0 overflow-hidden">
              {OOBE_STEPS.map((screenStep, index) => {
                const isActive = step === screenStep;

                return (
                  <section
                    key={screenStep}
                    className="absolute inset-0 overflow-y-auto transition-transform duration-500 ease-slide motion-reduce:transition-none"
                    style={{ transform: `translateX(${(index - activeStepIndex) * 100}%)` }}
                    aria-hidden={!isActive}
                    inert={!isActive}
                  >
                    {screenStep === 'welcome' ? (
                      <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-12 sm:px-12">
                        <div className="absolute right-5 top-5">
                          <LanguageMenu
                            iconOnly
                            locale={locale}
                            onLocaleChange={(nextLocale) => updateDraft('language', nextLocale)}
                          />
                        </div>

                        <div className="grid w-full max-w-[760px] justify-items-center gap-12">
                          <div className="grid justify-items-center gap-6 text-center">
                            <div
                              className="flex h-16 w-16 items-center justify-center rounded-xl border border-home-divider bg-form-control text-form-text"
                              aria-hidden="true"
                            >
                              <SquareTerminal className="h-8 w-8" />
                            </div>
                            <div className="grid gap-3">
                              <h1 className="text-3xl font-semibold text-dialog-text sm:text-4xl">
                                {translate('oobe.welcome.title')}
                              </h1>
                              <p className="text-sm text-dialog-text-muted">{translate('oobe.welcome.subtitle')}</p>
                            </div>
                          </div>

                          <div className="grid w-full gap-6">
                            {[
                              { key: 'performance', icon: Gauge },
                              { key: 'workflow', icon: FolderSync },
                              { key: 'workspace', icon: PanelsTopLeft },
                            ].map(({ key, icon: Icon }) => (
                              <div
                                key={key}
                                className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-4"
                              >
                                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-form-control text-form-text">
                                  <Icon className="h-5 w-5" />
                                </div>
                                <div className="grid gap-0.5 pt-0.5">
                                  <h2 className="text-sm font-medium text-dialog-text">
                                    {translate(`oobe.welcome.features.${key}.title`)}
                                  </h2>
                                  <p className="text-sm leading-5 text-dialog-text-muted">
                                    {translate(`oobe.welcome.features.${key}.description`)}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {screenStep === 'personalize' ? (
                      <div className="mx-auto grid min-h-full w-full max-w-[1040px] content-start gap-7 px-6 py-10 sm:px-10">
                        <div className="grid gap-2">
                          <h1 className="text-2xl font-semibold text-dialog-text sm:text-3xl">
                            {translate('oobe.personalize.title')}
                          </h1>
                          <p className="text-sm text-dialog-text-muted">{translate('oobe.personalize.description')}</p>
                        </div>

                        <section
                          className="grid gap-3"
                          aria-labelledby="oobe-theme-heading"
                        >
                          <h2
                            id="oobe-theme-heading"
                            className="text-form-label font-medium text-form-text"
                          >
                            {translate('settings.items.theme.title')}
                          </h2>
                          <div
                            className="grid max-w-[360px] grid-cols-1 gap-3 sm:grid-cols-3"
                            role="radiogroup"
                            aria-labelledby="oobe-theme-heading"
                          >
                            {THEME_CHOICES.map(
                              ({ value, previewClassName, previewOverlayClassName, skeletonClassName }) => {
                                const isSelected = draft.theme === value;

                                return (
                                  <button
                                    key={value}
                                    type="button"
                                    role="radio"
                                    aria-checked={isSelected}
                                    className={classNames(
                                      'grid content-start justify-items-center gap-1.5 rounded-md p-1.5 text-xs outline-none transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-outline',
                                      isSelected
                                        ? 'text-form-text ring-2 ring-form-active'
                                        : 'text-form-text-muted hover:bg-form-control-hover hover:text-form-text',
                                    )}
                                    onClick={() => updateDraft('theme', value)}
                                  >
                                    <span
                                      aria-hidden="true"
                                      className={classNames(
                                        'relative block aspect-[16/10] w-full overflow-hidden rounded-sm border border-black/10',
                                        previewClassName,
                                      )}
                                    >
                                      {previewOverlayClassName ? (
                                        <span className={classNames('absolute inset-0', previewOverlayClassName)} />
                                      ) : null}
                                      <span className="relative flex h-full w-full flex-col gap-1 p-1.5">
                                        <span className={classNames('h-1 w-1/3 rounded-full', skeletonClassName)} />
                                        <span className={classNames('h-1 w-3/4 rounded-full', skeletonClassName)} />
                                        <span className={classNames('h-1 w-1/2 rounded-full', skeletonClassName)} />
                                      </span>
                                    </span>
                                    <span>{translate(`settings.options.theme.${value}`)}</span>
                                  </button>
                                );
                              },
                            )}
                          </div>
                        </section>

                        <div className="grid gap-x-10 md:grid-cols-2">
                          <div>
                            <div className="flex min-h-[52px] items-center justify-between gap-4 border-b border-home-divider py-2.5">
                              <SettingLabel
                                htmlFor="oobe-language"
                                label={translate('settings.items.language.title')}
                              />
                              <LanguageMenu
                                locale={locale}
                                onLocaleChange={(nextLocale) => updateDraft('language', nextLocale)}
                              />
                            </div>
                            <SwitchSetting
                              htmlFor="oobe-remote-enhancements"
                              label={translate('settings.items.remoteEnhancementsEnabled.title')}
                              description={translate('settings.items.remoteEnhancementsEnabled.description')}
                              checked={draft.remoteEnhancementsEnabled}
                              onCheckedChange={(checked) => updateDraft('remoteEnhancementsEnabled', checked)}
                            />
                          </div>
                          <div>
                            <SwitchSetting
                              htmlFor="oobe-terminal-auto-complete"
                              label={translate('settings.items.terminalAutoCompleteEnabled.title')}
                              description={translate('settings.items.terminalAutoCompleteEnabled.description')}
                              checked={draft.terminalAutoCompleteEnabled}
                              onCheckedChange={(checked) => updateDraft('terminalAutoCompleteEnabled', checked)}
                            />
                            <SwitchSetting
                              htmlFor="oobe-orbit-bar"
                              label={translate('settings.items.terminalSelectionBarEnabled.title')}
                              description={translate('settings.items.terminalSelectionBarEnabled.description')}
                              checked={draft.terminalSelectionBarEnabled}
                              onCheckedChange={(checked) => updateDraft('terminalSelectionBarEnabled', checked)}
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {screenStep === 'ready' ? (
                      <div className="flex min-h-full flex-col items-center justify-center px-6 py-12 sm:px-12">
                        <div className="grid w-full max-w-[940px] justify-items-center gap-12">
                          <div className="grid justify-items-center gap-6 text-center">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-form-active text-bg">
                              <Check className="h-6 w-6" />
                            </div>
                            <div className="grid gap-3">
                              <h1 className="text-3xl font-semibold text-dialog-text">
                                {translate('oobe.ready.title')}
                              </h1>
                              <p className="text-sm text-dialog-text-muted">{translate('oobe.ready.description')}</p>
                            </div>
                          </div>

                          <div className="grid w-full gap-4 md:grid-cols-3">
                            {RESOURCE_CARDS.map(({ descriptionKey, icon: Icon, titleKey, url }) => (
                              <button
                                key={titleKey}
                                type="button"
                                className="grid min-h-[168px] content-start gap-4 rounded-lg border border-home-divider bg-form-control p-5 text-left outline-none transition-colors [-webkit-app-region:no-drag] hover:bg-form-control-hover"
                                onClick={() => void openResource(url)}
                              >
                                <Icon className="h-6 w-6 text-form-text" />
                                <span className="grid gap-1.5">
                                  <span className="text-sm font-medium text-form-text">{translate(titleKey)}</span>
                                  <span className="text-sm leading-5 text-form-text-muted">
                                    {translate(descriptionKey)}
                                  </span>
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>

            <footer className="flex min-h-[68px] flex-col gap-3 border-t border-home-divider px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div
                className={classNames(
                  'min-w-0 text-xs',
                  errorMessage ? 'text-form-message-error' : 'text-dialog-text-muted',
                )}
                role={errorMessage ? 'alert' : undefined}
              >
                {errorMessage || (step === 'personalize' ? translate('oobe.personalize.settingsHint') : '\u00A0')}
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                {previousStep ? (
                  <DialogSecondaryButton onClick={() => setStep(previousStep)}>
                    {translate('oobe.actions.back')}
                  </DialogSecondaryButton>
                ) : null}
                {step === 'welcome' ? (
                  <DialogPrimaryButton
                    autoFocus
                    onClick={() => setStep('personalize')}
                  >
                    {translate('oobe.actions.next')}
                  </DialogPrimaryButton>
                ) : null}
                {step === 'personalize' ? (
                  <DialogPrimaryButton onClick={() => setStep('ready')}>
                    {translate('oobe.actions.next')}
                  </DialogPrimaryButton>
                ) : null}
                {step === 'ready' ? (
                  <DialogPrimaryButton
                    className="min-w-[112px]"
                    disabled={isCompleting}
                    aria-busy={isCompleting}
                    onClick={() => void completeOobe()}
                  >
                    {translate('oobe.actions.start')}
                  </DialogPrimaryButton>
                ) : null}
              </div>
            </footer>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
};

export default FirstRunExperience;
