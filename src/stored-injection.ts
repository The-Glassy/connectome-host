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
import { storedInjectionMarkOf, type StoredInjectionMark } from '@animalabs/agent-framework';
import type { CompileResult } from '@animalabs/context-manager';

/** The label a transcript view shows on a stored injection:
 *  `[retrieval, injected for alice]`. */
export function storedInjectionLabel(mark: Pick<StoredInjectionMark, 'agent' | 'namespace'>): string {
  return `[${mark.namespace}, injected for ${mark.agent}]`;
}

/**
 * A compile's messages without the stored injections, for a reader of a
 * compile rather than of stored rows: peek's last message, a fork's seed. A
 * compiled message carries no metadata, so it's a stored injection when every
 * stored row it was rendered from is marked as one, by the compile's own
 * account of where each message came from (its provenance, and the rows as it
 * read them, `rawBodies`), as agent-framework's own fork seed tells them.
 * A summary, a placed injection, or a message the compile can't account for
 * is kept.
 */
export function compiledWithoutStoredInjections<M>(
  result: { messages: M[] } & Pick<CompileResult, 'provenance' | 'rawBodies'>,
): M[] {
  return result.messages.filter((_, i) => {
    const source = result.provenance?.messages[i];
    if (source?.kind !== 'raw' || source.bodies.length === 0) return true;
    return !source.bodies.every((body) => {
      const head = result.rawBodies?.get(body.messageId)?.[0];
      return head !== undefined && storedInjectionMarkOf(head.metadata) !== undefined;
    });
  });
}
