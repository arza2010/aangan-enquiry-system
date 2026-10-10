import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "./supabase/server";
import { supabaseAdmin } from "./supabase/admin";

/** Pure decision, unit-tested: who sees the pages and with what powers. */
export function viewerMode(o: { loggedInStaff: boolean; publicDemo: boolean }): "staff" | "readonly" | "login" {
  return o.loggedInStaff ? "staff" : o.publicDemo ? "readonly" : "login";
}


/** Logged in AND listed in staff_users (RLS also enforces this on every read). */
export async function requireStaff() {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect("/login");
  const { data: staff } = await sb.from("staff_users").select("role, full_name").eq("user_id", data.user.id).maybeSingle();
  if (!staff) redirect("/login?error=not-staff");
  return { sb, user: data.user, staff };
}

/**
 * For pages. A signed-in staff member gets the normal client (RLS applies) and every action button.
 * With PUBLIC_DEMO=true, anyone else gets a READ-ONLY view (service-role reads, no action buttons); the server actions still
 * call requireStaff(), so a visitor cannot change anything even by crafting a request.
 */
export async function getViewer() {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  let staff: { role: string; full_name: string | null } | null = null;
  if (data.user) staff = (await sb.from("staff_users").select("role, full_name").eq("user_id", data.user.id).maybeSingle()).data;
  const mode = viewerMode({ loggedInStaff: !!staff, publicDemo: process.env.PUBLIC_DEMO === "true" });
  if (mode === "login") redirect(data.user ? "/login?error=not-staff" : "/login");
  return { sb: mode === "staff" ? sb : supabaseAdmin(), staff, readOnly: mode === "readonly", email: data.user?.email ?? null };
}
