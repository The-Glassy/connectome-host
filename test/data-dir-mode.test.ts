import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionManager } from '../src/session-manager.js';
import { saveState, writeRecipeOut } from '../scripts/evacuator.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'data-dir-mode-'));
  dirs.push(dir);
  return join(dir, 'data');
}

function underUmask022(fn: () => void): void {
  const umask = process.umask(0o022);
  try {
    fn();
  } finally {
    process.umask(umask);
  }
}

const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

describe('a data directory a script makes before any host runs', () => {
  test("SessionManager's first session makes the data directory and its sessions directory for their owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => new SessionManager(data).createSession('imported'));
    expect(modeOf(data)).toBe(0o700);
    expect(modeOf(join(data, 'sessions'))).toBe(0o700);
  });

  test("SessionManager's first save makes the data directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => new SessionManager(data).save({ version: 1, activeSessionId: '', sessions: {} }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's first saved state makes the data directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => saveState(data, { model: 'claude-opus-4-1' }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's recipe makes its directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => writeRecipeOut(join(data, 'evacuated-recipe.json'), { agent: { name: 'Claude' } }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's recipe file is created readable by its owner alone, and one already there keeps its mode", () => {
    const out = join(freshDataDir(), 'evacuated-recipe.json');
    underUmask022(() => writeRecipeOut(out, { agent: { name: 'Claude' } }));
    expect(modeOf(out)).toBe(0o600);
    chmodSync(out, 0o644);
    underUmask022(() => writeRecipeOut(out, { agent: { name: 'Claude' } }));
    expect(modeOf(out)).toBe(0o644);
  });

  test("the Codex importer makes its instance directory and the rollout's copy's directory for their owner alone", () => {
    const out = freshDataDir();
    const rollout = join(dirname(out), 'rollout-test.jsonl');
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }) + '\n');
    let run: ReturnType<typeof spawnSync> | undefined;
    underUmask022(() => {
      run = spawnSync('bun', [join(import.meta.dir, '..', 'scripts', 'import-codex-rollout.ts'), rollout, '--out', out], { encoding: 'utf-8', timeout: 50_000 });
    });
    if (run!.status !== 0) throw new Error(`the import exited ${run!.status}: ${run!.stderr}`);
    expect(modeOf(out)).toBe(0o700);
    expect(modeOf(join(out, 'source'))).toBe(0o700);
    expect(modeOf(join(out, 'data'))).toBe(0o700);
  }, 60_000);
});
