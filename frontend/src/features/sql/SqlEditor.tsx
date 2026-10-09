import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { sql } from '@codemirror/lang-sql';
import { basicSetup } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
export function SqlEditor({
  value,
  onChange,
  onRun,
  invalid = false,
  describedBy,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  invalid?: boolean;
  describedBy?: string;
  readOnly?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const attributes = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun });
  callbacks.current = { onChange, onRun };
  useEffect(() => {
    const editor = new EditorView({
      parent: element.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          sql(),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  callbacks.current.onRun();
                  return true;
                },
              },
            ]),
          ),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.keyword, color: 'var(--color-primary)', fontWeight: '600' },
              { tag: [tags.string, tags.name], color: 'var(--color-success)' },
              { tag: tags.number, color: 'var(--color-warning)' },
              { tag: tags.comment, color: 'var(--color-muted)' },
            ]),
          ),
          attributes.current.of([]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': {
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text)',
              fontSize: '13px',
              minHeight: '220px',
            },
            '.cm-content': { fontFamily: 'var(--font-mono)', padding: '18px 0' },
            '.cm-gutters': {
              backgroundColor: 'var(--color-bg)',
              color: 'var(--color-muted)',
              borderRight: '1px solid var(--color-border)',
            },
            '.cm-activeLine': { backgroundColor: 'var(--color-primary-soft)' },
            '.cm-activeLineGutter': { backgroundColor: 'var(--color-primary-soft)' },
            '.cm-cursor': { borderLeftColor: 'var(--color-text)' },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: attributes.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          'aria-label': 'SQL query',
          'aria-invalid': String(invalid),
          'aria-readonly': String(readOnly),
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        }),
      ]),
    });
  }, [invalid, describedBy, readOnly]);
  return <div className="sql-editor" data-invalid={invalid || undefined} ref={element} />;
}
