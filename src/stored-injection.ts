/**
 * Stored context injections (context-manager #155, part 5). agent-framework
 * stores a module's `afterUser` injection in the agent's store where
 * `compile()` would have placed it, so the next compile renders it from the
 * store like any message and a resident's thinking survives it. Its row's
 * participant is `system_context:<namespace>`, and its metadata carries the
 * mark that agent-framework's `storedInjectionMarkOf` reads: the agent whose
 * start stored it and the injection's namespace (`retrieval`,
 * `subagent-fleet`, an MCPL channel's id). The host reads the mark with that
 * function, so a row is an injection to the host exactly when it is one to
 * the compile.
 *
 * Such a row isn't anyone's message. A reader that answers "what did someone
 * say" (the last-text fallback, session naming, retrieval's own window)
 * leaves it out. A reader that shows the transcript shows it, labelled as
 * injected (the TUI's history replay, the Web UI's entries).
 */
import type { StoredInjectionMark } from '@animalabs/agent-framework';

/** The label a transcript view shows on a stored injection:
 *  `[retrieval, injected for alice]`. */
export function storedInjectionLabel(mark: Pick<StoredInjectionMark, 'agent' | 'namespace'>): string {
  return `[${mark.namespace}, injected for ${mark.agent}]`;
}
