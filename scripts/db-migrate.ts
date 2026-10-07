/**
 * Apply supabase/migrations/*.sql (in order) and supabase/seed.sql to YOUR Supabase database.
 *   npm run db:migrate
 * Needs SUPABASE_DB_URL in .env.local: Supabase > Project Settings > Database > Connection string > URI
 * (use the "Session pooler" one if the direct one fails, and put your database password in place of [YOUR-PASSWORD]).
 * Safe to re-run: applied migrations are recorded in a table and skipped. The seed (placeholder designers) runs once, only if
 * the designers table is empty.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const url = process.env.SUPABASE_DB_URL;
if (!url || url.includes("[YOUR-PASSWORD]")) {
  console.error("SUPABASE_DB_URL is missing (or still contains [YOUR-PASSWORD]). See the header of scripts/db-migrate.ts.");
  process.exit(1);
}

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query("create table if not exists public._app_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query("select name from public._app_migrations")).rows.map((r) => r.name as string));
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) { console.log(`skip   ${f}`); continue; }
    try {
      await db.query("begin");
      await db.query(readFileSync(join(dir, f), "utf8"));
      await db.query("insert into public._app_migrations(name) values ($1)", [f]);
      await db.query("commit");
      console.log(`applied ${f}`);
    } catch (e) {
      await db.query("rollback");
      throw new Error(`${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const { rows } = await db.query("select count(*)::int as n from public.designers");
  if (rows[0].n === 0) {
    await db.query(readFileSync(join(process.cwd(), "supabase", "seed.sql"), "utf8"));
    console.log("seeded placeholder designers");
  }
  const t = await db.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name in ('calls','leads','designers','bookings','notifications','cost_events','settings','staff_users')");
  console.log(`✓ done: ${t.rows[0].n}/8 app tables present`);
  await db.end();
})().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
