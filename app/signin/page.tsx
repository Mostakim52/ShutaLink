import { signIn } from "../../auth";
import { ShutaLinkMark } from "../../components/brand";
import { GitHubIcon } from "../../components/icons";

export const metadata = {
  title: "Sign in — ShutaLink",
};

export default function SignInPage() {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <span className="brand">
          <ShutaLinkMark className="brand-logo" />
          <span>SHUTALINK</span> <span className="brand-mark">///</span>
        </span>
        <h1 className="auth-title">Sign in to connect your repos</h1>
        <p className="auth-copy">
          Use your GitHub account to install the app. Nothing runs on your
          repositories until you install it.
        </p>
        <form
          className="auth-form"
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/onboarding" });
          }}
        >
          <button className="btn btn-primary" type="submit">
            <GitHubIcon className="btn-icon" />
            Continue with GitHub
          </button>
        </form>
        <p className="auth-footnote">
          GitHub sign-in only · we read issues you install it on, never your code
        </p>
      </div>
      <a className="auth-back" href="/">
        ← back to shutalink
      </a>
    </main>
  );
}
