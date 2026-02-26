import 'monaco-editor/esm/vs/language/json/monaco.contribution';

import { normalizeSettingsValuesStrict, type SettingsValues, type SettingValidationError } from '@cosmosh/api-contract';
import MonacoEditor, { loader, type Monaco } from '@monaco-editor/react';
import { Save } from 'lucide-react';
import * as monacoEditor from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import React from 'react';

import { Button } from '../components/ui/button';
import { Menubar } from '../components/ui/menubar';
import { type AppSettingsScope } from '../lib/app-settings';
import { getAppSettings, updateAppSettings } from '../lib/backend';
import { onLocaleChange, t } from '../lib/i18n';
import { updateSettingsStoreValues } from '../lib/settings-store';
import { useToast } from '../lib/toast-context';
import { type SettingDefinition, SETTINGS_REGISTRY } from './settings-registry';

type JsonSchemaNode = {
  type?: 'object' | 'string' | 'boolean' | 'integer';
  title?: string;
  description?: string;
  markdownDescription?: string;
  default?: string | number | boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
};

type JsonSchemaDocument = {
  $schema: string;
  title: string;
  type: 'object';
  additionalProperties: boolean;
  properties: Record<string, JsonSchemaNode>;
  required: string[];
};

const MODEL_URI = 'inmemory://cosmosh/settings.json';
const SCHEMA_URI = 'inmemory://cosmosh/settings.schema.json';

const ensureMonacoWorkerEnvironment = (): void => {
  const globalWithEnvironment = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker: (_moduleId: string, label: string) => Worker;
    };
  };

  if (globalWithEnvironment.MonacoEnvironment) {
    return;
  }

  globalWithEnvironment.MonacoEnvironment = {
    getWorker: (_moduleId: string, label: string): Worker => {
      if (label === 'json') {
        return new JsonWorker();
      }

      return new EditorWorker();
    },
  };
};

ensureMonacoWorkerEnvironment();

loader.config({
  monaco: monacoEditor,
});

const stringifySettings = (values: SettingsValues): string => {
  return `${JSON.stringify(values, null, 2)}\n`;
};

const formatValidationError = (error: SettingValidationError): string => {
  try {
    const params: Record<string, string | number> = { ...error.params };
    if (typeof params.nameI18nKey === 'string') {
      params.name = t(params.nameI18nKey as string);
    }

    return t(error.i18nKey, params);
  } catch {
    return error.fallbackMessage;
  }
};

const buildSettingPropertySchema = (item: SettingDefinition): JsonSchemaNode => {
  const settingName = t(item.nameI18nKey);
  const settingDescription = t(item.descriptionI18nKey);

  const base: JsonSchemaNode = {
    description: settingDescription,
    markdownDescription: `**${settingName}**\n\n${settingDescription}`,
    default: item.defaultValue,
  };

  if (item.valueType === 'boolean') {
    return {
      ...base,
      type: 'boolean',
    };
  }

  if (item.valueType === 'number') {
    return {
      ...base,
      type: 'integer',
      minimum: item.min,
      maximum: item.max,
    };
  }

  return {
    ...base,
    type: 'string',
    enum: item.options?.map((option) => option.value),
    maxLength: item.maxLength,
  };
};

const buildSettingsSchema = (): JsonSchemaDocument => {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  SETTINGS_REGISTRY.forEach((item) => {
    properties[item.key] = buildSettingPropertySchema(item);
    required.push(item.key);
  });

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: t('settingsEditor.schemaTitle'),
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
};

const parseSettingsJson = (rawJson: string): { value?: SettingsValues; error?: string } => {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return { error: t('settingsEditor.invalidJson') };
  }

  const normalized = normalizeSettingsValuesStrict(parsedJson);
  if (!normalized.value) {
    return {
      error: normalized.error ? formatValidationError(normalized.error) : t('settingsEditor.validationFailed'),
    };
  }

  return { value: normalized.value };
};

const SettingsEditor: React.FC<{ initialSettingKey?: string }> = ({ initialSettingKey }) => {
  const { error: notifyError, success: notifySuccess, warning: notifyWarning } = useToast();
  const [, setLocaleTick] = React.useState<number>(0);
  const monacoRef = React.useRef<Monaco | null>(null);
  const editorRef = React.useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [scope, setScope] = React.useState<AppSettingsScope>({ deviceId: 'local-device' });
  const [rawJson, setRawJson] = React.useState<string>('{}\n');
  const [savedJson, setSavedJson] = React.useState<string>('{}\n');

  React.useEffect(() => {
    return onLocaleChange(() => {
      setLocaleTick((value) => value + 1);
    });
  }, []);

  const schema = buildSettingsSchema();

  const configureJsonLanguage = React.useCallback((monaco: Monaco, activeSchema: JsonSchemaDocument): void => {
    const jsonLanguageApi = monaco.languages.json as unknown as {
      jsonDefaults: {
        setDiagnosticsOptions: (options: {
          validate: boolean;
          allowComments: boolean;
          enableSchemaRequest: boolean;
          trailingCommas: 'error' | 'warning' | 'ignore';
          schemas: Array<{
            uri: string;
            fileMatch: string[];
            schema: JsonSchemaDocument;
          }>;
        }) => void;
      };
    };

    jsonLanguageApi.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      enableSchemaRequest: false,
      trailingCommas: 'error',
      schemas: [
        {
          uri: SCHEMA_URI,
          fileMatch: [MODEL_URI],
          schema: activeSchema,
        },
      ],
    });
  }, []);

  React.useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) {
      return;
    }

    configureJsonLanguage(monaco, schema);
  }, [configureJsonLanguage, schema]);

  React.useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      setIsLoading(true);

      try {
        const response = await getAppSettings();
        if (cancelled) {
          return;
        }

        const nextRawJson = stringifySettings(response.data.item.values);
        setScope(response.data.item.scope);
        setRawJson(nextRawJson);
        setSavedJson(nextRawJson);
      } catch (error: unknown) {
        if (!cancelled) {
          notifyError(error instanceof Error ? error.message : t('settingsEditor.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [notifyError]);

  const hasChanges = rawJson !== savedJson;

  const revealSettingKey = React.useCallback((settingKey: string): void => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const model = editor.getModel();
    if (!model) {
      return;
    }

    const keyToken = `"${settingKey}"`;
    const offset = model.getValue().indexOf(keyToken);
    if (offset < 0) {
      return;
    }

    const start = model.getPositionAt(offset + 1);
    const end = model.getPositionAt(offset + 1 + settingKey.length);
    editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    editor.revealLineInCenter(start.lineNumber);
    editor.focus();
  }, []);

  React.useEffect(() => {
    if (!initialSettingKey || isLoading) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      revealSettingKey(initialSettingKey);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [initialSettingKey, isLoading, rawJson, revealSettingKey]);

  const handleSave = React.useCallback(async (): Promise<void> => {
    if (isSaving) {
      return;
    }

    const parsed = parseSettingsJson(rawJson);
    if (!parsed.value) {
      notifyWarning(parsed.error ?? t('settingsEditor.validationFailed'));
      return;
    }

    setIsSaving(true);

    try {
      const response = await updateAppSettings({
        scope,
        values: parsed.value,
      });

      const nextRawJson = stringifySettings(response.data.item.values);
      setScope(response.data.item.scope);
      setRawJson(nextRawJson);
      setSavedJson(nextRawJson);
      await updateSettingsStoreValues(response.data.item.values);
      notifySuccess(t('settingsEditor.saveSuccess'));
    } catch (error: unknown) {
      notifyError(error instanceof Error ? error.message : t('settingsEditor.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, notifyError, notifySuccess, notifyWarning, rawJson, scope]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="px-3 py-2">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <h1 className="text-home-text text-[24px] font-semibold">{t('settingsEditor.title')}</h1>
          <Menubar>
            <Button
              disabled={isLoading || isSaving || !hasChanges}
              onClick={() => {
                void handleSave();
              }}
            >
              <Save className="h-4 w-4" />
              {isSaving ? t('settingsEditor.saving') : t('settingsEditor.save')}
            </Button>
          </Menubar>
        </div>
      </div>

      <div className="h-full w-full flex-1 overflow-hidden rounded-[18px] bg-ssh-card-bg-terminal">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-home-text-subtle">
            {t('settingsEditor.loading')}
          </div>
        ) : (
          <div className="h-full w-full overflow-hidden">
            <MonacoEditor
              path={MODEL_URI}
              language="json"
              value={rawJson}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                tabSize: 2,
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                formatOnPaste: true,
                formatOnType: true,
              }}
              theme="vs-dark"
              beforeMount={(monaco: Monaco) => {
                monacoRef.current = monaco;
                configureJsonLanguage(monaco, schema);
              }}
              onMount={(editor) => {
                editorRef.current = editor;
              }}
              onChange={(value: string | undefined) => {
                setRawJson(value ?? '');
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsEditor;
