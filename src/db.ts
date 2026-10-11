import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import config from './config.ts';

type Param = string | number | boolean | null;
type Executor = postgres.Sql | postgres.TransactionSql;

/**
 * 连接池。
 * - prepare: false：兼容 Supabase 连接池（Supavisor）的 transaction 模式
 * - bigint（COUNT、BIGINT 列、毫秒时间戳）解析为 number：业务里的数值都远小于 2^53
 * - search_path：业务表位于独立 schema（默认 topup），SQL 中无需写 schema 前缀
 */
export const sql = postgres(config.databaseUrl, {
  debug: false,
  max: config.dbPoolSize,
  prepare: false,
  idle_timeout: 30,
  connect_timeout: 15,
  connection: { search_path: config.dbSchema, application_name: 'gpt-topup' },
  types: {
    bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
  },
  onnotice: () => {},
});

/**
 * 单条 SQL 超时：超过即向数据库发送取消请求，查询以错误结束。
 * 数据库变慢时快速失败，避免请求越堆越多、连接池被占满。
 * （Supabase 连接池不转发 statement_timeout 启动参数，所以在应用侧实现）
 */
const QUERY_TIMEOUT_MS = 10_000;

function helpers(ex: Executor) {
  const q = (text: string, params: Param[]) => {
    const pending = ex.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    const timer = setTimeout(() => void pending.cancel(), QUERY_TIMEOUT_MS);
    return pending.finally(() => clearTimeout(timer));
  };
  return {
    /** 查询单行 */
    async get<T>(text: string, ...params: Param[]): Promise<T | undefined> {
      const rows = await q(text, params);
      return rows[0] as T | undefined;
    },
    /** 查询多行 */
    async all<T>(text: string, ...params: Param[]): Promise<T[]> {
      return (await q(text, params)) as unknown as T[];
    },
    /** 执行写操作，返回影响行数 */
    async run(text: string, ...params: Param[]): Promise<{ changes: number }> {
      const r = await q(text, params);
      return { changes: r.count };
    },
  };
}

export type Db = ReturnType<typeof helpers>;

const root = helpers(sql);
export const { get, all, run } = root;

/**
 * 在事务中执行。回调里必须使用传入的 t 执行查询，才会落在同一事务内。
 * PostgreSQL 默认 READ COMMITTED：带条件的 UPDATE 在并发下会重新检查 WHERE，
 * 卡密分配另用 FOR UPDATE SKIP LOCKED，保证一张卡只会被一个订单锁定。
 */
export function tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
  return sql.begin((t) => fn(helpers(t))) as Promise<T>;
}

export const now = (): number => Date.now();

// ---------- 迁移 ----------

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

/** 按文件名顺序执行 migrations/*.sql 中尚未执行的迁移；用 advisory lock 防止多实例同时迁移 */
export async function migrate(): Promise<string[]> {
  const schema = config.dbSchema;
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (t) => {
    await t.unsafe(`SELECT pg_advisory_xact_lock(hashtext('gpt-topup-migrate:' || $1))`, [schema]);
    await t.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await t.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await t.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
    await t.unsafe(`ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY`);
    const done = new Set((await t.unsafe(`SELECT name FROM schema_migrations`)).map((r) => r.name as string));
    for (const f of files) {
      if (done.has(f)) continue;
      await t.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      await t.unsafe(`INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)`, [f, Date.now()]);
      applied.push(f);
    }
  });
  return applied;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
