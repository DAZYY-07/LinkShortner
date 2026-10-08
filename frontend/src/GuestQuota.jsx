import "./dashboard.css";

/** Shows a guest how many free links are left, and a sign-in prompt once they are used up. */
export default function GuestQuota({ quota, onSignIn }) {
  if (!quota) return null;
  const { limit, used, remaining } = quota;

  if (remaining <= 0) {
    return (
      <div className="quotaBanner" role="status" id="guest-limit-banner">
        <div>
          <strong>You've used your {limit} free links</strong>
          <span>Sign in or create a free account to keep shortening, and to unlock aliases, expiry, analytics and more.</span>
        </div>
        <div className="quotaActions">
          <button type="button" className="btn btnBlue btnSm" onClick={() => onSignIn("login")}>Sign in</button>
          <button type="button" className="btn btnGhost btnSm" onClick={() => onSignIn("register")}>Create account</button>
        </div>
      </div>
    );
  }

  return (
    <div className="quotaBar" role="status" id="guest-quota">
      <span className="quotaPips" aria-hidden="true">
        {Array.from({ length: limit }, (_, index) => <i key={index} className={index < used ? "on" : ""} />)}
      </span>
      <span>
        {remaining} of {limit} free links left ·{" "}
        <button type="button" className="linkBtn" onClick={() => onSignIn("login")}>Sign in</button> for unlimited
      </span>
    </div>
  );
}
