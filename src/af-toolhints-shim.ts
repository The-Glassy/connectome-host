/**
 * TEMPORARY SHIM — REMOVE once @animalabs/agent-framework's McplServerConfig
 * declares `toolHints` (MCPL RFC-014, branch feat/mcpl-toolsets-host). Then
 * write `McplServerConfig['toolHints']` where this file's type is used, and
 * delete this file.
 *
 * Types only. The host hands each server's config to agent-framework as an
 * untyped object, so `toolHints` reaches it as written either way; an
 * agent-framework without RFC-014 ignores the field.
 */
import type { McplServerConfig } from '@animalabs/agent-framework';

/** McplServerConfig as agent-framework's RFC-014 release declares it: with
 *  `toolHints: true`, the host advertises `toolHints` to that server. */
export type McplServerConfigWithToolHints = McplServerConfig & { toolHints?: boolean };
