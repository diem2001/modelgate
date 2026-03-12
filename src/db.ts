import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

let db: Database.Database | null = null;
let retentionDays = 14;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

const DATA_DIR = resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, 'modelgate.db');

export interface LogRecord {
  id?: number;
  timestamp: string;
  model: string;
  requested_model: string | null;
  backend: string;
  provider_hint: string | null;
  status: number;
  duration_ms: number;
  stream: boolean;
  turns: number;
  num_tools: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost: number | null;
  input_text: string;
  output_text: string;
  tool_calls: string; // JSON array
  request_body: string;
  response_body: string;
}

export function initDb(retention?: number): void {
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp          TEXT NOT NULL,
      model              TEXT NOT NULL,
      requested_model    TEXT,
      backend            TEXT NOT NULL,
      provider_hint      TEXT,
      status             INTEGER NOT NULL DEFAULT 0,
      duration_ms        INTEGER NOT NULL DEFAULT 0,
      stream             INTEGER NOT NULL DEFAULT 0,
      turns              INTEGER NOT NULL DEFAULT 0,
      num_tools          INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cached_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
      cost               REAL,
      input_text         TEXT NOT NULL DEFAULT '',
      output_text        TEXT NOT NULL DEFAULT '',
      tool_calls         TEXT NOT NULL DEFAULT '[]',
      request_body       TEXT NOT NULL DEFAULT '',
      response_body      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
    CREATE INDEX IF NOT EXISTS idx_requests_backend ON requests(backend);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  `);

  // Migrate: add requested_model column if missing
  const cols = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
  if (!cols.some(c => c.name === 'requested_model')) {
    db.exec('ALTER TABLE requests ADD COLUMN requested_model TEXT');
  }

  if (retention !== undefined) retentionDays = retention;
  runCleanup();
  // Run cleanup every hour
  cleanupTimer = setInterval(runCleanup, 60 * 60 * 1000);
}

// ── Insert ──────────────────────────────────────────

const INSERT_SQL = `
  INSERT INTO requests (
    timestamp, model, requested_model, backend, provider_hint, status, duration_ms, stream,
    turns, num_tools, input_tokens, output_tokens, cached_tokens,
    cache_write_tokens, reasoning_tokens, cost,
    input_text, output_text, tool_calls, request_body, response_body
  ) VALUES (
    @timestamp, @model, @requested_model, @backend, @provider_hint, @status, @duration_ms, @stream,
    @turns, @num_tools, @input_tokens, @output_tokens, @cached_tokens,
    @cache_write_tokens, @reasoning_tokens, @cost,
    @input_text, @output_text, @tool_calls, @request_body, @response_body
  )
`;

export function insertLog(record: Omit<LogRecord, 'id'>): number {
  if (!db) return 0;
  const stmt = db.prepare(INSERT_SQL);
  const result = stmt.run({
    ...record,
    stream: record.stream ? 1 : 0,
  });
  return result.lastInsertRowid as number;
}

// ── Query ──────────────────────────────────────────

export interface LogQuery {
  model?: string;
  backend?: string;
  status?: string; // '2xx', '4xx', '5xx'
  from?: string;
  to?: string;
  search?: string;
  offset?: number;
  limit?: number;
}

export function queryLogs(q: LogQuery): { logs: Omit<LogRecord, 'request_body' | 'response_body'>[]; total: number } {
  if (!db) return { logs: [], total: 0 };

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.model) {
    conditions.push('model = @model');
    params.model = q.model;
  }
  if (q.backend) {
    conditions.push('backend = @backend');
    params.backend = q.backend;
  }
  if (q.status === '2xx') {
    conditions.push('status >= 200 AND status < 300');
  } else if (q.status === '4xx') {
    conditions.push('status >= 400 AND status < 500');
  } else if (q.status === '5xx') {
    conditions.push('status >= 500');
  }
  if (q.from) {
    conditions.push('timestamp >= @from');
    params.from = q.from;
  }
  if (q.to) {
    conditions.push('timestamp <= @to');
    params.to = q.to;
  }
  if (q.search) {
    conditions.push('(input_text LIKE @search OR output_text LIKE @search)');
    params.search = `%${q.search}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM requests ${where}`);
  const total = (countStmt.get(params) as { cnt: number }).cnt;

  const dataStmt = db.prepare(`
    SELECT id, timestamp, model, requested_model, backend, provider_hint, status, duration_ms, stream,
           turns, num_tools, input_tokens, output_tokens, cached_tokens,
           cache_write_tokens, reasoning_tokens, cost,
           input_text, output_text, tool_calls
    FROM requests ${where}
    ORDER BY id DESC
    LIMIT @limit OFFSET @offset
  `);
  const logs = dataStmt.all({ ...params, limit, offset }) as Omit<LogRecord, 'request_body' | 'response_body'>[];

  return { logs, total };
}

export function getLogById(id: number): LogRecord | null {
  if (!db) return null;
  const stmt = db.prepare('SELECT * FROM requests WHERE id = ?');
  return (stmt.get(id) as LogRecord) ?? null;
}

// ── Stats ──────────────────────────────────────────

export interface LogStats {
  totalCount: number;
  dbSizeBytes: number;
  models: string[];
  backends: string[];
  retentionDays: number;
}

export function getLogStats(): LogStats {
  if (!db) return { totalCount: 0, dbSizeBytes: 0, models: [], backends: [], retentionDays };

  const count = (db.prepare('SELECT COUNT(*) as cnt FROM requests').get() as { cnt: number }).cnt;
  const size = (db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number }).size;
  const models = (db.prepare('SELECT DISTINCT model FROM requests ORDER BY model').all() as { model: string }[]).map(r => r.model);
  const backends = (db.prepare('SELECT DISTINCT backend FROM requests ORDER BY backend').all() as { backend: string }[]).map(r => r.backend);

  return { totalCount: count, dbSizeBytes: size, models, backends, retentionDays };
}

// ── Retention ──────────────────────────────────────

export function getRetentionDays(): number {
  return retentionDays;
}

export function setRetentionDays(days: number): void {
  retentionDays = days;
  runCleanup();
}

function runCleanup(): void {
  if (!db || retentionDays <= 0) return;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM requests WHERE timestamp < ?').run(cutoff);
}

// ── Purge ──────────────────────────────────────────

export function purgeLogs(before?: string): number {
  if (!db) return 0;
  if (before) {
    return db.prepare('DELETE FROM requests WHERE timestamp < ?').run(before).changes;
  }
  return db.prepare('DELETE FROM requests').run().changes;
}
