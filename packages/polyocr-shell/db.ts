/**
 * Main-process SQLite layer.
 *
 * One synchronous better-sqlite3 connection backs:
 *   - the `settings` table (JSON-encoded blobs keyed by string)
 *   - `sessions` (one row per UI invocation: single image, batch, screenshot)
 *   - `results` (one row per ProcessResult; FK on session_id)
 *
 * Inpainted ImageData does NOT live in the DB. It's written to
 * `{userData}/images/{session_id}/{idx}.png` so the DB stays small and
 * the renderer can lazy-load images from disk. `clearHistory()` drops
 * both tables AND the directory.
 *
 * # Why better-sqlite3 (sync) vs sqlite3 (async)
 *   The renderer never blocks on db work — the main process owns it,
 *   and SQLite operations are all sub-millisecond on the row volumes
 *   we deal with (tens of thousands of results max). Synchronous
 *   prepared statements are simpler to reason about, faster on small
 *   reads, and don't require us to thread a Promise discipline through
 *   every call.
 *
 * # WAL mode
 *   `journal_mode = WAL` lets concurrent readers proceed during writes.
 *   For a single-process desktop app this is mostly belt-and-suspenders
 *   — but the screenshot hotkey can fire while the user is mid-batch,
 *   and WAL guarantees the hotkey's session insert won't block on the
 *   batch's results inserts.
 *
 * # `index` is a reserved word
 *   The results table column is named `idx` even though `result.index`
 *   is the JS field name, because `index` is reserved by SQLite as a
 *   DDL keyword and quoting it everywhere is friction. The mapping
 *   happens in this file's helpers.
 */

import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Settings,
  SessionRecord,
  ResultRecord,
  SerializedProcessResult
} from './shared/types.js';
import { DEFAULT_SETTINGS } from './shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  source_path  TEXT,
  options_json TEXT,
  result_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS results (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  text        TEXT,
  language    TEXT,
  translation TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cached      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_results_session ON results(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
`;

export interface ShellDbConfig {
  /** Absolute path to `polyocr.db`. Typically `app.getPath('userData')/polyocr.db`. */
  dbPath: string;
  /** Absolute path to the inpainted-images directory. Typically `<userData>/images`. */
  imagesDir: string;
}

/**
 * Wraps the database connection + image-directory bookkeeping. One
 * instance per process; pass it to IPC handlers.
 */
export class ShellDb {
  private readonly db: Database.Database;
  private readonly imagesDir: string;

  constructor(config: ShellDbConfig) {
    this.imagesDir = config.imagesDir;
    mkdirSync(dirname(config.dbPath), { recursive: true });
    mkdirSync(config.imagesDir, { recursive: true });
    this.db = new Database(config.dbPath);
    // foreign_keys is OFF by default in SQLite — turn it on explicitly so
    // ON DELETE CASCADE on the results table actually fires.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // ── Settings ─────────────────────────────────────────────────────────

  /**
   * Load merged settings: rows from the `settings` table override
   * `DEFAULT_SETTINGS`. Missing rows fall back to defaults so fresh
   * installs work without seeding.
   */
  getSettings(): Settings {
    const rows = this.db.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM settings'
    ).all();
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value);
      } catch {
        // A corrupt row shouldn't take down the app — log and use the
        // default for that key. Surfaced via main's logger if attached.
        console.warn(`[shell/db] settings row "${row.key}" has invalid JSON; using default`);
      }
    }
    // Cast through `unknown` because `merged` started as Record<string,
    // unknown> for the JSON-parse-into-anything loop above; we know
    // structurally it's a Settings (defaults seeded the keys, parse may
    // overwrite values).
    return merged as unknown as Settings;
  }

  /**
   * Persist a partial settings update. Each top-level field is stored as
   * its own row (JSON-encoded) so we can roll out new fields without a
   * migration — old keys stay untouched, new keys insert on first use.
   */
  setSettings(partial: Partial<Settings>): void {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    const tx = this.db.transaction((entries: Array<[string, string]>) => {
      for (const [k, v] of entries) stmt.run(k, v);
    });
    tx(Object.entries(partial).map(([k, v]) => [k, JSON.stringify(v)]));
  }

  // ── Sessions + results ───────────────────────────────────────────────

  /**
   * Insert a new session row, returning the generated id. The id is
   * also the directory name under `imagesDir` for inpainted output —
   * so creating the session ahead of `process()` lets the IPC handler
   * write images directly to the right place.
   */
  createSession(input: {
    mode: SessionRecord['mode'];
    sourcePath: string | null;
    optionsJson: string;
  }): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO sessions (id, created_at, mode, source_path, options_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, Date.now(), input.mode, input.sourcePath, input.optionsJson);
    return id;
  }

  /**
   * Persist one result. If `result.inpaintedImage` is present and
   * `imageBytes` is supplied (the caller has already encoded it to PNG
   * bytes), write the image to `images/{sessionId}/{idx}.png` and
   * return the path. Otherwise return null.
   *
   * The `result_count` denormalization on the parent session is
   * incremented atomically.
   */
  insertResult(
    sessionId: string,
    result: SerializedProcessResult,
    imageBytes?: Uint8Array
  ): { resultId: string; imagePath: string | null } {
    const resultId = randomUUID();
    let imagePath: string | null = null;
    if (imageBytes && imageBytes.length > 0) {
      const dir = join(this.imagesDir, sessionId);
      mkdirSync(dir, { recursive: true });
      imagePath = join(dir, `${result.index}.png`);
      writeFileSync(imagePath, imageBytes);
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO results
         (id, session_id, idx, text, language, translation, duration_ms, cached)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        resultId,
        sessionId,
        result.index,
        result.text,
        result.language,
        result.translation,
        Math.round(result.durationMs),
        result.cached ? 1 : 0
      );
      this.db.prepare(
        `UPDATE sessions SET result_count = result_count + 1 WHERE id = ?`
      ).run(sessionId);
    });
    tx();
    return { resultId, imagePath };
  }

  /**
   * Most-recent first, capped at `limit`. Default 100 — the history
   * dropdown is for browsing recent work, not auditing months of usage.
   */
  listSessions(limit = 100): SessionRecord[] {
    return this.db.prepare<[number], {
      id: string;
      created_at: number;
      mode: string;
      source_path: string | null;
      options_json: string | null;
      result_count: number;
    }>(
      `SELECT id, created_at, mode, source_path, options_json, result_count
       FROM sessions ORDER BY created_at DESC LIMIT ?`
    ).all(limit).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      mode: row.mode as SessionRecord['mode'],
      sourcePath: row.source_path,
      optionsJson: row.options_json ?? '{}',
      resultCount: row.result_count
    }));
  }

  /** All results for a given session, ordered by `idx`. */
  listResults(sessionId: string): ResultRecord[] {
    return this.db.prepare<[string], {
      id: string;
      session_id: string;
      idx: number;
      text: string | null;
      language: string | null;
      translation: string | null;
      duration_ms: number;
      cached: number;
    }>(
      `SELECT id, session_id, idx, text, language, translation, duration_ms, cached
       FROM results WHERE session_id = ? ORDER BY idx ASC`
    ).all(sessionId).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      idx: row.idx,
      text: row.text,
      language: row.language,
      translation: row.translation,
      durationMs: row.duration_ms,
      cached: row.cached === 1
    }));
  }

  /**
   * Drop both tables and the inpainted-image directory. Used by the
   * Settings page "Clear scan history" button. Settings are NOT
   * touched — they live in their own table the user keeps.
   */
  clearHistory(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM results');
      this.db.exec('DELETE FROM sessions');
    })();
    if (existsSync(this.imagesDir)) {
      rmSync(this.imagesDir, { recursive: true, force: true });
      mkdirSync(this.imagesDir, { recursive: true });
    }
  }

  /** For graceful shutdown in `app.on('will-quit')`. */
  close(): void {
    this.db.close();
  }
}
