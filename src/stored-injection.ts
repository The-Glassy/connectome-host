/**
 * Stored context injections (context-manager #155, part 5). agent-framework
 * stores a module's `afterUser` injection in the agent's store where
 * `compile()` would have placed it, so the next compile renders it from the
 * store like any message and a resident's thinking survives it. Each such
 * row carries `metadata.contextInjection: { agent, namespace, contentHash }`:
 * the agent whose start stored it, the injection's namespace (`retrieval`,
 * `subagent-fleet`, an MCPL channel's id) and the hash agent-framework's
 * same-content skip compares. Its participant is `system_context:<namespace>`.
 *
 * Such a row isn't anyone's message. A reader that answers "what did someone
 * say" (the last-text fallback, session naming, retrieval's own window)
 * leaves it out. A reader that shows the transcript shows it, labelled as
 * injected (the TUI's history replay, the Web UI's entries).
 */

export interface StoredInjectionMark {
  agent: string;
  namespace: string;
  contentHash: string;
}

/**
 * The mark a stored row's metadata carries, or undefined for any other row,
 * by agent-framework's own rule (`stored-injections.ts`): a mark missing any
 * of its three strings isn't one, so the compile renders that row as a
 * message, and so does every reader here.
 */
export function storedInjectionOf(metadata: unknown): StoredInjectionMark | undefined {
  const mark = (metadata as Record<string, unknown> | undefined)?.contextInjection;
  if (mark === null || typeof mark !== 'object') return undefined;
  const { agent, namespace, contentHash } = mark as Record<string, unknown>;
  return typeof agent === 'string' && typeof namespace === 'string' && typeof contentHash === 'string'
    ? { agent, namespace, contentHash }
    : undefined;
}

/** The label a transcript view shows on a stored injection:
 *  `[retrieval, injected for alice]`. */
export function storedInjectionLabel(mark: StoredInjectionMark): string {
  return `[${mark.namespace}, injected for ${mark.agent}]`;
}
