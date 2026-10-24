/**
 * RetrievalModule — LLM-as-retriever for semantic memory.
 *
 * Three-step retrieval pipeline running in gatherContext():
 *   1. Flag concepts: identify concepts being discussed that might benefit
 *      from background knowledge
 *   2. Mechanical query: keyword-match against LessonsModule
 *   3. Validate relevance: filter to actually relevant lessons
 *
 * Steps 1 and 3 use the configured retrieval model and optional reasoning.
 *
 * A turn's result is kept per agent, keyed on the turn's opening message
 * (openingMessageOf), in this process: a start that sees the same opening
 * message, such as a restart after a tool round, gets the same block, with
 * no model calls, while the agent's entry is among the TURN_BLOCKS_MAX most
 * recently used, and the first start after the host restarts runs them
 * again. agent-framework stores the block where the compile placed it
 * (context-manager #155 part 5), and stores it again unless the agent's
 * last request held the same text, as it doesn't once a fold took it. A
 * lesson that stays relevant is stored again with a new turn's block, whose
 * heading names that turn's opening message, so the text differs unless two
 * turns open with messages that begin alike, and the folds take the older
 * copies.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';
import type { LessonsModule, Lesson } from './lessons-module.js';
import { storedInjectionMarkOf } from '@animalabs/agent-framework';
import {
  RetrievalTraceStore,
  type RetrievalTraceListOptions,
  type RetrievalTraceRun,
} from './retrieval-trace.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type RetrievalReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RetrievalReasoningConfig {
  effort: RetrievalReasoningEffort;
}

interface RecentRetrievalContext {
  text: string;
  messageCount: number;
  messageIds: string[];
  /** The turn's opening message (openingMessageOf); undefined where its id
   *  couldn't be read, so the result isn't kept. */
  opening: OpeningMessage | undefined;
}

/**
 * The message a turn answers, as the key its retrieval is kept under. `key`
 * is null where no shown row is anyone's message yet, as in a window of the
 * agent's own replies, notices and clock rows: a key like any other, so such
 * starts share one result until someone writes.
 */
interface OpeningMessage {
  key: string | null;
  /** The start of its text, for the block's heading; undefined when it has
   *  no text, or there's no message. */
  excerpt: string | undefined;
}

/** A turn's retrieval, kept for the starts that see the same opening message. */
interface TurnBlock {
  key: string | null;
  injections: ContextInjection[];
  lessonIds: string[];
  lessons: Lesson[];
  sourceTraceId: number | undefined;
}

/** How many agents' turn blocks are kept. Subagents and forks come and go
 *  under names of their own, so the oldest entry goes past this; an agent
 *  whose entry went only retrieves again. */
const TURN_BLOCKS_MAX = 64;

/** How much of the opening message the heading quotes. */
const EXCERPT_CHARS = 60;

export interface RetrievalModuleConfig {
  /** Membrane instance for retrieval calls */
  membrane: Membrane;
  /** Model to use for retrieval calls (default: claude-haiku-4-5-20251001) */
  retrievalModel?: string;
  /** Optional OpenAI reasoning effort, applied to both retrieval LLM stages. */
  retrievalReasoning?: RetrievalReasoningConfig;
  /** Max lessons to inject (default: 5) */
  maxInjectedLessons?: number;
  /** The per-message token cap the block is fitted under (fitUnderCap): the
   *  smallest of the windows the block can be stored in, as the host works
   *  it out (retrievalMessageCap). Absent, or not a positive number, the
   *  block isn't fitted. */
  maxMessageTokens?: number;
  /** Minimum lesson confidence for injection (default: 0.3) */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONCEPT_FLAG_PROMPT = `You are a knowledge retrieval assistant. Given the recent conversation below, identify concepts, entities, topics, or themes that might benefit from background knowledge or lessons learned from previous research.

Return ONLY a JSON array of keyword strings, nothing else. Example: ["RFC process", "authentication", "team lead"]

If nothing would benefit from background knowledge, return an empty array: []`;

const RELEVANCE_VALIDATION_PROMPT = `You are a relevance filter. Given the current conversation context and a set of candidate knowledge lessons, determine which lessons are actually relevant to the current discussion.

Return ONLY a JSON array of lesson IDs that are relevant, nothing else. Example: ["a1b2c3d4", "e5f6g7h8"]

If none are relevant, return an empty array: []`;

// ---------------------------------------------------------------------------
// The turn's opening message
// ---------------------------------------------------------------------------

/** A stored row, as much of it as the opening message is read from. */
interface ShownRow {
  id?: unknown;
  participant: string;
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  metadata?: unknown;
  bodyGroupId?: unknown;
}

/** `metadata.source` of a self-wake's line, agent-framework's EventGate
 *  (`event-gate.ts`, the self-wake timer): "[self-wake] your … timer
 *  elapsed". */
const SELF_WAKE_SOURCE = 'gate:self-wake';

/**
 * The message a turn answers: the newest of the rows retrieval reads
 * (getRecentContext: those the agent is shown, stored injections left out)
 * that someone other than the agent wrote to it. Passed over, since none of
 * them is anyone's message:
 * - the agent's own replies (participant `agentName`);
 * - a row under participant `system`, as this host's subscription-gc note;
 * - a row with a tool call or its result;
 * - a row marked `metadata.system`, as agent-framework marks its notices
 *   (clock rows, autoContinue's continue prompt, a turn's interruption or
 *   failure) and this host its `[host-notice]`;
 * - a self-wake's line, which says only that the agent's own timer elapsed.
 *
 * A batched wake's `[Gate: …]` line counts: where it doesn't point at
 * messages already shown, it carries the events it reports. Another agent's
 * message counts too, as in a store the residents share, and so do a
 * script's wake and the notes this host stores unmarked: the session's
 * start time, a self-restart's note, a `[voice]` interruption, a subagent's
 * result.
 *
 * Its key is the row's id, so a later start of the same turn sees the same
 * key until another such message lands, as one held for the agent and
 * drained at a tool round can, which is a turn's newer opening message.
 * (A message stored in shards is keyed on its last shard, which stays its
 * last, and is read whole: a tool call's or result's text shards count as
 * the tool row they belong to.) The key is null where no row qualifies,
 * and then the result is shared until someone else's message lands. The
 * result is undefined where the row's id can't be read, so nothing is kept
 * under a key that isn't the row's.
 */
function openingMessageOf(shown: readonly ShownRow[], agentName: string): OpeningMessage | undefined {
  const toolGroups = new Set(shown
    .filter(r => typeof r.bodyGroupId === 'string' && r.bodyGroupId !== '' && r.content.some(b => b.type === 'tool_use' || b.type === 'tool_result'))
    .map(r => r.bodyGroupId));
  for (let i = shown.length - 1; i >= 0; i--) {
    const row = shown[i]!;
    if (!isAMessageTo(row, agentName)) continue;
    if (typeof row.bodyGroupId === 'string' && toolGroups.has(row.bodyGroupId)) continue;
    let id: unknown;
    try {
      id = row.id;
    } catch {
      return undefined;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    return { key: String(id), excerpt: excerptOf(textOfMessage(shown, row)) };
  }
  return { key: null, excerpt: undefined };
}

function isAMessageTo(row: ShownRow, agentName: string): boolean {
  if (row.participant === agentName || row.participant === 'system') return false;
  if (row.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')) return false;
  const metadata = row.metadata as { system?: unknown; source?: unknown } | undefined;
  return metadata?.system !== true && metadata?.source !== SELF_WAKE_SOURCE;
}

/** A row's text, or for a message stored in shards, its shards' text in
 *  store order, which is theirs: context-manager writes a message's shards
 *  in order (`ContextManager.addMessage`). */
function textOfMessage(shown: readonly ShownRow[], row: ShownRow): string {
  const textOf = (r: ShownRow): string => r.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join(' ');
  const group = row.bodyGroupId;
  if (typeof group !== 'string' || group === '') return textOf(row);
  return shown.filter(r => r.bodyGroupId === group).map(textOf).join('');
}

/** A lesson's line in the block. */
function lessonLine(l: Lesson): string {
  return `- [${(l.confidence * 100).toFixed(0)}%] ${l.content} (tags: ${l.tags.join(', ')})`;
}

/**
 * The block's text, fitted under the per-message cap it's given, the
 * smallest of the windows it can be stored in (retrievalMessageCap).
 * agent-framework stores the block as a message, which the strategy cuts at
 * `maxMessageTokens` mid-text, where a block it placed went whole. So when
 * every lesson fits, the block holds them all. Otherwise it keeps each lesson
 * that still fits, most relevant first, leaves out each that doesn't, a
 * single lesson larger than the cap included, and says how many it left out.
 * It counts as the strategy's own estimate does: a text block's characters
 * / 4, rounded up (context-manager's `estimateTextOnlyTokens`, which decides
 * whether its cap cuts). A cap that isn't a positive number means none, as
 * the strategy reads it (`capContent`), and then every lesson is kept.
 */
function fitUnderCap(heading: string, lessons: Lesson[], cap: number | undefined): { text: string; lessons: Lesson[] } {
  const compose = (kept: string[], leftOut: number): string => [
    heading,
    ...kept,
    ...(leftOut > 0 ? [`(${leftOut} more relevant lesson${leftOut === 1 ? '' : 's'} left out, to keep this message under its size limit)`] : []),
  ].join('\n');
  const fits = (text: string): boolean => !(cap !== undefined && cap > 0) || Math.ceil(text.length / 4) <= cap;
  const all = compose(lessons.map(lessonLine), 0);
  if (fits(all)) return { text: all, lessons };
  const kept: Lesson[] = [];
  const lines: string[] = [];
  for (const lesson of lessons) {
    const line = lessonLine(lesson);
    // Room for the note at the most it can end up saying with this lesson
    // kept: every lesson not kept so far but this one. Keeping a later one
    // only shortens it, so the count it ends up saying fits.
    if (fits(compose([...lines, line], lessons.length - kept.length - 1))) {
      kept.push(lesson);
      lines.push(line);
    }
  }
  return { text: compose(lines, lessons.length - kept.length), lessons: kept };
}

/** The start of a message's text on one line, or undefined when it has none. */
function excerptOf(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  const chars = Array.from(line);
  return chars.length <= EXCERPT_CHARS ? line : `${chars.slice(0, EXCERPT_CHARS).join('').trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class RetrievalModule implements Module {
  readonly name = 'retrieval';

  private ctx: ModuleContext | null = null;
  private config: RetrievalModuleConfig;
  /** Each agent's latest turn block, by agent name, oldest first. */
  private readonly turnBlocks = new Map<string, TurnBlock>();
  /** Starts so far, numbering each start (gatherContext). */
  private starts = 0;
  /** Each agent's newest start that hasn't returned, by its number. */
  private readonly latestStarts = new Map<string, number>();
  private readonly traceStore = new RetrievalTraceStore();

  constructor(config: RetrievalModuleConfig) {
    this.config = config;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    // RetrievalModule is passive — no tools, only gatherContext
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** Recent retrieval runs, newest first. Exact conversation inputs are opt-in. */
  getRetrievalTraces(options?: RetrievalTraceListOptions) {
    return this.traceStore.list(options);
  }

  private beginTrace(agentName: string): RetrievalTraceRun | undefined {
    try {
      const providerParams = this.retrievalProviderParams();
      return this.traceStore.begin({
        agentName,
        model: this.config.retrievalModel ?? 'claude-haiku-4-5-20251001',
        ...(this.config.retrievalReasoning
          ? { requestedReasoning: this.config.retrievalReasoning }
          : {}),
        ...(providerParams ? { providerParams } : {}),
        minConfidence: this.config.minConfidence ?? 0.3,
        maxCandidates: 20,
        maxInjectedLessons: this.config.maxInjectedLessons ?? 5,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Run the 3-step retrieval pipeline at a start, or reuse the turn's result.
   * A start's result is kept for the turn only while no later start of the
   * agent's has begun (keepTurnBlock). A later one can begin while this one
   * still runs, as when the framework's gather timeout leaves it behind and
   * the agent starts again, or when a newer turn starts; then it's the later
   * start whose result the framework has, and what it keeps is the turn's,
   * nothing when it keeps nothing. A Web UI preview with injections
   * (previewActivation) gathers too and counts as a start: overlapping a
   * start's model calls, it keeps its own result for the same opening
   * message in that start's place, or none when its own keeps no result
   * (its model call fails, or its concept reply isn't a list; an empty
   * result is kept), so the turn's next start may get a block the framework
   * then stores again, or run the calls again (Agnes-1009, room-203
   * #197691).
   */
  async gatherContext(agentName: string): Promise<ContextInjection[]> {
    const start = ++this.starts;
    this.latestStarts.set(agentName, start);
    try {
      return await this.gather(agentName, start);
    } finally {
      if (this.latestStarts.get(agentName) === start) this.latestStarts.delete(agentName);
    }
  }

  private async gather(agentName: string, start: number): Promise<ContextInjection[]> {
    const trace = this.beginTrace(agentName);
    if (!this.ctx) {
      trace?.finish('not-started');
      return [];
    }

    let lessons: Lesson[];
    let recentMessages: string;
    let opening: OpeningMessage | undefined;
    try {
      // These lookups, eligibility checks, context rendering, and hashing are
      // pre-existing throwing paths. Record their failure, then preserve the
      // upstream rejection rather than applying the provider-stage fail-open.
      const lessonsModule = this.ctx.getModule<LessonsModule>('lessons');
      if (!lessonsModule) {
        trace?.finish('no-lessons-module');
        return [];
      }

      // A lesson with no content has nothing to inject, though its tags
      // could still match: it would be injected as a blank entry.
      lessons = lessonsModule.getLessons().filter(
        l => !l.deprecated && l.confidence >= (this.config.minConfidence ?? 0.3) && l.content.trim() !== ''
      );
      if (lessons.length === 0) {
        trace?.finish('no-eligible-lessons');
        return [];
      }

      const recent = this.getRecentContext(agentName);
      if (!recent) {
        trace?.finish('no-recent-context');
        return [];
      }
      recentMessages = recent.text;
      opening = recent.opening;

      trace?.setContext(this.hashContext(recentMessages), recentMessages, recent.messageCount, recent.messageIds);
      // The turn's block, where this start sees the opening message it was
      // found for: an empty result of the pipeline's calls too, so a later
      // start of the turn in this process, such as a budget restart, doesn't
      // retrieve again. A use makes the agent's entry the newest, so the
      // bound drops the least recently used.
      const kept = this.turnBlocks.get(agentName);
      if (opening && kept && kept.key === opening.key) {
        this.turnBlocks.delete(agentName);
        this.turnBlocks.set(agentName, kept);
        trace?.recordCacheHit(kept.sourceTraceId, kept.lessonIds, kept.lessons, kept.injections);
        trace?.finish('cache-hit');
        return kept.injections;
      }
    } catch (error) {
      trace?.finish('error', error);
      throw error;
    }

    try {
      // Step 1: Flag concepts
      const concepts = await this.flagConcepts(recentMessages, trace);
      if (concepts === null || concepts.length === 0) {
        // A reply that didn't parse is a failed retrieval, which keeps
        // nothing, so the turn's next start asks again.
        if (concepts !== null) this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-concepts');
        return [];
      }

      // Step 2: Mechanical query (keyword matching)
      const candidates = this.queryCandidates(concepts, lessons);
      trace?.recordCandidates(concepts, candidates);
      if (candidates.length === 0) {
        this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-candidates');
        return [];
      }

      // Step 3: Validate relevance. A reply that doesn't parse gives the
      // top candidates unvalidated, as before; like a concept reply that
      // doesn't parse, it keeps nothing, so the turn's next start asks again.
      const { lessons: relevant, validated } = await this.validateRelevance(recentMessages, candidates, trace);
      trace?.recordRelevant(relevant);

      // Build injection
      const maxLessons = this.config.maxInjectedLessons ?? 5;
      const injected = relevant.slice(0, maxLessons);

      if (injected.length === 0) {
        this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-relevant-lessons');
        return [];
      }

      // The heading names the message the lessons were found for, so a block
      // agent-framework stores reads right as history, wherever it lands.
      const heading = opening?.excerpt !== undefined
        ? `## Retrieved Knowledge, for the message beginning "${opening.excerpt}"`
        : '## Retrieved Knowledge';
      const fitted = fitUnderCap(heading, injected, this.config.maxMessageTokens);
      if (fitted.lessons.length === 0) {
        if (validated) this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('too-large');
        return [];
      }
      const injections: ContextInjection[] = [{
        namespace: 'retrieval',
        // 'afterUser', NOT 'system': retrieval content changes with each
        // turn's message, so injecting it into the system prompt churns the
        // very front of the KV cache and invalidates the entire prefix every
        // turn. Tail injection keeps the stable prefix cached.
        position: 'afterUser',
        content: [{ type: 'text', text: fitted.text }],
      }];

      if (validated) this.keepTurnBlock(agentName, start, opening, injections, this.safeLessonSnapshots(fitted.lessons), trace?.id);
      trace?.recordInjection(fitted.lessons, injections);
      trace?.finish('injected');
      return injections;
    } catch (err) {
      // Fail open — don't block inference if retrieval fails. Nothing is
      // kept, so the turn's next start tries again.
      trace?.finish('error', err);
      console.error('RetrievalModule: retrieval failed:', err);
      return [];
    }
  }

  // =========================================================================
  // Pipeline Steps
  // =========================================================================

  /** Build OpenAI request parameters for configured retrieval reasoning effort. */
  private retrievalProviderParams(): Record<string, unknown> | undefined {
    const reasoning = this.config.retrievalReasoning;
    if (!reasoning) return undefined;
    return { reasoning: { effort: reasoning.effort } };
  }

  /**
   * Step 1: Use the configured retrieval model to identify concepts that might benefit from background knowledge.
   * Null when its reply isn't an array, bare or in a wrapper: a failed step,
   * not an answer of no concepts.
   */
  private async flagConcepts(
    recentContext: string,
    trace?: RetrievalTraceRun,
  ): Promise<string[] | null> {
    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';
    const providerParams = this.retrievalProviderParams();
    const input = `Recent conversation:\n${recentContext}`;

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: input }],
        },
      ],
      system: CONCEPT_FLAG_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
      ...(providerParams ? { providerParams } : {}),
    };

    trace?.startConceptExtraction(CONCEPT_FLAG_PROMPT, input);
    let response;
    try {
      response = await this.config.membrane.complete(request);
    } catch (error) {
      trace?.recordStageError('conceptExtraction', error);
      throw error;
    }
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const concepts = parsed.filter((value): value is string => typeof value === 'string');
        trace?.finishConceptExtraction(text, concepts, 'json', response.content);
        return concepts;
      }
      trace?.finishConceptExtraction(text, [], 'invalid', response.content);
    } catch {
      // Try to extract an array from a prose/markdown wrapper.
      const match = text.match(/\[([^\]]*)\]/);
      if (match) {
        try {
          const parsed = JSON.parse(`[${match[1]}]`);
          if (Array.isArray(parsed)) {
            const traceValues = parsed.filter((value): value is string => typeof value === 'string');
            trace?.finishConceptExtraction(text, traceValues, 'array-extraction', response.content);
            // Preserve the historical malformed-wrapper behavior exactly: mixed
            // arrays proceed to queryCandidates(), which then fails open rather
            // than silently becoming a different, partially valid concept set.
            return parsed as string[];
          }
        } catch { /* fall through */ }
      }
      trace?.finishConceptExtraction(text, [], 'invalid', response.content);
    }
    return null;
  }

  /**
   * Step 2: Mechanical keyword matching against lessons.
   */
  private queryCandidates(concepts: string[], lessons: Lesson[]): Lesson[] {
    const seen = new Set<string>();
    const candidates: Lesson[] = [];

    for (const concept of concepts) {
      const keywords = concept.toLowerCase().split(/\s+/);

      for (const lesson of lessons) {
        if (seen.has(lesson.id)) continue;

        const text = lesson.content.toLowerCase();
        const tags = lesson.tags.map(t => t.toLowerCase());

        // Match if any keyword appears in content or tags
        const matches = keywords.some(kw =>
          text.includes(kw) || tags.some(tag => tag.includes(kw))
        );

        if (matches) {
          seen.add(lesson.id);
          candidates.push(lesson);
        }
      }
    }

    // Sort by confidence
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, 20); // Cap at 20 candidates for validation
  }

  /**
   * Step 3: Use the configured retrieval model to validate which candidates are actually relevant.
   */
  private async validateRelevance(
    recentContext: string,
    candidates: Lesson[],
    trace?: RetrievalTraceRun,
  ): Promise<{ lessons: Lesson[]; validated: boolean }> {
    if (candidates.length <= 3) {
      // If only a few candidates, skip validation — they're probably all relevant.
      trace?.recordRelevanceSkipped('three-or-fewer-candidates');
      return { lessons: candidates, validated: true };
    }

    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';
    const providerParams = this.retrievalProviderParams();

    const candidateList = candidates.map(l =>
      `[${l.id}] (${l.confidence.toFixed(2)}) ${l.content}`
    ).join('\n');
    const input = `Current conversation:\n${recentContext}\n\nCandidate lessons:\n${candidateList}`;

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: input }],
        },
      ],
      system: RELEVANCE_VALIDATION_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
      ...(providerParams ? { providerParams } : {}),
    };

    trace?.startRelevance(RELEVANCE_VALIDATION_PROMPT, input);
    let response;
    try {
      response = await this.config.membrane.complete(request);
    } catch (error) {
      trace?.recordStageError('relevance', error);
      throw error;
    }
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const parsedIds = parsed.filter((value): value is string => typeof value === 'string');
        trace?.finishRelevance(text, parsedIds, 'json', response.content);
        const relevantIds = new Set(parsedIds);
        return { lessons: candidates.filter(l => relevantIds.has(l.id)), validated: true };
      }
    } catch {
      // Fall through to confidence-ordered fallback.
    }

    const fallback = candidates.slice(0, 5);
    trace?.finishRelevance(text, [], 'fallback', response.content);
    return { lessons: fallback, validated: false };
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Keep a turn's result for the agent's later starts that see the same
   *  opening message. A start whose opening message couldn't be read keeps
   *  nothing, so the agent's next start retrieves again. The result was
   *  found across the pipeline's model calls, and meanwhile a later start of
   *  the agent's can have begun: a newer turn's, or the same turn's after the
   *  framework's gather timeout left this one behind. That start's result is
   *  the one the framework has, so this one keeps nothing then
   *  (gatherContext). */
  private keepTurnBlock(
    agentName: string,
    start: number,
    opening: OpeningMessage | undefined,
    injections: ContextInjection[],
    lessons: Lesson[],
    sourceTraceId?: number,
  ): void {
    if (!opening || this.latestStarts.get(agentName) !== start) return;
    this.turnBlocks.delete(agentName);
    this.turnBlocks.set(agentName, {
      key: opening.key,
      injections,
      lessons,
      lessonIds: this.safeLessonIds(lessons),
      sourceTraceId,
    });
    while (this.turnBlocks.size > TURN_BLOCKS_MAX) {
      const oldest = this.turnBlocks.keys().next().value as string;
      this.turnBlocks.delete(oldest);
    }
  }

  private getRecentContext(agentName: string): RecentRetrievalContext | null {
    if (!this.ctx) return null;

    // Get the last few messages of the gathering agent's own window: a
    // resident's is the slot the residents share, a fork's or a subagent's
    // its own, so its lessons and its key come from the conversation it's
    // in. A subconscious's is its own store, its summaries and tool rounds,
    // which holds no message of anyone else's: its block is found from
    // those and kept, as any agent's is, while its entry is among the
    // TURN_BLOCKS_MAX most recently used (Agnes-1009, room-203 #196733).
    // A row marked `held: true` is a write the framework still
    // holds: it reaches the agent at a later boundary, not in the request
    // these lessons go into. A row marked `heldFromResidents` arrived in a
    // tuned-out channel, and no resident is shown it, nor is a stored row a
    // tune-out diverted (`metadata.tuneOut`), which agent-framework keeps
    // out of a resident's view while it stays in the slot. A stored injection
    // (stored-injection.ts) is no one's message, and a past lessons block
    // among them would have the concept step read its own earlier output. So
    // the window keeps to the stored rows the agent is shown, injections
    // left out.
    const { messages } = this.ctx.queryMessages({}, { forAgent: agentName });
    const shown = messages.filter(m =>
      m.held !== true && m.heldFromResidents !== true && !(m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut
      && storedInjectionMarkOf(m.metadata) === undefined);
    if (shown.length === 0) return null;

    // Take the last 10 of them for context.
    const recent = shown.slice(-10);
    const text = recent
      .map(m => {
        const messageText = m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        return `${m.participant}: ${messageText}`;
      })
      .join('\n\n');
    const messageIds = recent.flatMap(message => {
      try {
        const candidate = (message as unknown as { id?: unknown }).id;
        return typeof candidate === 'string' || typeof candidate === 'number'
          ? [String(candidate)]
          : [];
      } catch {
        // Trace-only metadata must never alter retrieval behavior.
        return [];
      }
    });

    return { text, messageCount: recent.length, messageIds, opening: openingMessageOf(shown, agentName) };
  }

  private safeLessonIds(lessons: Lesson[]): string[] {
    const ids: string[] = [];
    for (const lesson of lessons) {
      try {
        if (typeof lesson.id === 'string') ids.push(lesson.id);
      } catch {
        // Cache provenance is observability metadata; omit unreadable IDs.
      }
    }
    return ids;
  }

  private safeLessonSnapshots(lessons: Lesson[]): Lesson[] {
    const snapshots: Lesson[] = [];
    for (const item of lessons) {
      try {
        snapshots.push({
          id: item.id,
          content: item.content,
          confidence: item.confidence,
          tags: [...item.tags],
          evidence: [...item.evidence],
          created: item.created,
          updated: item.updated,
          deprecated: item.deprecated,
          ...(item.deprecationReason !== undefined
            ? { deprecationReason: item.deprecationReason }
            : {}),
        });
      } catch {
        // Trace-only lesson snapshots must not alter retrieval behavior.
      }
    }
    return snapshots;
  }

  private hashContext(text: string): string {
    // A hash of the window, for the trace's record of what retrieval read.
    // The turn's kept block is keyed on its opening message, not on this.
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const chr = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }
}
