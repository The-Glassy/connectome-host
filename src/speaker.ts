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
  const source = readInboundSource(metadata);
  if (source?.kind === 'surface') return { kind: 'you', label: 'you' };
  if (source?.kind === 'channel') return { kind: 'other', label: `${authorOf(metadata)} in ${source.label ?? source.channelId}` };
  if (source?.kind === 'unscoped') return { kind: 'other', label: `${source.serverId} (push)` };
  const m = metadata !== null && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const kind = m.system === true ? m.kind : m[HOST_NOTE_KEY];
  if (m.system !== true && typeof kind !== 'string') return { kind: 'other', label: participant };
  const named = typeof kind === 'string' ? kind.replace(/^host-/, '').replace(/-/g, ' ') : '';
  return { kind: 'host', label: named === '' ? 'host' : `host · ${named}` };
}

function authorOf(metadata: unknown): string {
  const author = (metadata as { author?: { name?: unknown; id?: unknown } }).author;
  if (typeof author?.name === 'string' && author.name !== '') return author.name;
  if (typeof author?.id === 'string' && author.id !== '') return author.id;
  return 'someone';
}
