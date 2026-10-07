import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { staff, user } = await requireStaff();
  return (
    <>
      <div className="topbar">
        <div className="wrap">
          <span className="brand">Aangan Studio</span>
          <nav>
            <Link href="/queue">Review queue</Link>
            <Link href="/dashboard">Dashboard</Link>
          </nav>
          <span className="muted small">{staff.full_name ?? user.email} · {staff.role}</span>
          <form action={signOut}><button className="small">Sign out</button></form>
        </div>
      </div>
      <div className="wrap">{children}</div>
    </>
  );
}
