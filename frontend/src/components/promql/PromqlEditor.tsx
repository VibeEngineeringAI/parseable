import { useEffect, useRef, type CSSProperties } from 'react';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as editorPlaceholder } from '@codemirror/view';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
} from '@codemirror/autocomplete';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { minimalSetup } from 'codemirror';
import { tags } from '@lezer/highlight';
import { PromQLExtension } from '@prometheus-io/codemirror-promql';
import { createCompletionStrategy, type PromqlMetadataSource } from './completion';
import './promql.css';

export type { PromqlMetadataSource } from './completion';

export interface PromqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  metadata?: PromqlMetadataSource;
  label?: string;
  placeholder?: string;
  minHeight?: number;
  readOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

const externalValue = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.function(tags.variableName)],
    color: 'var(--color-primary)',
    fontWeight: '600',
  },
  { tag: [tags.string, tags.labelName], color: 'var(--color-success)' },
  { tag: tags.number, color: 'var(--color-warning)' },
  { tag: tags.comment, color: 'var(--color-muted)' },
]);

export function PromqlEditor({
  value,
  onChange,
  onRun,
  metadata,
  label = 'PromQL query',
  placeholder = 'e.g. rate({"http.server.requests"}[5m])',
  minHeight = 88,
  readOnly = false,
  invalid = false,
  describedBy,
}: PromqlEditorProps) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef<PromQLExtension | null>(null);
  const languageCompartment = useRef(new Compartment());
  const attributesCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };

  useEffect(() => {
    const extension = new PromQLExtension();
    const editor = new EditorView({
      parent: element.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          minimalSetup,
          closeBrackets(),
          keymap.of(closeBracketsKeymap),
          bracketMatching(),
          autocompletion(),
          languageCompartment.current.of(extension.asExtension()),
          attributesCompartment.current.of([]),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  if (!callbacks.current.onRun) return false;
                  callbacks.current.onRun();
                  return true;
                },
              },
            ]),
          ),
          syntaxHighlighting(highlighting),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalValue))
            ) {
              callbacks.current.onChange(update.state.doc.toString());
            }
          }),
          EditorView.theme({
            '&': {
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text)',
              fontSize: '13px',
              minHeight: 'var(--promql-min-height)',
            },
            '.cm-content': { fontFamily: 'var(--font-mono)', padding: '12px 0' },
            '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
              backgroundColor: 'var(--color-primary-soft)',
            },
          }),
        ],
      }),
    });
    language.current = extension;
    view.current = editor;
    return () => {
      view.current = null;
      language.current = null;
      extension.destroy();
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: externalValue.of(true),
      });
    }
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    const extension = language.current;
    if (!editor || !extension) return;
    closeCompletion(editor);
    extension.destroy();
    extension.setComplete({ completeStrategy: createCompletionStrategy(metadata) });
    editor.dispatch({ effects: languageCompartment.current.reconfigure(extension.asExtension()) });
  }, [metadata]);

  useEffect(() => {
    view.current?.dispatch({
      effects: attributesCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        editorPlaceholder(placeholder),
        EditorView.contentAttributes.of({
          'aria-label': label,
          'aria-invalid': String(invalid),
          'aria-readonly': String(readOnly),
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        }),
      ]),
    });
  }, [label, placeholder, readOnly, invalid, describedBy]);

  return (
    <div
      ref={element}
      className="promql-editor"
      data-invalid={invalid || undefined}
      style={{ '--promql-min-height': `${minHeight}px` } as CSSProperties}
    />
  );
}
