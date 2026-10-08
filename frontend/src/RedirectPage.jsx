import { useEffect, useRef, useState } from "react";
import "./dashboard.css";
import { API } from "./api.js";

const MESSAGES = {
  not_found: { icon: "🔍", title: "Link not found", text: "This short link doesn't exist. It may have been deleted or mistyped." },
  disabled: { icon: "⏸", title: "This link is turned off", text: "The owner has disabled this link." },
  expired: { icon: "⌛", title: "This link has expired", text: "This link passed its expiry date and no longer redirects." },
  limit_reached: { icon: "🚫", title: "This link is used up", text: "This link reached its maximum number of clicks." },
  error: { icon: "⚠", title: "Something went wrong", text: "We couldn't open this link. Please try again in a moment." },
};

/** Opens a short link (?r=CODE): redirects, asks for a password, or explains why it can't. */
export default function RedirectPage({ code }) {
  const [phase, setPhase] = useState("loading"); // loading | password | problem
  const [problem, setProblem] = useState("error");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const referrer = document.referrer || "";

  const resolve = async (secret) => {
    const query = referrer ? `?ref=${encodeURIComponent(referrer.slice(0, 500))}` : "";
    const response = await fetch(`${API}/resolve/${encodeURIComponent(code)}${query}`, secret === undefined
      ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: secret }) });
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    return { response, data };
  };

  useEffect(() => {
    // StrictMode runs effects twice in development; only count the click once.
    if (started.current) return;
    started.current = true;
    resolve().then(({ response, data }) => {
      if (response.ok) { window.location.replace(data.original_url); return; }
      if (data.code === "password_required") { setPhase("password"); return; }
      setProblem(MESSAGES[data.code] ? data.code : "error");
      setPhase("problem");
    }).catch(() => { setProblem("error"); setPhase("problem"); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlock = async (event) => {
    event.preventDefault();
    setBusy(true); setPasswordError("");
    try {
      const { response, data } = await resolve(password);
      if (response.ok) { window.location.replace(data.original_url); return; }
      if (data.code === "wrong_password") setPasswordError("That password isn't right. Please try again.");
      else if (MESSAGES[data.code]) { setProblem(data.code); setPhase("problem"); }
      else setPasswordError(data.detail || "Something went wrong. Please try again.");
    } catch {
      setPasswordError("Unable to reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const home = window.location.pathname || "/";

  if (phase === "loading") {
    return <main className="rpPage"><div className="rpCard" role="status"><span className="rpSpin" aria-hidden="true" /><p>Opening your link…</p></div></main>;
  }
  if (phase === "password") {
    return (
      <main className="rpPage">
        <form className="rpCard" onSubmit={unlock}>
          <div className="rpIcon" aria-hidden="true">🔒</div>
          <h1>This link is protected</h1>
          <p>Enter the password to continue.</p>
          <label htmlFor="rp-password" className="srOnly">Password</label>
          <input id="rp-password" type="password" value={password} onChange={event => { setPassword(event.target.value); setPasswordError(""); }}
            placeholder="Password" autoFocus required autoComplete="off" />
          {passwordError && <div className="rpError" role="alert">{passwordError}</div>}
          <button type="submit" className="rpButton" disabled={busy || !password}>{busy ? "Checking…" : "Open link"}</button>
        </form>
      </main>
    );
  }
  const message = MESSAGES[problem];
  return (
    <main className="rpPage">
      <div className="rpCard" role="alert">
        <div className="rpIcon" aria-hidden="true">{message.icon}</div>
        <h1>{message.title}</h1>
        <p>{message.text}</p>
        <a className="rpButton" href={home}>Go to LinkShortener</a>
      </div>
    </main>
  );
}
