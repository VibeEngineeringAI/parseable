import assert from 'node:assert/strict';
import test from 'node:test';
import { assertResolvableComments } from './comment-clanker-policy.mjs';

test('allows a batch review summary and line threads', () => {
  assert.doesNotThrow(() => assertResolvableComments({ comments: [
    { kind: 'review', event: 'COMMENT', body: 'Two findings below.' },
    { kind: 'thread', path: 'src/apikeys.rs', line: 35, side: 'RIGHT', body: 'Finding.' },
  ] }));
});

test('allows file threads and replies without requiring a guessed line', () => {
  assert.doesNotThrow(() => assertResolvableComments({ comments: [
    { kind: 'file', path: 'src/apikeys.rs', body: 'File-level finding.' },
    { kind: 'reply', parentId: 123, body: 'Follow-up.' },
  ] }));
});

test('rejects ordinary comments even if their body contains a source link or directive example', () => {
  for (const body of [
    'Finding at [source](src/apikeys.rs:35).',
    '```md\n<!-- gh-comment:thread path="src/apikeys.rs" line="35" side="RIGHT" -->\n```',
  ]) {
    assert.throws(() => assertResolvableComments({ comments: [{ body }] }), /non-resolvable/);
  }
});

test('checks every entry and permits explicit general-discussion override', () => {
  const plan = { comments: [
    { kind: 'thread', body: 'Anchored finding.' },
    { body: 'General discussion.' },
  ] };
  assert.throws(() => assertResolvableComments(plan), /Entries 2/);
  assert.doesNotThrow(() => assertResolvableComments(plan, true));
});

test('fails closed on missing, empty or unrecognized render output', () => {
  for (const plan of [null, {}, { comments: [] }, { comments: [null] },
    { comments: [{ kind: 'unknown', body: 'Finding.' }] }]) {
    assert.throws(() => assertResolvableComments(plan));
  }
});
