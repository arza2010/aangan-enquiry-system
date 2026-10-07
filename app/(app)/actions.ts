"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildDeps } from "@/lib/deps";
import * as S from "@/lib/staff-actions";

/** Every action: check the user is staff, do the work with the service role, return to where they were with a message. */
async function run(fd: FormData, work: (db: ReturnType<typeof supabaseAdmin>, deps: Awaited<ReturnType<typeof buildDeps>>) => Promise<S.StaffResult>) {
  await requireStaff();
  const db = supabaseAdmin();
  const res = await work(db, await buildDeps(db)).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong" }));
  const back = String(fd.get("return") || "/queue");
  revalidatePath("/queue");
  revalidatePath("/dashboard");
  revalidatePath(back.split("?")[0]);
  redirect(`${back.split("?")[0]}?msg=${encodeURIComponent(res.message)}${res.ok ? "" : "&err=1"}`);
}
const id = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export const actSendToDesigner = async (fd: FormData) => run(fd, (db, d) => S.sendToDesigner(db, d, id(fd, "lead"), id(fd, "designer")));
export const actContacted = async (fd: FormData) => run(fd, (db, d) => S.markContacted(db, d, id(fd, "lead")));
export const actClose = async (fd: FormData) => run(fd, (db, d) => S.closeLead(db, d, id(fd, "lead")));
export const actWon = async (fd: FormData) => run(fd, (db, d) => S.setOutcome(db, d, id(fd, "lead"), "won"));
export const actLost = async (fd: FormData) => run(fd, (db, d) => S.setOutcome(db, d, id(fd, "lead"), "lost"));
export const actKeep = async (fd: FormData) => run(fd, (db) => S.keepBooking(db, id(fd, "booking")));
export const actCancelBooking = async (fd: FormData) => run(fd, (db, d) => S.cancelHeldBooking(db, d, id(fd, "booking")));
export const actConsultDone = async (fd: FormData) => run(fd, (db) => S.markConsult(db, id(fd, "booking"), "completed"));
export const actConsultNoShow = async (fd: FormData) => run(fd, (db) => S.markConsult(db, id(fd, "booking"), "no_show"));
