import { readInboundSource } from '@animalabs/agent-framework';

const HOST_NOTE_KEY = 'hostNote';

export function hostNoteMetadata(kind: string): Record<string, string> {
  return { [HOST_NOTE_KEY]: kind };
}

export interface Speaker {
  kind: 'you' | 'host' | 'other';
  label: string;
}

export function speakerOf(participant: string, metadata: unknown): Speaker {
  const m = metadata !== null && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const kind = m.system === true ? m.kind : m[HOST_NOTE_KEY];
  if (m.system === true || typeof kind === 'string') {
    const named = typeof kind === 'string' ? kind.replace(/^host-/, '').replace(/-/g, ' ') : '';
    return { kind: 'host', label: named === '' ? 'host' : `host · ${named}` };
  }
  const source = readInboundSource(metadata);
  if (source?.kind === 'surface') return { kind: 'you', label: 'you' };
  if (source?.kind === 'unscoped') return { kind: 'other', label: `${source.serverId} (push)` };
  if (source?.kind === 'channel') {
    const channel = source.label ?? source.channelId;
    const author = authorOf(m);
    if (author === undefined && source.lane === 'push/event') return { kind: 'other', label: `${source.serverId} (push) in ${channel}` };
    return { kind: 'other', label: `${author ?? 'someone'} in ${channel}` };
  }
  return { kind: 'other', label: participant };
}

function authorOf(m: Record<string, unknown>): string | undefined {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const author = m.author as { id?: unknown; name?: unknown } | undefined;
  // agent-framework 0.27.0 gives a coalesced push that names no author `{ id: '', name: 'Someone' }`
  // (framework.ts, the coalesced channel event), and a push's own origin fields land flat in metadata.
  const id = text(author?.id);
  return (id !== undefined ? text(author?.name) ?? id : undefined) ?? text(m.authorName) ?? text(m.authorId);
}
