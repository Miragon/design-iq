/**
 * Test-side decoding of tool results — the `{isError, text}` extraction that
 * three test suites carried as byte-identical private helpers. Kept apart from
 * the client entry: tests read the RAW first text block (prose or JSON), the
 * widget client (`unwrapToolResult`) is JSON-only.
 */

/** callTool result → `{isError, text}` (first text block, "" when absent).
 *  Takes `object` because the SDK's callTool return is a union whose legacy
 *  `{toolResult}` variant shares no keys with the content shape. */
export function toolText(result: object): { isError: boolean; text: string } {
  const r = result as { content?: unknown; isError?: unknown };
  const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
  return { isError: Boolean(r.isError), text: content[0]?.text ?? "" };
}

/** Every tool-name-shaped token in a prose text — lowercase words joined by
 *  `_` (`list_models`, `open_modeler`), backticked or bare — sorted, deduped.
 *  The servers' instruction tests compare this set against tools/list, so the
 *  instructions can never name a tool the server does not register. */
export function toolNamesIn(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].sort();
}
