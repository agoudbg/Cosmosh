import { redo, undo } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import React from 'react';

import { CodeMirrorTextContextMenu } from '../../components/ui/codemirror-text-context-menu';
import { createCodeMirrorSearchReplaceExtension } from '../../lib/codemirror-search';
import { cosmoshCodeMirrorSyntaxHighlighting } from '../../lib/codemirror-syntax-theme';

type SftpCodeMirrorLanguageLoader = () => Promise<Extension>;

const CODEMIRROR_LANGUAGE_LOADERS: Partial<Record<string, SftpCodeMirrorLanguageLoader>> = {
  css: async () => (await import('@codemirror/lang-css')).css(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  shell: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
};

const editorEditableCompartment = new Compartment();
const editorReadOnlyCompartment = new Compartment();

/**
 * Small imperative surface exposed to SFTP toolbar controls.
 */
export type SftpPreviewEditorHandle = {
  /**
   * Focuses the editor without forcing page scroll.
   *
   * @returns Nothing.
   */
  focus: () => void;
  /**
   * Runs one editor undo step.
   *
   * @returns Nothing.
   */
  undo: () => void;
  /**
   * Runs one editor redo step.
   *
   * @returns Nothing.
   */
  redo: () => void;
};

/**
 * Props for the lazily loaded SFTP CodeMirror preview editor.
 */
export type SftpCodeMirrorPreviewEditorProps = {
  language: string;
  readOnly: boolean;
  value: string;
  onChange: (content: string) => void;
  onMount: (editorHandle: SftpPreviewEditorHandle) => void;
  onSave: () => Promise<void> | void;
};

/**
 * Loads the CodeMirror language extension used by one SFTP preview.
 *
 * @param language Renderer-local preview language id.
 * @returns CodeMirror extension for the language or null for plaintext.
 */
const loadLanguageExtension = async (language: string): Promise<Extension | null> => {
  const loader = CODEMIRROR_LANGUAGE_LOADERS[language];
  if (!loader) {
    return null;
  }

  return loader();
};

/**
 * Builds a compact dark editor theme that fits the existing SFTP preview pane.
 *
 * @returns CodeMirror theme extension.
 */
const createSftpEditorTheme = (): Extension =>
  EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: 'var(--color-text)',
        fontSize: '12px',
        height: '100%',
        lineHeight: '18px',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--color-text)',
      },
      '.cm-content': {
        color: 'var(--color-text)',
        caretColor: 'var(--color-text)',
        minHeight: '100%',
        padding: '8px 0',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--color-text)',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        borderRightColor: 'transparent',
        color: 'var(--color-home-text-subtle)',
      },
      '.cm-gutterElement': {
        padding: '0 10px 0 8px',
      },
      '.cm-line': {
        padding: '0 8px',
      },
      '.cm-line ::selection': {
        backgroundColor: 'var(--color-menu-selection-bar-border)',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
        overflow: 'auto',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--color-menu-selection-bar-border)',
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'var(--color-menu-selection-bar-border)',
        outline: '1px solid var(--color-home-divider)',
      },
      '.cm-panels': {
        backgroundColor: 'var(--color-menu-control)',
        borderColor: 'var(--color-menu-divider)',
        color: 'var(--color-text)',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--color-menu-selection-bar-border)',
        outline: '1px solid var(--color-home-divider)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--color-command-item-active)',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--color-menu-control)',
        borderColor: 'var(--color-menu-divider)',
        color: 'var(--color-text)',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--color-command-item-active)',
        color: 'var(--color-text)',
      },
      '.cm-button': {
        backgroundColor: 'var(--color-form-control)',
        backgroundImage: 'none',
        borderColor: 'var(--color-home-divider)',
        color: 'var(--color-form-text)',
      },
      '.cm-textfield': {
        backgroundColor: 'var(--color-form-control)',
        borderColor: 'var(--color-home-divider)',
        color: 'var(--color-form-text)',
      },
    },
    { dark: true },
  );

/**
 * Creates the CodeMirror extension set for one SFTP preview editor instance.
 *
 * @param options Language support, readonly state, and change callback.
 * @returns Extension list passed to CodeMirror state creation.
 */
const createEditorExtensions = (options: {
  languageExtension: Extension | null;
  onChange: (content: string) => void;
  onSave: () => void;
  readOnly: boolean;
}): Extension[] => [
  basicSetup,
  Prec.highest(
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          options.onSave();
          return true;
        },
      },
    ]),
  ),
  createSftpEditorTheme(),
  // The preview pane is usually a narrow sidebar, so pin search/replace to the bottom
  // edge as a full-width bar instead of a floating overlay that clips or covers content.
  createCodeMirrorSearchReplaceExtension({ placement: 'docked-bottom' }),
  cosmoshCodeMirrorSyntaxHighlighting,
  EditorView.lineWrapping,
  EditorState.tabSize.of(2),
  editorReadOnlyCompartment.of(EditorState.readOnly.of(options.readOnly)),
  editorEditableCompartment.of(EditorView.editable.of(!options.readOnly)),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      options.onChange(update.state.doc.toString());
    }
  }),
  ...(options.languageExtension ? [options.languageExtension] : []),
];

/**
 * Renders the editable CodeMirror instance for SFTP text previews.
 *
 * @param props CodeMirror value, language, and editor callbacks.
 * @returns CodeMirror preview editor host.
 */
export const SftpCodeMirrorPreviewEditor: React.FC<SftpCodeMirrorPreviewEditorProps> = ({
  language,
  onChange,
  onMount,
  onSave,
  readOnly,
  value,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const onMountRef = React.useRef(onMount);
  const onSaveRef = React.useRef(onSave);
  const readOnlyRef = React.useRef(readOnly);
  const valueRef = React.useRef(value);

  React.useEffect(() => {
    onChangeRef.current = onChange;
    onMountRef.current = onMount;
    onSaveRef.current = onSave;
    readOnlyRef.current = readOnly;
    valueRef.current = value;
  }, [onChange, onMount, onSave, readOnly, value]);

  React.useEffect(() => {
    let isDisposed = false;

    /**
     * Mounts CodeMirror after the optional language package finishes loading.
     *
     * @returns Promise resolved after the editor is mounted or skipped.
     */
    const mountEditor = async (): Promise<void> => {
      const languageExtension = await loadLanguageExtension(language);
      if (isDisposed || !containerRef.current) {
        return;
      }

      const view = new EditorView({
        doc: valueRef.current,
        extensions: createEditorExtensions({
          languageExtension,
          onChange: (content) => onChangeRef.current(content),
          onSave: () => {
            void onSaveRef.current();
          },
          readOnly: readOnlyRef.current,
        }),
        parent: containerRef.current,
      });

      viewRef.current = view;
      onMountRef.current({
        focus: () => view.focus(),
        redo: () => {
          redo(view);
          view.focus();
        },
        undo: () => {
          undo(view);
          view.focus();
        },
      });
    };

    void mountEditor();

    return () => {
      isDisposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [language]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({
      effects: [
        editorReadOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
        editorEditableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    });
  }, [readOnly]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  const getEditorView = React.useCallback((): EditorView | null => viewRef.current, []);

  return (
    <CodeMirrorTextContextMenu
      getEditorView={getEditorView}
      readOnly={readOnly}
    >
      <div
        ref={containerRef}
        className="h-full min-h-0"
      />
    </CodeMirrorTextContextMenu>
  );
};

export default SftpCodeMirrorPreviewEditor;
