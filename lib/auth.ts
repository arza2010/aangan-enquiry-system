import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "./supabase/server";

/** Logged in AND listed in staff_users (RLS also enforces this on every read). */
export async function requireStaff() {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect("/login");
  const { data: staff } = await sb.from("staff_users").select("role, full_name").eq("user_id", data.user.id).maybeSingle();
  if (!staff) redirect("/login?error=not-staff");
  return { sb, user: data.user, staff };
}
