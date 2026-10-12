// gh-comment render --json supplies the parsed entry kinds. Do not scan the
// Markdown ourselves: directive examples inside code fences are not threads.
export function assertResolvableComments(plan, allowConversationComments = false) {
  if (!Array.isArray(plan?.comments) || plan.comments.length === 0) {
    throw new Error('gh-comment returned no review entries; nothing will be posted');
  }
  const conversationEntries = [];
  for (const [index, entry] of plan.comments.entries()) {
    if (!entry || typeof entry.body !== 'string') {
      throw new Error('gh-comment returned an invalid review entry; nothing will be posted');
    }
    if (entry.kind === undefined) conversationEntries.push(index + 1);
    else if (!['thread', 'file', 'reply', 'review'].includes(entry.kind)) {
      throw new Error(`Unsupported gh-comment entry kind: ${entry.kind}`);
    }
  }
  if (conversationEntries.length && !allowConversationComments) {
    throw new Error(
      `Entries ${conversationEntries.join(', ')} would be non-resolvable PR conversation comments. ` +
      'Put actionable findings in gh-comment:thread entries at relevant diff lines, or ' +
      'gh-comment:file entries for changed-file findings. A gh-comment:review summary is allowed. ' +
      'For intentional general discussion, set workflow input allowConversationComments=true. ' +
      'Nothing was posted.',
    );
  }
}
