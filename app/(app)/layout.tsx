import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { staff, email, readOnly } = await getViewer();
  return (
    <>
      <div className="topbar">
        <div className="wrap">
          <span className="brand">Aangan Studio</span>
          <nav>
            <Link href="/queue">Review queue</Link>
            <Link href="/dashboard">Dashboard</Link>
          </nav>
          {readOnly ? (
            <>
              <span className="muted small">Read-only demo view</span>
              <Link className="btn small" href="/login">Staff sign in</Link>
            </>
          ) : (
            <>
              <span className="muted small">{staff?.full_name ?? email} · {staff?.role}</span>
              <form action={signOut}><button className="small">Sign out</button></form>
            </>
          )}
        </div>
      </div>
      <div className="wrap">{children}</div>
    </>
  );
}
