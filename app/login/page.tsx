import { signIn } from "./actions";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <h1>Aangan Studio</h1>
      <p className="muted">Enquiry desk · staff sign in</p>
      {error && (
        <p className="flash err">{error === "not-staff" ? "This account is not set up as staff. Ask an admin to add it." : "Email or password is not right."}</p>
      )}
      <form action={signIn}>
        <input type="email" name="email" placeholder="Email" autoComplete="email" required />
        <input type="password" name="password" placeholder="Password" autoComplete="current-password" required />
        <button className="primary">Sign in</button>
      </form>
    </main>
  );
}
