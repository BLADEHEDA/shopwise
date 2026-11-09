// Applies database upgrades (supabase/migrations/*.sql) automatically.
// Runs before every Vercel production build (see package.json "build").
//
//  - Needs DATABASE_URL (Supabase → Connect → "Session pooler" URI, with your
//    database password). Without it, the step is skipped with a warning.
//  - Each file runs once, in name order, inside a transaction, and is recorded
//    in public.shopwise_migrations. A failing upgrade stops the deploy, so the
//    live app and the database never get out of step.
//  - Databases set up by hand earlier (0001 pasted into the SQL editor) are
//    detected and adopted; the later files are safe to run again.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const env = process.env.VERCEL_ENV; // production | preview | development | undefined (local)

if (!url) {
  console.warn("[migrate] DATABASE_URL is not set: skipping database upgrades.");
  process.exit(0);
}
if (env && env !== "production" && !process.env.MIGRATE_ON_PREVIEW) {
  console.log(`[migrate] ${env} deployment: database upgrades only run for production.`);
  process.exit(0);
}

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const local = /localhost|127\.0\.0\.1|host=\//.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, statement_timeout: 120000 });

try {
  await client.connect();
  await client.query("select pg_advisory_lock(7277001)"); // one deploy at a time
  await client.query(`
    create table if not exists public.shopwise_migrations (name text primary key, applied_at timestamptz not null default now());
    alter table public.shopwise_migrations enable row level security;
    revoke all on public.shopwise_migrations from anon, authenticated;`);

  const applied = new Set((await client.query("select name from public.shopwise_migrations")).rows.map((r) => r.name));
  if (applied.size === 0) {
    const { rows } = await client.query("select to_regclass('public.businesses') is not null as has_schema");
    if (rows[0].has_schema && files[0]) {
      // set up by hand before this script existed: the first (non-repeatable) file is already there
      await client.query("insert into public.shopwise_migrations (name) values ($1) on conflict do nothing", [files[0]]);
      applied.add(files[0]);
      console.log(`[migrate] existing database detected: marked ${files[0]} as applied`);
    }
  }

  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) console.log(`[migrate] database is up to date (${files.length} upgrades applied)`);
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    process.stdout.write(`[migrate] applying ${f} … `);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into public.shopwise_migrations (name) values ($1)", [f]);
      await client.query("commit");
      console.log("done");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.log("FAILED");
      console.error(`[migrate] ${f}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
} catch (e) {
  console.error(`[migrate] could not connect to the database: ${e.message}`);
  console.error("[migrate] check DATABASE_URL in Vercel → Settings → Environment Variables (use the Session pooler URI).");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
