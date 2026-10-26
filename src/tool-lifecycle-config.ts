/**
 * MCPL tool lifecycle (RFC-007) and tool classes (RFC-008). agent-framework
 * denies a server's `toolLifecycle.observe` and `.inputs` paths by default;
 * stating a block is the grant.
 */

/** RFC-008 §4. Amended only by MCPL spec change, never per deployment. */
export const TOOL_CLASSES = [
  'comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control',
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(TOOL_CLASSES);

/**
 * Patterns in the RFC-007 §6.2 grammar. A tool not matched here, not
 * overridden by the recipe and not declared by its server is unclassed,
 * which agent-framework handles as the most restrictive class (RFC-008 §5.2).
 */
export const HOST_TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  // Presence: the typing/composition indicator policy.
  'activity--*': ['body'],
  // Routing and settings.
  'channel-mode--*': ['control'],
  'observers--*': ['control'],
  'time--*': ['control'],
  'mcpl-admin--*': ['control'],
  'subagent--*': ['control'],
  'identity--status': ['control'],
  'identity--accept_invite': ['control'],
  // Fleet: messages to and from other agents are other parties' words;
  // the rest is process control.
  'fleet--send': ['comms'],
  'fleet--relay': ['comms'],
  'fleet--peek': ['comms'],
  'fleet--*': ['control'],
  // The agent's own learned notes, recalled into context.
  'lessons--*': ['memory'],
};

export function isToolClass(value: unknown): value is ToolClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

const NARROWING_KEYS = new Set(['tools', 'classes', 'conversations']);
const LIFECYCLE_KEYS = new Set(['observe', 'inputs', 'maxInputBytes']);

/**
 * agent-framework reads a narrowing of the wrong shape as admitting nothing,
 * so a malformed block would turn an intended grant off without a word.
 */
export function validateToolLifecycle(value: unknown, where: string): void {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!LIFECYCLE_KEYS.has(key)) {
      throw new Error(`${where} has unknown field ${JSON.stringify(key)} (expected observe, inputs, maxInputBytes)`);
    }
  }
  for (const leaf of ['observe', 'inputs'] as const) {
    const n = value[leaf];
    if (n === undefined) continue;
    const at = `${where}.${leaf}`;
    if (!isPlainObject(n)) {
      throw new Error(
        `${at} must be a narrowing object ({} for no narrowing); omit it to leave the path denied`,
      );
    }
    for (const key of Object.keys(n)) {
      if (!NARROWING_KEYS.has(key)) {
        throw new Error(`${at} has unknown field ${JSON.stringify(key)} (expected tools, classes, conversations)`);
      }
    }
    if (n.tools !== undefined && !isNonEmptyStringArray(n.tools)) {
      throw new Error(`${at}.tools must be an array of non-empty patterns`);
    }
    if (n.conversations !== undefined && !isNonEmptyStringArray(n.conversations)) {
      throw new Error(`${at}.conversations must be an array of non-empty patterns`);
    }
    if (n.classes !== undefined && n.classes !== 'default') {
      if (!Array.isArray(n.classes) || n.classes.length === 0 || !n.classes.every(isToolClass)) {
        throw new Error(`${at}.classes must be "default" or a non-empty array of: ${TOOL_CLASSES.join(', ')}`);
      }
    }
  }
  const max = value.maxInputBytes;
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max > 0)) {
    throw new Error(`${where}.maxInputBytes must be a positive integer`);
  }
}

/** Validate a pattern → classes table (recipe `toolClassOverrides`). */
export function validateToolClassTable(value: unknown, where: string): void {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object of pattern → classes`);
  for (const [pattern, classes] of Object.entries(value)) {
    if (!pattern) throw new Error(`${where} has an empty pattern`);
    if (!Array.isArray(classes) || classes.length === 0 || !classes.every(isToolClass)) {
      throw new Error(
        `${where}[${JSON.stringify(pattern)}] must be a non-empty array of: ${TOOL_CLASSES.join(', ')}`,
      );
    }
  }
}

/**
 * The FrameworkConfig fields for tool classes: this host's module table
 * (as `hostToolClasses`, consulted before the framework's built-ins) and the
 * recipe's `toolClassOverrides`. Returned as a plain object for spreading.
 */
export function toolClassConfig(recipe: { toolClassOverrides?: Record<string, string[]> }): {
  hostToolClasses: Record<string, string[]>;
  toolClassOverrides?: Record<string, string[]>;
} {
  const hostToolClasses: Record<string, string[]> = {};
  for (const [pattern, classes] of Object.entries(HOST_TOOL_CLASSES)) hostToolClasses[pattern] = [...classes];
  return {
    hostToolClasses,
    ...(recipe.toolClassOverrides ? { toolClassOverrides: recipe.toolClassOverrides } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read side: the effective class of every tool, for operator surfaces
// ---------------------------------------------------------------------------

/** Where a tool's effective class came from (RFC-008 §5.1), as the framework
 *  reports it: the recipe's `toolClassOverrides`, the host's own table
 *  (HOST_TOOL_CLASSES or the framework's built-ins), the MCPL server's
 *  `_meta["mcpl/class"]`, or nowhere (unclassed). */
export type ToolClassSource = 'override' | 'host' | 'server' | 'none';

/** One row of AgentFramework.listToolClasses(). `class` is empty for an
 *  unclassed tool; `serverId` is set for tools an MCPL server provides. */
export interface ToolClassRow {
  tool: string;
  class: string[];
  source: ToolClassSource;
  serverId?: string;
}

export const TOOL_CLASS_SOURCE_LABELS: Readonly<Record<ToolClassSource, string>> = {
  override: 'operator override',
  host: 'host table',
  server: 'server _meta',
  none: 'unclassed',
};

/**
 * The framework's effective-class listing, sorted by tool name. With
 * `agentName`, exactly the tools that agent is shown; without, every tool
 * the framework offers to anyone. Returns null when the framework build has
 * no listing (one older than tool classes). An unknown agent throws the
 * framework's own error.
 */
export function readToolClasses(framework: unknown, agentName?: string): ToolClassRow[] | null {
  const fw = framework as { listToolClasses?: (agent?: string) => ToolClassRow[] } | null;
  if (typeof fw?.listToolClasses !== 'function') return null;
  const rows = agentName === undefined ? fw.listToolClasses() : fw.listToolClasses(agentName);
  return rows
    .map((r) => ({
      tool: r.tool,
      class: [...r.class],
      source: r.source,
      ...(r.serverId !== undefined ? { serverId: r.serverId } : {}),
    }))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/** Rows per source, every source present (zero when none). */
export function countToolClassSources(rows: readonly ToolClassRow[]): Record<ToolClassSource, number> {
  const counts: Record<ToolClassSource, number> = { override: 0, host: 0, server: 0, none: 0 };
  for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}

/**
 * Plain-text listing for line-oriented surfaces: a per-source summary, then
 * one aligned row per tool (`tool  classes  source`, with the providing
 * MCPL server in parentheses).
 */
export function formatToolClassRows(rows: readonly ToolClassRow[]): string[] {
  const counts = countToolClassSources(rows);
  const summary = (Object.keys(TOOL_CLASS_SOURCE_LABELS) as ToolClassSource[])
    .filter((source) => counts[source] > 0)
    .map((source) => `${counts[source]} ${TOOL_CLASS_SOURCE_LABELS[source]}`)
    .join(' · ');
  const classText = (r: ToolClassRow): string => (r.class.length > 0 ? r.class.join(',') : '-');
  const toolWidth = Math.min(48, Math.max(0, ...rows.map((r) => r.tool.length)));
  const classWidth = Math.max(0, ...rows.map((r) => classText(r).length));
  const lines = [summary];
  for (const r of rows) {
    const source = TOOL_CLASS_SOURCE_LABELS[r.source] ?? r.source;
    const server = r.serverId !== undefined ? ` (${r.serverId})` : '';
    lines.push(`${r.tool.padEnd(toolWidth)}  ${classText(r).padEnd(classWidth)}  ${source}${server}`);
  }
  return lines;
}
