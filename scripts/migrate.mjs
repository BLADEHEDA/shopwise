// Applies database upgrades (supabase/migrations/*.sql) automatically.
// Runs before every Vercel production build (see package.json "build").
//
//  - Needs DATABASE_URL (Supabase → Connect → "Session pooler" URI, with your
//    database password). Without it, the step is skipped with a warning.
//  - Each file runs once, in name order, inside a transaction, and is recorded
//    in public.shopwise_migrations. If one fails, it is rolled back, the error is
//    saved (the super admin sees it in the app) and the deploy still goes ahead:
//    the app keeps working on the older database version.
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
if (/:\[[^\]]*\]@/.test(url) || /YOUR-PASSWORD/i.test(url)) {
  console.warn("[migrate] ⚠️  DATABASE_URL still has [ ] brackets or YOUR-PASSWORD in it: put only your database password there, without brackets.");
}
if (env && env !== "production" && !process.env.MIGRATE_ON_PREVIEW) {
  console.log(`[migrate] ${env} deployment: database upgrades only run for production.`);
  process.exit(0);
}

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const local = /localhost|127\.0\.0\.1|host=\//.test(url);
// sslmode in the URL would override the ssl option below (and make pg demand a
// certificate chain Supabase's pooler doesn't provide), so drop it
const cleanUrl = url.trim().replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
const client = new pg.Client({ connectionString: cleanUrl, ssl: local ? false : { rejectUnauthorized: false }, statement_timeout: 120000, connectionTimeoutMillis: 20000 });

const safeHost = (() => { try { const u = new URL(cleanUrl); return `${u.username}@${u.hostname}:${u.port || 5432}`; } catch { return "(unreadable URL)"; } })();
const hint = (m) =>
  /password authentication failed/i.test(m) ? "The password in DATABASE_URL is wrong. Reset it in Supabase (Project Settings → Database) and paste the new address into Vercel."
  : /tenant or user not found/i.test(m) ? "The user name in DATABASE_URL is wrong. Copy the Session pooler address again from Supabase → Connect → Direct."
  : /ENOTFOUND|getaddrinfo/i.test(m) ? "The server name in DATABASE_URL is wrong (typo or extra spaces). Copy the Session pooler address again."
  : /ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(m) ? "Vercel can't reach that address. Use the Session pooler address (…pooler.supabase.com:5432), not the Direct connection one."
  : /Invalid URL|invalid connection/i.test(m) ? "DATABASE_URL isn't a valid address. Check there are no spaces and no [ ] brackets left around the password."
  : "";

try {
  await client.connect();
  await client.query("select pg_advisory_lock(7277001)"); // one deploy at a time
  await client.query(`
    create table if not exists public.shopwise_migrations (name text primary key, applied_at timestamptz not null default now());
    alter table public.shopwise_migrations enable row level security;
    revoke all on public.shopwise_migrations from anon, authenticated;
    create table if not exists public.shopwise_migration_log (id bigserial primary key, name text not null, error text not null, at timestamptz not null default now());
    alter table public.shopwise_migration_log enable row level security;
    revoke all on public.shopwise_migration_log from anon, authenticated;
    -- lets a super admin see why an upgrade failed, right in the app
    create or replace function public.shopwise_migration_status()
    returns table (applied int, last_failed text, last_error text, failed_at timestamptz)
    language plpgsql stable security definer set search_path = public as $f$
    begin
      if not exists (select 1 from memberships where user_id = auth.uid() and role = 'owner' and active) then return; end if;
      return query
        select (select count(*)::int from shopwise_migrations), l.name, l.error, l.at
        from (select 1) x left join lateral (
          select g.name, g.error, g.at from shopwise_migration_log g
          where not exists (select 1 from shopwise_migrations m where m.name = g.name)
          order by g.at desc limit 1) l on true;
    end $f$;
    grant execute on function public.shopwise_migration_status() to authenticated;`);

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
      console.error(`[migrate] ⚠️  ${f} failed: ${e.message}`);
      console.error("[migrate] ⚠️  The deploy continues on the previous database version. Send this message to your developer.");
      await client.query("insert into public.shopwise_migration_log (name, error) values ($1, $2)", [f, e.message]).catch(() => {});
      break;
    }
  }
} catch (e) {
  console.error(`[migrate] ⚠️  could not connect to the database (${safeHost}): ${e.message}`);
  console.error(`[migrate] ⚠️  ${hint(e.message) || "Check DATABASE_URL in Vercel → Settings → Environment Variables (Session pooler address)."}`);
  console.error("[migrate] ⚠️  The deploy continues without database upgrades.");
} finally {
  await client.end().catch(() => {});
}
