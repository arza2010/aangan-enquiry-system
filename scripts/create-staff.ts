/**
 * Create a staff login (Supabase Auth user + a row in staff_users, which is what RLS checks).
 *   npm run staff:create -- you@example.com 'a-strong-password' "Your Name" admin
 * Roles: front_desk | designer | admin   (default front_desk). Safe to re-run: an existing user just gets the staff row.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createClient } from "@supabase/supabase-js";

const [email, password, name, role = "front_desk"] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run staff:create -- <email> <password> [full name] [front_desk|designer|admin]");
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

(async () => {
  let userId: string | undefined;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) userId = created.data.user.id;
  else {
    const list = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;
    if (!userId) throw new Error(`Could not create or find ${email}: ${created.error?.message}`);
    console.log("user already existed; password unchanged");
  }
  const { error } = await db.from("staff_users").upsert({ user_id: userId, role, full_name: name ?? null });
  if (error) throw new Error(error.message);
  console.log(`✓ ${email} can now sign in as ${role}`);
})().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
