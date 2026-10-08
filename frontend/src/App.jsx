import { useState, useRef, useCallback, useEffect } from "react";

const API = import.meta.env.VITE_API_URL !== undefined && import.meta.env.VITE_API_URL !== ""
  ? import.meta.env.VITE_API_URL
  : (import.meta.env.DEV ? "" : "https://linkshortner-backend-uwgj.onrender.com");

/* ─── Helpers ─────────────────────────────────────────────── */
function getHistory() {
  try { return JSON.parse(localStorage.getItem("ls_history") || "[]"); }
  catch { return []; }
}
function saveHistory(arr) {
  localStorage.setItem("ls_history", JSON.stringify(arr.slice(0, 20)));
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function domainOf(u) {
  try { return new URL(u).hostname.replace("www.", ""); } catch { return u; }
}
function campaignUrlFor(value, campaign) {
  const destination = new URL(value);
  const parameters = [
    ["utm_source", campaign.source],
    ["utm_medium", campaign.medium],
    ["utm_campaign", campaign.name],
    ["utm_content", campaign.content],
    ["utm_term", campaign.term],
  ];
  for (const [key, parameter] of parameters) {
    const normalized = parameter.trim();
    if (normalized) destination.searchParams.set(key, normalized);
  }
  return destination.toString();
}
function qrUrl(text) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(text)}&bgcolor=050916&color=60d0ff&margin=12`;
}
function setHeroTextHover(element, active) {
  if (!active) {
    if (document.documentElement.dataset.theme === "light") {
      element.style.transform = "none";
      element.style.filter = "none";
      element.style.textShadow = "none";
      return;
    }
    element.style.removeProperty("transform");
    element.style.removeProperty("filter");
    element.style.removeProperty("text-shadow");
    return;
  }

  const lightTheme = document.documentElement.dataset.theme === "light";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (lightTheme) {
    element.style.transform = reducedMotion
      ? "none"
      : "perspective(700px) rotateX(0deg) translateY(-3px) scale(1.015)";
    element.style.filter = "brightness(1.06)";
    element.style.textShadow = "0 1px 0 #d5d8dd, 0 2px 0 #aeb4bd, 0 4px 0 #848c98, 0 7px 14px rgba(47,55,67,.2)";
    return;
  }
  element.style.transform = reducedMotion
    ? "perspective(700px) rotateX(3deg)"
    : "perspective(700px) rotateX(0deg) translateY(-5px) scale(1.025)";
  element.style.filter = "brightness(1.16)";
  element.style.textShadow = "0 1px 0 #58a8e4, 0 2px 0 #347fbd, 0 4px 0 #205e99, 0 6px 0 rgba(16,44,78,.72), 0 13px 24px rgba(35,143,255,.42)";
}
async function downloadQr(text) {
  // The QR image is cross-origin, so the <a download> attribute is ignored; fetch it as a blob instead.
  try {
    const response = await fetch(qrUrl(text));
    if (!response.ok) throw new Error("QR download failed");
    const href = URL.createObjectURL(await response.blob());
    Object.assign(document.createElement("a"), { href, download: "qr.png" }).click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch {
    window.open(qrUrl(text), "_blank", "noopener");
  }
}
function requestHeaders(token, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/* ─── Particle Canvas ─────────────────────────────────────── */
function ParticleCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let W = 0, H = 0, pts = [], raf = 0;
    const particle = () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.4 + 0.3,
      dx: (Math.random() - 0.5) * 0.28, dy: (Math.random() - 0.5) * 0.28,
      a: Math.random() * 0.5 + 0.1,
      hue: [210, 240, 270][Math.floor(Math.random() * 3)],
    });
    const frame = (move) => {
      ctx.clearRect(0, 0, W, H);
      pts.forEach(p => {
        if (move) { p.x = (p.x + p.dx + W) % W; p.y = (p.y + p.dy + H) % H; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},100%,78%,${p.a})`; ctx.fill();
      });
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y, d = Math.hypot(dx, dy);
        if (d < 120) {
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(80,180,255,${0.07 * (1 - d / 120)})`; ctx.lineWidth = 0.6; ctx.stroke();
        }
      }
    };
    const loop = () => { frame(true); raf = requestAnimationFrame(loop); };
    const start = () => {
      cancelAnimationFrame(raf);
      // Reduced motion: one still frame instead of a constant animation.
      if (motionQuery.matches) frame(false); else loop();
    };
    const resize = () => {
      // Draw at device resolution (capped at 2x) so dots stay sharp on high-DPI screens.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Scale the particle count with screen area: ~24 on phones, up to 90 on desktops.
      // Only reseed when the count changes, so a mobile address bar showing/hiding doesn't reshuffle them.
      const count = Math.round(Math.min(90, Math.max(24, (W * H) / 16000)));
      if (count !== pts.length) pts = Array.from({ length: count }, particle);
      if (motionQuery.matches) frame(false);
    };
    resize();
    start();
    window.addEventListener("resize", resize);
    motionQuery.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      motionQuery.removeEventListener("change", start);
    };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
}

/* ─── 3-D Hero Card ───────────────────────────────────────── */
function HeroCard() {
  const wrap = useRef(null);
  const card = useRef(null);
  const onMove = useCallback((e) => {
    if (!card.current) return;
    const r = card.current.getBoundingClientRect();
    const rx = (-(e.clientY - r.top - r.height / 2) / (r.height / 2)) * 16;
    const ry = ((e.clientX - r.left - r.width / 2) / (r.width / 2)) * 16;
    card.current.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale3d(1.05,1.05,1.05)`;
  }, []);
  const onLeave = useCallback(() => {
    if (card.current) card.current.style.transform = "perspective(900px) rotateX(0) rotateY(0) scale3d(1,1,1)";
  }, []);
  return (
    <div ref={wrap} className="hcWrap" onMouseMove={onMove} onMouseLeave={onLeave}>
      <div ref={card} className="hc">
        <div className="hcSpin" />
        <div className="hcBody">
          <div className="hcEmoji">🔗</div>
          <div className="hcBars">
            <div className="hcBar" style={{ width: "75%" }} />
            <div className="hcBar" style={{ width: "50%", animationDelay: ".25s" }} />
            <div className="hcBar" style={{ width: "65%", animationDelay: ".5s" }} />
          </div>
          <div className="hcTag">SHORT · SHARE</div>
          <div className="hcArrow">↗</div>
        </div>
        <div className="hcBlob b1" />
        <div className="hcBlob b2" />
        <div className="hcGlare" />
      </div>
    </div>
  );
}

/* ─── Single shortener ────────────────────────────────────── */
function Single({ onNew, token }) {
  const [url, setUrl] = useState(""); const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false); const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(""); const [qr, setQr] = useState(false);
  const [campaign, setCampaign] = useState({ source: "", medium: "", name: "", content: "", term: "" });
  const submit = async (e) => {
    e.preventDefault(); const t = url.trim();
    if (!t) { setErr("Please enter a URL."); return; }
    if (!/^https?:\/\//i.test(t)) { setErr("URL must start with http:// or https://"); return; }
    setLoading(true); setErr(""); setRes(null); setCopied(false); setQr(false);
    try {
      const destination = campaignUrlFor(t, campaign);
      const r = await fetch(`${API}/shorten`, { method: "POST", headers: requestHeaders(token, true), body: JSON.stringify({ url: destination }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Failed");
      const entry = { original: destination, short: d.short_url, code: d.short_code, ts: Date.now() };
      setRes(entry); onNew(entry);
    } catch (e2) { setErr(e2.message); }
    finally { setLoading(false); }
  };
  const updateCampaign = (field) => (event) => {
    const value = event.target.value;
    setCampaign(current => ({ ...current, [field]: value }));
  };
  const copy = async () => { await navigator.clipboard.writeText(res.short); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div className="card tilt3d">
      <div className="cardLabel">Single URL</div>
      <form className="inputRow" onSubmit={submit}>
        <div className="inputWrap">
          <span className="inputIcon">🔗</span>
          <input id="single-url-input" type="url" value={url} onChange={e => { setUrl(e.target.value); setErr(""); }} placeholder="Paste your long URL here…" autoComplete="off" />
        </div>
        <button type="submit" className="btn btnPrimary" disabled={loading} id="single-shorten-btn">
          {loading ? <><span className="spin" /> <span role="status">Shortening…</span></> : <><span>Shorten</span><span className="arr">↗</span></>}
        </button>
        <details className="campaignPanel">
          <summary>Campaign tracking <span>Optional UTM tags</span></summary>
          <p className="campaignHelp">Add standard UTM parameters to measure visits from this campaign in your analytics tools.</p>
          <div className="campaignFields">
            <label>Source<input value={campaign.source} onChange={updateCampaign("source")} placeholder="newsletter" autoComplete="off" /></label>
            <label>Medium<input value={campaign.medium} onChange={updateCampaign("medium")} placeholder="email" autoComplete="off" /></label>
            <label>Campaign<input value={campaign.name} onChange={updateCampaign("name")} placeholder="summer-launch" autoComplete="off" /></label>
            <label>Content<input value={campaign.content} onChange={updateCampaign("content")} placeholder="header-link" autoComplete="off" /></label>
            <label>Term<input value={campaign.term} onChange={updateCampaign("term")} placeholder="optional keyword" autoComplete="off" /></label>
          </div>
        </details>
      </form>
      <p className="hint">Each account or guest network can shorten the same URL up to 5 times.</p>
      {err && <div className="errBox" role="alert">⚠ {err}</div>}
      {res && (
        <div className="resultBox" id="single-result">
          <div className="rbTop"><span className="rbOk">✓ Link created!</span><button className="rbX" onClick={() => { setRes(null); setUrl(""); setQr(false); }}>×</button></div>
          <div className="rbRow">
            <a href={res.short} className="rbLink" target="_blank" rel="noopener noreferrer">{res.short}</a>
            <button className={`btn btnSm ${copied ? "btnGreen" : "btnGhost"}`} onClick={copy} id="single-copy-btn">{copied ? "✓ Copied" : "Copy"}</button>
            <a href={res.short} className="btn btnSm btnBlue" target="_blank" rel="noopener noreferrer" id="single-open-btn">Open ↗</a>
            <button className={`btn btnSm ${qr ? "btnActive" : "btnGhost"}`} onClick={() => setQr(v => !v)} id="single-qr-btn">QR</button>
          </div>
          <p className="rbSrc">Redirects to {domainOf(res.original)}</p>
          {qr && <div className="qrBox"><img src={qrUrl(res.short)} alt="QR Code" className="qrImg" /><a href={qrUrl(res.short)} download="qr.png" className="qrDl" onClick={event => { event.preventDefault(); downloadQr(res.short); }}>⤓ Download QR</a></div>}
        </div>
      )}
    </div>
  );
}

/* ─── Bulk shortener ──────────────────────────────────────── */
function Bulk({ onNew, token }) {
  const [text, setText] = useState(""); const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false); const [prog, setProg] = useState(0);
  const [copiedIdx, setCopiedIdx] = useState(null); const [err, setErr] = useState("");
  const [qrIdx, setQrIdx] = useState(null);
  const parse = (s) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  const submit = async () => {
    const urls = parse(text);
    if (!urls.length) { setErr("Paste at least one URL."); return; }
    if (urls.length > 20) { setErr("Max 20 URLs at once."); return; }
    const bad = urls.filter(u => !/^https?:\/\//i.test(u));
    if (bad.length) { setErr(`Invalid: ${bad.slice(0, 2).join(", ")}`); return; }
    setLoading(true); setErr(""); setResults([]); setProg(0);
    const out = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(`${API}/shorten`, { method: "POST", headers: requestHeaders(token, true), body: JSON.stringify({ url: urls[i] }) });
        const d = await r.json();
        const e = r.ok ? { original: urls[i], short: d.short_url, code: d.short_code, ts: Date.now(), ok: true } : { original: urls[i], error: d.detail || "Failed", ok: false };
        out.push(e); if (e.ok) onNew(e);
      } catch { out.push({ original: urls[i], error: "Network error", ok: false }); }
      setProg(Math.round(((i + 1) / urls.length) * 100)); setResults([...out]);
    }
    setLoading(false);
  };
  const copyOne = async (i) => { await navigator.clipboard.writeText(results[i].short); setCopiedIdx(i); setTimeout(() => setCopiedIdx(null), 1800); };
  const copyAll = () => navigator.clipboard.writeText(results.filter(r => r.ok).map(r => `${r.original} → ${r.short}`).join("\n"));
  const csv = () => {
    const cell = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = ["Original,Short,Status", ...results.map(r => [r.original, r.ok ? r.short : "", r.ok ? "OK" : r.error].map(cell).join(","))];
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })), download: "links.csv" }); a.click();
  };
  const cnt = parse(text).length;
  return (
    <div className="card tilt3d">
      <div className="cardLabel" style={{ color: "#b78bfa" }}>Bulk URLs <span className="cardTag">up to 20</span></div>
      <div className="taWrap">
        <textarea id="bulk-url-textarea" value={text} onChange={e => { setText(e.target.value); setErr(""); }}
          placeholder={"One URL per line or comma-separated:\nhttps://example.com/very/long/url\nhttps://another.site/path?q=123"} rows={5} />
        <div className="taMeta">
          <span>{cnt > 0 ? `${cnt} URL${cnt > 1 ? "s" : ""} detected` : "No URLs yet"}</span>
          <button className="ghostBtn" onClick={() => { setText(""); setResults([]); setErr(""); }} disabled={!text && !results.length}>Clear</button>
        </div>
      </div>
      {err && <div className="errBox" role="alert">⚠ {err}</div>}
      {loading && <div className="progWrap"><div className="progBar"><div className="progFill" style={{ width: prog + "%" }} /></div><span className="progLbl">{prog}%</span></div>}
      <div className="bulkBtns">
        <button className="btn btnPrimary" onClick={submit} disabled={loading || !text.trim()} id="bulk-shorten-btn">
          {loading ? <><span className="spin" /> Processing…</> : <><span>Shorten All</span><span className="arr">↗</span></>}
        </button>
        {results.length > 0 && <><button className="btn btnGhost" onClick={copyAll} id="bulk-copy-all-btn">Copy All</button><button className="btn btnGhost" onClick={csv} id="bulk-export-btn">Export CSV ⤓</button></>}
      </div>
      {results.length > 0 && (
        <div className="bulkList">
          <div className="bulkListHdr">{results.filter(r => r.ok).length}/{results.length} shortened</div>
          {results.map((r, i) => (
            <div key={i} className={`bulkRow ${r.ok ? "bulkOk" : "bulkErr"}`} id={`bulk-result-${i}`}>
              <span className="brDomain" title={`Redirects to ${r.original}`}>Redirects to {domainOf(r.original)}</span>
              {r.ok ? <>
                <a href={r.short} className="brShort" target="_blank" rel="noopener noreferrer">{r.short}</a>
                <button className={`btn btnSm ${copiedIdx === i ? "btnGreen" : "btnGhost"}`} onClick={() => copyOne(i)} id={`bulk-copy-${i}`}>{copiedIdx === i ? "✓" : "Copy"}</button>
                <button className={`btn btnSm ${qrIdx === i ? "btnActive" : "btnGhost"}`} onClick={() => setQrIdx(qrIdx === i ? null : i)} id={`bulk-qr-${i}`}>QR</button>
              </> : <span className="brErr">{r.error}</span>}
              {r.ok && qrIdx === i && <div className="qrBox qrInline"><img src={qrUrl(r.short)} alt="QR" className="qrImg" /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── History ─────────────────────────────────────────────── */
function History({ history, onClear, canClear, token }) {
  const [ci, setCi] = useState(null);
  // Accounts can have up to 100 links; show them in pages so the page doesn't grow endlessly.
  const [visibleCount, setVisibleCount] = useState(10);
  const [analyticsCode, setAnalyticsCode] = useState("");
  const [analyticsByCode, setAnalyticsByCode] = useState({});
  const [analyticsLoading, setAnalyticsLoading] = useState("");
  const [analyticsErrors, setAnalyticsErrors] = useState({});
  const copy = async (u, i) => { await navigator.clipboard.writeText(u); setCi(i); setTimeout(() => setCi(null), 1600); };
  const toggleAnalytics = async (shortCode) => {
    if (analyticsCode === shortCode) {
      setAnalyticsCode("");
      return;
    }
    setAnalyticsCode(shortCode);
    if (analyticsByCode[shortCode] || analyticsLoading === shortCode) return;

    setAnalyticsLoading(shortCode);
    setAnalyticsErrors(current => ({ ...current, [shortCode]: "" }));
    try {
      const response = await fetch(`${API}/my-links/${encodeURIComponent(shortCode)}/analytics`, {
        headers: requestHeaders(token),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Unable to load link analytics.");
      setAnalyticsByCode(current => ({ ...current, [shortCode]: data }));
    } catch (error) {
      setAnalyticsErrors(current => ({
        ...current,
        [shortCode]: error.message || "Unable to load link analytics.",
      }));
    } finally {
      setAnalyticsLoading("");
    }
  };
  const maxDailyClicks = (data) => Math.max(1, ...data.clicks_by_day.map(day => day.clicks));
  return (
    <section className="histSec" id="history">
      <div className="histHdr">
        <h2 className="histTitle">Recent Links</h2>
        {history.length > 0 && canClear && <button className="ghostBtn red" onClick={onClear}>Clear all</button>}
      </div>
      {history.length > 0 && !token && <p className="analyticsMessage">Sign in to view click analytics for links in your account.</p>}
      {history.length === 0
        ? <p className="histEmpty">Your shortened links will appear here.</p>
        : history.slice(0, visibleCount).map((h, i) => (
          <div className="histEntry" key={h.code || h.short || i}>
            <div className="histRow">
              <div className="histLeft"><div className="histDomain">Redirects to {domainOf(h.original)}</div><div className="histTime">{fmtDate(h.ts)}</div></div>
              <a href={h.short} className="histCode" target="_blank" rel="noopener noreferrer">{h.short}</a>
              {token && <button className="btn btnSm btnGhost" onClick={() => toggleAnalytics(h.code)} aria-expanded={analyticsCode === h.code}>
                {analyticsLoading === h.code ? "Loading…" : analyticsCode === h.code ? "Hide stats" : "Analytics"}
              </button>}
              <button className={`btn btnSm ${ci === i ? "btnGreen" : "btnGhost"}`} onClick={() => copy(h.short, i)}>{ci === i ? "✓" : "Copy"}</button>
            </div>
            {analyticsCode === h.code && (
              <div className="linkAnalytics" aria-label={`Click analytics for ${h.short}`}>
                {analyticsErrors[h.code]
                  ? <p className="analyticsMessage" role="alert">{analyticsErrors[h.code]}</p>
                  : analyticsByCode[h.code] && (
                    <>
                      <div className="linkAnalyticsTop">
                        <strong>{analyticsByCode[h.code].total_clicks.toLocaleString()} total clicks</strong>
                        <span>Last 7 days</span>
                      </div>
                      <div className="linkTrafficChart" role="img" aria-label="Daily clicks over the last 7 days">
                        {analyticsByCode[h.code].clicks_by_day.map(day => (
                          <div className="linkTrafficDay" key={day.date} title={`${day.date}: ${day.clicks} clicks`}>
                            <span className="linkTrafficCount">{day.clicks}</span>
                            <div className="linkTrafficTrack">
                              <span style={{ height: `${Math.max(5, (day.clicks / maxDailyClicks(analyticsByCode[h.code])) * 100)}%` }} />
                            </div>
                            <span className="linkTrafficLabel">{new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                {analyticsLoading === h.code && <p className="analyticsMessage" role="status">Loading click analytics…</p>}
              </div>
            )}
          </div>
        ))}
      {history.length > visibleCount && (
        <button className="btn btnGhost histMore" type="button" onClick={() => setVisibleCount(count => count + 10)}>
          Show more ({history.length - visibleCount} more)
        </button>
      )}
    </section>
  );
}

function StatsPanel({ stats, error }) {
  const days = stats?.clicks_by_day || [];
  const maxDailyClicks = Math.max(1, ...days.map(day => day.clicks));
  const topLinks = stats?.top_links || [];
  const maxLinkClicks = Math.max(1, ...topLinks.map(link => link.clicks));

  return (
    <section className="analytics" aria-labelledby="analytics-title">
      <div className="analyticsHeader">
        <div>
          <div className="sectTag analyticsTag">LIVE OVERVIEW</div>
          <h2 className="analyticsTitle" id="analytics-title">Your links in motion</h2>
        </div>
        <span className="liveBadge"><span /> Live stats</span>
      </div>
      {error && <p className="analyticsMessage" role="status">{error}</p>}
      <div className="analyticsGrid">
        <article className="analyticsCard analyticsClicks">
          <div className="analyticsCardTop"><span>Total clicks</span><span className="analyticsIcon">↗</span></div>
          <strong className="analyticsNumber">{stats ? stats.total_clicks.toLocaleString() : "—"}</strong>
          <span className="analyticsFoot">Across all shortened links</span>
          <div className="sparkline" aria-hidden="true">
            {days.map((day, index) => (
              <span
                key={day.date}
                title={`${day.clicks} clicks`}
                style={{ height: `${Math.max(8, (day.clicks / maxDailyClicks) * 100)}%`, animationDelay: `${index * 55}ms` }}
              />
            ))}
          </div>
        </article>
        <article className="analyticsCard">
          <div className="analyticsCardTop"><span>Community</span><span className="analyticsIcon">◎</span></div>
          <strong className="analyticsNumber">{stats ? stats.total_users.toLocaleString() : "—"}</strong>
          <span className="analyticsFoot">Registered users</span>
          <div className="communityVisual" aria-hidden="true">
            <i /><i /><i /><i /><i /><i /><i />
          </div>
        </article>
        <article className="analyticsCard">
          <div className="analyticsCardTop"><span>Links created</span><span className="analyticsIcon">⌁</span></div>
          <strong className="analyticsNumber">{stats ? stats.total_links.toLocaleString() : "—"}</strong>
          <span className="analyticsFoot">Ready to share</span>
          <div className="linkVisual" aria-hidden="true"><span /><span /><span /><span /><span /></div>
        </article>
        <article className="analyticsCard trafficCard">
          <div className="analyticsCardTop"><span>Click activity</span><span className="analyticsPeriod">LAST 7 DAYS</span></div>
          <div className="trafficChart" role="img" aria-label="Daily short-link clicks during the last 7 days">
            {days.map(day => (
              <div className="trafficDay" key={day.date} title={`${day.clicks} clicks`}>
                <span className="trafficCount">{day.clicks || ""}</span>
                <div className="trafficTrack">
                  <span className="trafficBar" style={{ height: `${Math.max(day.clicks ? 10 : 3, (day.clicks / maxDailyClicks) * 100)}%` }} />
                </div>
                <span className="trafficLabel">{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
              </div>
            ))}
          </div>
        </article>
        <article className="analyticsCard topLinksCard">
          <div className="analyticsCardTop"><span>Top links</span><span className="analyticsPeriod">BY CLICKS</span></div>
          {topLinks.length === 0
            ? <p className="analyticsMessage">Your links’ click activity will show up here.</p>
            : <div className="topLinksList">
              {topLinks.map(link => (
                <div className="topLinkItem" key={link.short_code}>
                  <div className="topLinkLabels">
                    <span title={link.original_url}>{domainOf(link.original_url)}</span>
                    <strong>{link.clicks.toLocaleString()}</strong>
                  </div>
                  <div className="topLinkTrack">
                    <span style={{ width: `${Math.max(4, (link.clicks / maxLinkClicks) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>}
        </article>
      </div>
    </section>
  );
}

const AUTH_COPY = {
  login: { title: "Welcome back", intro: "Save your links and access them from any device. Email verification is required.", submit: "Sign in" },
  register: { title: "Create your account", intro: "Save your links and access them from any device. Email verification is required.", submit: "Create account" },
  verification: { title: "Verify your email", intro: "Check your inbox and click the verification link before signing in.", submit: "Resend verification link" },
  forgot: { title: "Reset your password", intro: "Enter your account email and we'll send you a link to choose a new password.", submit: "Send reset link" },
  reset: { title: "Choose a new password", intro: "Pick a new password for your account. You'll be signed out on other devices.", submit: "Save new password" },
};

function AuthDialog({ onClose, onAuthenticated, initialNotice, initialMode = "login", resetToken = "" }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initialNotice || "");
  const needsEmail = mode !== "reset";
  const needsPassword = mode === "login" || mode === "register" || mode === "reset";
  const needsConfirm = mode === "register" || mode === "reset";

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setError("");
    setNotice("");
  };

  const submit = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (needsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if (needsConfirm && password !== confirmPassword) {
      setError("Passwords don't match. Type the same password in both fields.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const endpoint = {
        login: "login",
        register: "register",
        verification: "resend-verification",
        forgot: "forgot-password",
        reset: "reset-password",
      }[mode];
      const payload = mode === "reset"
        ? { token: resetToken, password }
        : needsPassword ? { email: normalizedEmail, password } : { email: normalizedEmail };
      const response = await fetch(`${API}/auth/${endpoint}`, {
        method: "POST",
        headers: requestHeaders(null, true),
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = Array.isArray(data.detail)
          ? data.detail.map(item => item.msg).join(" ")
          : data.detail;
        if (response.status === 409 && mode === "register") {
          switchMode("verification");
          setNotice("An account already exists for this email. Request a verification link, or sign in if it is already verified.");
          return;
        }
        if (response.status === 403) {
          switchMode("verification");
          setNotice(message);
          return;
        }
        throw new Error(message || "Something went wrong. Please try again.");
      }
      if (mode === "register") {
        switchMode("verification");
        setNotice(data.message);
        return;
      }
      if (mode === "reset") {
        switchMode("login");
        setNotice(data.message);
        return;
      }
      if (mode === "verification" || mode === "forgot") {
        setNotice(data.message);
        return;
      }
      await onAuthenticated(data);
    } catch (requestError) {
      setError(requestError.message || "Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copy = AUTH_COPY[mode];
  const passwordInput = (id, label, value, setValue, autoComplete) => (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="authPasswordWrap">
        <input
          id={id}
          type={showPassword ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={8}
          maxLength={128}
          value={value}
          onChange={event => { setValue(event.target.value); setError(""); }}
          placeholder="At least 8 characters"
        />
        <button
          type="button"
          className="authEye"
          onClick={() => setShowPassword(shown => !shown)}
          aria-label={showPassword ? "Hide password" : "Show password"}
          aria-pressed={showPassword}
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? "🙈" : "👁"}
        </button>
      </div>
    </>
  );

  return (
    <div className="authBackdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="authDialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="authClose" type="button" onClick={onClose} aria-label="Close sign in">×</button>
        <div className="authIcon">🔐</div>
        <p className="authEyebrow">LINKSHORTENER ACCOUNT</p>
        <h2 id="auth-title">{copy.title}</h2>
        <p className="authIntro">{copy.intro}</p>
        <form className="authForm" onSubmit={submit}>
          {needsEmail && <>
            <label htmlFor="auth-email">Email address</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={event => { setEmail(event.target.value); setError(""); setNotice(""); }}
              onInvalid={event => event.currentTarget.setCustomValidity("Enter a valid email address.")}
              onInput={event => event.currentTarget.setCustomValidity("")}
              placeholder="you@example.com"
            />
          </>}
          {needsPassword && passwordInput(
            "auth-password",
            mode === "reset" ? "New password" : "Password",
            password,
            setPassword,
            mode === "login" ? "current-password" : "new-password",
          )}
          {needsConfirm && passwordInput("auth-password-confirm", "Confirm password", confirmPassword, setConfirmPassword, "new-password")}
          {mode === "login" && (
            <button type="button" className="authForgot" onClick={() => switchMode("forgot")}>Forgot password?</button>
          )}
          {notice && <div className="authNotice" role="status">{notice}</div>}
          {error && <div className="errBox" role="alert">{error}</div>}
          <button className="btn btnPrimary authSubmit" type="submit" disabled={busy}>
            {busy ? <><span className="spin" /> Please wait…</> : copy.submit}
          </button>
        </form>
        <p className="authSwitch">
          {mode === "login" ? "New to LinkShortener?" : mode === "register" ? "Already have an account?" : mode === "verification" ? "Already verified?" : "Remembered your password?"}
          {" "}
          <button type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "Create account" : "Sign in"}
          </button>
        </p>
      </section>
    </div>
  );
}

/* ─── Main App ────────────────────────────────────────────── */
export default function App() {
  const interactiveRef = useRef(null);
  // A saved choice wins; otherwise start from the device's light/dark setting.
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("ls_theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* storage unavailable */ }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("ls_theme", next); } catch { /* storage unavailable */ }
  };
  const [shortRedirectCode] = useState(() => new URLSearchParams(window.location.search).get("r") || "");
  const [redirectError, setRedirectError] = useState("");
  const [tab, setTab] = useState("single");
  const [history, setHistory] = useState(getHistory);
  const [token, setToken] = useState(() => localStorage.getItem("ls_token") || "");
  const [user, setUser] = useState(null);
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  const [verifiedParam] = useState(() => new URLSearchParams(window.location.search).get("verified"));
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get("reset") || "");
  const [authOpen, setAuthOpen] = useState(() => Boolean(resetToken) || verifiedParam === "1" || verifiedParam === "0");
  const [authMode, setAuthMode] = useState(() => resetToken ? "reset" : verifiedParam === "0" ? "verification" : "login");
  const [authNotice, setAuthNotice] = useState(() => (
    verifiedParam === "1"
      ? "Email verified. You can now sign in."
      : verifiedParam === "0"
        ? "This verification link is invalid or expired. Enter your email to get a new one."
        : ""
  ));
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState("");
  const [statsVersion, setStatsVersion] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    // Match the mobile browser's address bar to the page.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7fc" : "#050916");
    if (theme === "light") {
      const headline = document.querySelector(".hero3dText");
      headline?.style.removeProperty("transform");
      headline?.style.removeProperty("filter");
      headline?.style.removeProperty("text-shadow");
    }
  }, [theme]);
  useEffect(() => {
    // Follow live changes to the device theme until the user picks one with the toggle.
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const follow = (event) => {
      try { if (localStorage.getItem("ls_theme")) return; } catch { /* storage unavailable */ }
      setTheme(event.matches ? "light" : "dark");
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const addToHistory = useCallback((entry) => {
    setStatsVersion(version => version + 1);
    // Account links are synced from the server; only guest history belongs in localStorage.
    setHistory(prev => { const n = [entry, ...prev.filter(h => h.short !== entry.short)]; if (!tokenRef.current) saveHistory(n); return n; });
  }, []);
  const clearHistory = () => { setHistory([]); localStorage.removeItem("ls_history"); };
  useEffect(() => {
    if (!shortRedirectCode) return undefined;
    let cancelled = false;
    const resolveShortUrl = async () => {
      try {
        const response = await fetch(`${API}/resolve/${encodeURIComponent(shortRedirectCode)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Short URL not found.");
        if (!cancelled) window.location.replace(data.original_url);
      } catch (error) {
        if (!cancelled) setRedirectError(error.message || "Unable to open this short link.");
      }
    };
    resolveShortUrl();
    return () => { cancelled = true; };
  }, [shortRedirectCode]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Drop one-time email-link parameters so a refresh doesn't reopen the dialog.
    if (!params.has("verified") && !params.has("reset")) return;
    params.delete("verified");
    params.delete("reset");
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, []);
  useEffect(() => {
    let cancelled = false;
    const loadStats = async () => {
      try {
        const response = await fetch(`${API}/stats`, { headers: requestHeaders(token) });
        if (!response.ok) throw new Error("Stats are temporarily unavailable.");
        const data = await response.json();
        if (cancelled) return;
        setStats(data);
        setStatsError("");
      } catch (error) {
        if (cancelled) return;
        setStatsError(error.message || "Stats are temporarily unavailable.");
      }
    };
    loadStats();
    const interval = window.setInterval(loadStats, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token, statsVersion]);
  useEffect(() => {
    const root = interactiveRef.current;
    if (!root) return undefined;

    const resetTilt = (surface) => {
      surface.style.setProperty("--tilt-x", "0deg");
      surface.style.setProperty("--tilt-y", "0deg");
      surface.style.setProperty("--pointer-x", "50%");
      surface.style.setProperty("--pointer-y", "50%");
      surface.style.setProperty("--tilt-lift", "0px");
    };
    const onPointerMove = (event) => {
      if (event.pointerType !== "mouse") return;
      const surface = event.target.closest(".tilt3d");
      if (!surface || !root.contains(surface)) return;
      const bounds = surface.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      const isLight = document.documentElement.dataset.theme === "light";
      const strength = (surface.classList.contains("featCard") ? 7 : 4) * (isLight ? 1.6 : 1);
      surface.style.setProperty("--tilt-x", `${(0.5 - y) * strength}deg`);
      surface.style.setProperty("--tilt-y", `${(x - 0.5) * strength}deg`);
      surface.style.setProperty("--pointer-x", `${x * 100}%`);
      surface.style.setProperty("--pointer-y", `${y * 100}%`);
      surface.style.setProperty("--tilt-lift", surface.classList.contains("featCard") ? (isLight ? "-6px" : "-4px") : (isLight ? "-4px" : "-2px"));
      surface.classList.add("isTilted");
    };
    const onPointerOut = (event) => {
      const surface = event.target.closest(".tilt3d");
      if (surface && !surface.contains(event.relatedTarget)) {
        resetTilt(surface);
        surface.classList.remove("isTilted");
      }
    };

    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerout", onPointerOut);
    return () => {
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerout", onPointerOut);
    };
  }, []);
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const restoreAccount = async () => {
      try {
        const headers = requestHeaders(token);
        const [accountResponse, linksResponse] = await Promise.all([
          fetch(`${API}/auth/me`, { headers }),
          fetch(`${API}/my-links`, { headers }),
        ]);
        if ([401, 403].includes(accountResponse.status) || [401, 403].includes(linksResponse.status)) {
          localStorage.removeItem("ls_token");
          setToken("");
          setUser(null);
          setHistory(getHistory());
          return;
        }
        if (!accountResponse.ok || !linksResponse.ok) throw new Error("Account sync failed.");
        const account = await accountResponse.json();
        const links = await linksResponse.json();
        if (cancelled) return;
        setUser(account);
        setHistory(links.map(link => ({
          original: link.original_url,
          short: link.short_url,
          code: link.short_code,
          ts: link.created_at ? new Date(link.created_at).getTime() : Date.now(),
        })));
      } catch (error) {
        if (cancelled) return;
        console.error("Unable to restore account:", error);
      }
    };
    restoreAccount();
    return () => { cancelled = true; };
  }, [token]);
  const handleAuthenticated = async (data) => {
    localStorage.setItem("ls_token", data.access_token);
    setToken(data.access_token);
    setUser(data.user);
    setAuthOpen(false);
  };
  const signOut = async () => {
    try {
      const response = await fetch(`${API}/auth/logout`, { method: "POST", headers: requestHeaders(token) });
      if (!response.ok) throw new Error("Could not revoke the server session.");
    } catch (error) {
      console.error("Sign-out request failed:", error);
    } finally {
      localStorage.removeItem("ls_token");
      setToken("");
      setUser(null);
      setHistory(getHistory());
    }
  };

  if (shortRedirectCode) {
    return (
      <main role={redirectError ? "alert" : "status"} style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, color: "#cde0f5", background: "#04080f", fontFamily: "Inter, sans-serif" }}>
        {redirectError || "Opening your link…"}
      </main>
    );
  }

  return (
    <>
      {/* ───────────────── GLOBAL CSS ───────────────── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,300..900;1,14..32,300..900&family=Syne:wght@700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; color-scheme: dark; }

        body {
          font-family: 'Inter', sans-serif;
          background: #04080f;
          color: #cde0f5;
          min-height: 100vh;
          overflow-x: hidden;
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1a3a60; border-radius: 99px; }

        /* ═══════════════════════════════════════════════
           BACKGROUND
        ═══════════════════════════════════════════════ */
        .bgRoot {
          position: fixed; inset: 0; z-index: 0;
          background:
            radial-gradient(ellipse 80% 60% at 50% -10%, rgba(14,80,200,0.22) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 90% 80%, rgba(100,40,200,0.14) 0%, transparent 55%),
            radial-gradient(ellipse 60% 50% at 0% 100%, rgba(0,60,160,0.1) 0%, transparent 50%),
            #04080f;
          pointer-events: none;
        }

        /* Dot-grid mesh */
        .bgMesh {
          position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background-image: radial-gradient(circle, rgba(60,130,255,0.12) 1px, transparent 1px);
          background-size: 40px 40px;
          mask-image: radial-gradient(ellipse 90% 90% at 50% 30%, black 30%, transparent 80%);
        }

        /* Floating orbs */
        .orb { position: fixed; border-radius: 50%; filter: blur(80px); pointer-events: none; z-index: 0; }
        .orb1 { width: 700px; height: 500px; top: -180px; left: -200px; background: rgba(14,90,220,0.15); animation: orbDrift 16s ease-in-out infinite alternate; }
        .orb2 { width: 500px; height: 400px; top: 25%; right: -150px; background: rgba(110,40,220,0.12); animation: orbDrift 11s ease-in-out infinite alternate-reverse; }
        .orb3 { width: 400px; height: 300px; bottom: -80px; left: 25%; background: rgba(0,120,230,0.1); animation: orbDrift 14s ease-in-out infinite alternate; }
        @keyframes orbDrift { from { transform: translate(0,0) scale(1); } to { transform: translate(40px,50px) scale(1.12); } }

        /* ═══════════════════════════════════════════════
           NAV
        ═══════════════════════════════════════════════ */
        .nav {
          position: sticky; top: 0; z-index: 200;
          display: flex; align-items: center; justify-content: space-between;
          padding: 0 6%; height: 68px;
          background: rgba(4,8,15,0.65);
          backdrop-filter: blur(24px) saturate(1.6);
          border-bottom: 1px solid rgba(60,140,255,0.09);
        }
        .navBrand {
          display: flex; align-items: center; gap: 11px;
          font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px;
          color: #fff; text-decoration: none; letter-spacing: -0.5px;
        }
        .navLogo {
          width: 38px; height: 38px; border-radius: 11px; font-size: 19px;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #2a7fff, #8b40f0);
          box-shadow: 0 0 24px rgba(60,140,255,0.45), 0 0 8px rgba(139,64,240,0.3);
          animation: logoPulse 3.5s ease-in-out infinite;
        }
        @keyframes logoPulse {
          0%,100% { box-shadow: 0 0 24px rgba(60,140,255,0.45), 0 0 8px rgba(139,64,240,0.3); }
          50% { box-shadow: 0 0 36px rgba(60,140,255,0.7), 0 0 18px rgba(139,64,240,0.5); }
        }
        .navLinks { display: flex; align-items: center; gap: 28px; }
        .navLinks a { color: #7090b8; text-decoration: none; font-size: 13.5px; font-weight: 500; transition: color 0.22s; }
        .navLinks a:hover { color: #d0e8ff; }
        .navAuth {
          border: 1px solid rgba(80,150,255,0.24); border-radius: 9px;
          padding: 8px 14px; color: #9ccaff; background: rgba(20,50,100,0.32);
          font: 600 13px 'Inter',sans-serif; cursor: pointer; transition: all .2s;
        }
        .navAuth:hover { color: #fff; border-color: rgba(80,150,255,0.55); background: rgba(40,90,170,0.35); }
        .navUser { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #6e8db1; font-size: 12px; }
        .navCta {
          padding: 8px 20px; border-radius: 9px; font-weight: 700 !important;
          color: #fff !important; font-size: 13px !important;
          background: linear-gradient(135deg, #2279ff, #8040f0);
          box-shadow: 0 4px 18px rgba(40,120,255,0.4);
          transition: transform 0.2s, box-shadow 0.2s !important;
        }
        .navCta:hover { transform: translateY(-2px) !important; box-shadow: 0 8px 28px rgba(40,120,255,0.55) !important; }

        /* ═══════════════════════════════════════════════
           LAYOUT
        ═══════════════════════════════════════════════ */
        .appRoot { position: relative; z-index: 1; }
        .wrap { width: min(100%, 1120px); margin: 0 auto; padding: 0 28px; }

        /* ═══════════════════════════════════════════════
           HERO
        ═══════════════════════════════════════════════ */
        .hero {
          display: flex; align-items: center; gap: 50px;
          padding: 80px 0 56px;
        }
        .heroLeft { flex: 1; }

        /* Animated pill badge */
        .pill {
          display: inline-flex; align-items: center; gap: 9px;
          padding: 7px 16px; border-radius: 999px; margin-bottom: 26px;
          background: rgba(30,100,255,0.09);
          border: 1px solid rgba(60,150,255,0.22);
          font-size: 12.5px; font-weight: 600; color: #80c4ff;
          letter-spacing: 0.4px;
          animation: fadeUp .6s ease both;
        }
        .pillDot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #30f0a0; box-shadow: 0 0 10px #30f0a0;
          animation: blink 2s ease-in-out infinite;
        }
        @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:.25;} }

        /* Heading */
        .heroH1 {
          font-family: 'Syne', sans-serif;
          font-size: clamp(44px, 5.8vw, 78px);
          font-weight: 800; line-height: .96;
          letter-spacing: -3px; margin-bottom: 22px;
          color: #fff;
          animation: fadeUp .7s .08s ease both;
        }
        .hero3dText {
          display: inline-block;
          position: relative;
          transform: perspective(700px) rotateX(3deg);
          transform-origin: center bottom;
          transition: transform .24s cubic-bezier(.2,.8,.2,1), filter .24s ease, text-shadow .24s ease;
          background: linear-gradient(180deg, #ffffff 4%, #c5ebff 58%, #71c9ff 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          text-shadow:
            0 1px 0 #438bc3,
            0 2px 0 #28649c,
            0 3px 0 #194b7d,
            0 5px 0 rgba(16,44,78,.7),
            0 10px 18px rgba(0,0,0,.35);
        }
        .heroH1 .line2 {
          display: block;
          background: linear-gradient(100deg, #60d0ff 0%, #b080ff 50%, #ff80c0 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
          background-size: 200% auto;
          animation: fadeUp .7s .08s ease both, gradFlow 5s linear infinite;
        }
        @keyframes gradFlow { 0%{background-position:0%} 100%{background-position:200%} }

        .heroSub {
          color: #6080a8; font-size: 16px; line-height: 1.7;
          max-width: 460px; margin-bottom: 32px;
          animation: fadeUp .8s .15s ease both;
        }
        .heroSub strong { color: #a080f8; font-weight: 600; }

        /* Stat chips below sub */
        .heroChips { display: flex; gap: 10px; flex-wrap: wrap; animation: fadeUp .9s .22s ease both; }
        .chip {
          padding: 5px 13px; border-radius: 999px;
          background: rgba(20,40,80,0.7);
          border: 1px solid rgba(60,120,220,0.18);
          font-size: 12px; font-weight: 600; color: #5080b0;
        }

        /* ─── 3-D card ─── */
        .hcWrap {
          flex: 0 0 260px; perspective: 900px;
          display: flex; align-items: center; justify-content: center;
          animation: fadeRight .9s .12s ease both;
        }
        .hc {
          width: 230px; height: 290px; border-radius: 26px;
          background: linear-gradient(155deg, rgba(10,22,60,0.95) 0%, rgba(6,12,36,0.98) 100%);
          border: 1px solid rgba(60,150,255,0.18);
          box-shadow:
            0 0 0 1px rgba(60,150,255,0.06),
            0 30px 80px rgba(0,0,0,0.6),
            0 0 60px rgba(40,110,255,0.1);
          transition: transform .12s ease;
          position: relative; overflow: hidden; transform-style: preserve-3d;
        }
        .hcSpin {
          position: absolute; width: 200%; height: 200%; top: -50%; left: -50%;
          background: conic-gradient(from 0deg, transparent 0%, rgba(60,140,255,0.1) 20%, transparent 40%);
          animation: spin 10s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .hcBody { position: relative; z-index: 2; padding: 28px 22px; display: flex; flex-direction: column; gap: 14px; }
        .hcEmoji { font-size: 44px; filter: drop-shadow(0 0 18px rgba(60,160,255,0.6)); }
        .hcBars { display: flex; flex-direction: column; gap: 9px; }
        .hcBar { height: 7px; border-radius: 99px; background: linear-gradient(90deg, #1a5cff, #8040e0); animation: shimBar 2s ease-in-out infinite alternate; }
        @keyframes shimBar { 0%{opacity:.35;} 100%{opacity:1;} }
        .hcTag {
          padding: 5px 14px; border-radius: 999px; width: fit-content;
          background: linear-gradient(90deg, #102060, #300c60);
          font-size: 9px; font-weight: 800; letter-spacing: 2px; color: #80b8ff;
        }
        .hcArrow {
          position: absolute; bottom: 22px; right: 22px;
          font-size: 30px; color: rgba(80,180,255,0.45);
          animation: arrowPop 2s ease-in-out infinite;
        }
        @keyframes arrowPop { 0%,100%{transform:translate(0,0)} 50%{transform:translate(5px,-5px)} }
        .hcBlob { position: absolute; border-radius: 50%; filter: blur(35px); pointer-events: none; }
        .b1 { width: 110px; height: 110px; background: #1050cc; bottom: -30px; right: -20px; opacity: .5; }
        .b2 { width: 80px; height: 80px; background: #6020cc; top: -10px; right: 20px; opacity: .4; }
        .hcGlare {
          position: absolute; inset: 0;
          background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, transparent 50%);
          border-radius: inherit; pointer-events: none;
        }

        /* ═══════════════════════════════════════════════
           STATS STRIP
        ═══════════════════════════════════════════════ */
        .statsStrip {
          display: flex; align-items: stretch;
          margin: 0 0 44px;
          border-radius: 18px; overflow: hidden;
          border: 1px solid rgba(40,100,220,0.13);
          background: rgba(6,12,32,0.6);
          backdrop-filter: blur(10px);
          animation: fadeUp 1s .28s ease both;
        }
        .sStat {
          flex: 1; text-align: center; padding: 18px 12px;
          border-right: 1px solid rgba(40,100,220,0.1);
          position: relative; overflow: hidden;
        }
        .tilt3d {
          transform: perspective(1000px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg)) translateY(var(--tilt-lift, 0px));
          transform-style: preserve-3d;
          transition: transform .18s ease-out, box-shadow .22s ease, border-color .22s ease;
          will-change: transform;
        }
        .tilt3d > * { transform: translateZ(12px); }
        .sStat::after {
          content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0;
          background: radial-gradient(circle at var(--pointer-x, 50%) var(--pointer-y, 50%), rgba(70,150,255,.13), transparent 65%);
          transition: opacity .2s ease;
        }
        .sStat:hover::after { opacity: 1; }
        .sStat::before {
          content: ''; position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
          width: 40%; height: 2px; border-radius: 99px;
          background: linear-gradient(90deg, transparent, rgba(60,140,255,0.5), transparent);
        }
        .sStat:last-child { border-right: none; }
        .sNum { font-family:'Syne',sans-serif; font-size: 24px; font-weight: 800; color: #50d0ff; display: block; }
        .sLbl { font-size: 10.5px; color: #3a5878; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; margin-top: 4px; display: block; }

        /* ═══════════════════════════════════════════════
           ANALYTICS DASHBOARD
        ═══════════════════════════════════════════════ */
        .analytics { padding: 18px 0 52px; }
        .analyticsHeader { display: flex; justify-content: space-between; align-items: end; margin-bottom: 18px; }
        .analyticsTag { text-align: left; margin-bottom: 7px; color: #4189db; font-size: 9px; }
        .analyticsTitle { color: #d6e9ff; font: 800 clamp(22px,3vw,30px) 'Syne',sans-serif; letter-spacing: -.7px; }
        .liveBadge {
          display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px;
          border: 1px solid rgba(50,210,155,.16); border-radius: 99px;
          color: #6bcba9; background: rgba(24,145,105,.08); font-size: 10px; font-weight: 700;
        }
        .liveBadge span { width: 6px; height: 6px; border-radius: 50%; background: #40e6a2; box-shadow: 0 0 10px #40e6a2; animation: blink 2s ease-in-out infinite; }
        .analyticsGrid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 13px; }
        .analyticsCard {
          min-width: 0; min-height: 158px; position: relative; overflow: hidden;
          padding: 19px 20px; border-radius: 17px;
          border: 1px solid rgba(55,112,205,.15);
          background: linear-gradient(145deg, rgba(9,19,47,.88), rgba(5,11,28,.76));
          box-shadow: 0 14px 34px rgba(0,0,0,.16), inset 0 1px rgba(255,255,255,.025);
          transition: transform .25s ease, border-color .25s ease, box-shadow .25s ease;
        }
        .analyticsCard:hover { transform: translateY(-3px); border-color: rgba(65,145,255,.3); box-shadow: 0 20px 42px rgba(0,0,0,.25), 0 0 28px rgba(35,105,255,.06); }
        .analyticsCardTop { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #718baa; font-size: 11px; font-weight: 600; }
        .analyticsIcon { color: #67baff; font-size: 17px; }
        .analyticsNumber { display: block; margin-top: 12px; color: #e7f4ff; font: 800 30px 'Syne',sans-serif; letter-spacing: -.7px; }
        .analyticsFoot { display: block; margin-top: 2px; color: #3f5a79; font-size: 10px; }
        .analyticsClicks { background: radial-gradient(ellipse at 95% 0%, rgba(35,120,250,.15), transparent 60%), linear-gradient(145deg, rgba(9,19,47,.92), rgba(5,11,28,.8)); }
        .sparkline { height: 42px; position: absolute; right: 18px; bottom: 18px; display: flex; align-items: end; gap: 4px; }
        .sparkline span { width: 5px; min-height: 4px; border-radius: 5px; background: linear-gradient(180deg,#6ad8ff,#4269f5 70%,rgba(115,65,235,.65)); transform-origin: bottom; animation: barIn .55s cubic-bezier(.2,.8,.2,1) both; }
        @keyframes barIn { from { transform: scaleY(.1); opacity: .3; } to { transform: scaleY(1); opacity: 1; } }
        .communityVisual { height: 38px; position: absolute; right: 18px; bottom: 17px; display: flex; align-items: end; gap: 4px; }
        .communityVisual i { width: 7px; height: 12px; border: 1px solid rgba(112,147,255,.55); border-radius: 7px 7px 4px 4px; background: linear-gradient(180deg,rgba(125,100,255,.58),rgba(41,100,220,.1)); }
        .communityVisual i:nth-child(2n) { height: 19px; }
        .communityVisual i:nth-child(3n) { height: 27px; }
        .communityVisual i:nth-child(4n) { height: 34px; border-color: rgba(97,194,255,.66); }
        .linkVisual { height: 36px; position: absolute; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 4px; }
        .linkVisual span { width: 7px; border-radius: 8px; background: linear-gradient(180deg,#70e0ff,#5466e9); box-shadow: 0 0 9px rgba(70,150,255,.18); }
        .linkVisual span:nth-child(1),.linkVisual span:nth-child(5) { height: 13px; opacity: .55; }
        .linkVisual span:nth-child(2),.linkVisual span:nth-child(4) { height: 24px; opacity: .8; }
        .linkVisual span:nth-child(3) { height: 34px; }
        .trafficCard { grid-column: span 2; min-height: 220px; }
        .analyticsPeriod { color: #385472; font-size: 8px; font-weight: 800; letter-spacing: 1px; }
        .trafficChart { display: flex; align-items: stretch; justify-content: space-around; gap: 10px; height: 145px; margin-top: 13px; padding: 0 10px; }
        .trafficDay { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; }
        .trafficCount { min-height: 12px; color: #70baff; font-size: 9px; font-weight: 700; }
        .trafficTrack { flex: 1; width: 100%; display: flex; align-items: end; justify-content: center; border-bottom: 1px solid rgba(75,112,170,.15); background: linear-gradient(180deg,transparent,rgba(32,63,112,.07)); }
        .trafficBar { width: min(24px,65%); min-height: 3px; border-radius: 7px 7px 2px 2px; background: linear-gradient(180deg,#62dfff,#4c84ff 60%,#754be4); box-shadow: 0 0 15px rgba(69,142,255,.2); transition: height .5s cubic-bezier(.2,.8,.2,1); }
        .trafficLabel { color: #536d89; font-size: 9px; }
        .topLinksCard { min-height: 220px; }
        .analyticsMessage { color: #506883; font-size: 11px; line-height: 1.6; margin-top: 20px; }
        .topLinksList { display: flex; flex-direction: column; gap: 12px; margin-top: 18px; }
        .topLinkLabels { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 5px; color: #7a9cbb; font-size: 10px; }
        .topLinkLabels span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .topLinkLabels strong { flex: 0 0 auto; color: #69cfff; }
        .topLinkTrack { height: 4px; overflow: hidden; border-radius: 99px; background: rgba(70,110,170,.13); }
        .topLinkTrack span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg,#328dff,#9962f5); transition: width .45s ease; }

        /* ═══════════════════════════════════════════════
           TAB BAR
        ═══════════════════════════════════════════════ */
        .tabs {
          display: flex; gap: 5px; width: fit-content;
          background: rgba(6,12,32,0.7); border: 1px solid rgba(40,100,220,0.12);
          border-radius: 14px; padding: 5px; margin-bottom: 16px;
          animation: fadeUp .8s .32s ease both;
        }
        .tab {
          padding: 9px 24px; border-radius: 10px; border: none; cursor: pointer;
          font-family: 'Inter', sans-serif; font-size: 13.5px; font-weight: 600;
          color: #4a6888; background: transparent; transition: all .22s;
          display: flex; align-items: center; gap: 8px;
        }
        .tab.on { background: linear-gradient(135deg, #1a6aff, #7030ee); color: #fff; box-shadow: 0 4px 18px rgba(26,106,255,0.38); }
        .tab:hover:not(.on) { color: #90b8d8; background: rgba(255,255,255,0.04); }
        .newTag {
          font-size: 7.5px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase;
          background: linear-gradient(90deg, #30f0a0, #00d8c0); color: #030c1e;
          padding: 2px 7px; border-radius: 4px;
        }

        /* ═══════════════════════════════════════════════
           CARD
        ═══════════════════════════════════════════════ */
        .card {
          border-radius: 22px; padding: 30px;
          background: rgba(6,12,36,0.82);
          border: 1px solid rgba(40,110,255,0.13);
          box-shadow: 0 24px 70px rgba(0,0,0,0.4), 0 0 0 1px rgba(40,110,255,0.05);
          backdrop-filter: blur(14px);
          animation: fadeOpacity .9s .38s ease both;
          position: relative; overflow: hidden;
        }
        .card::before {
          content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
          background: linear-gradient(135deg, rgba(40,110,255,0.04) 0%, transparent 60%);
        }
        .card::after {
          content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0;
          background: radial-gradient(circle at var(--pointer-x, 50%) var(--pointer-y, 50%), rgba(55,130,255,.15), transparent 58%);
          transition: opacity .2s ease;
        }
        .card:hover::after { opacity: 1; }
        .cardLabel { font-size: 10.5px; font-weight: 800; letter-spacing: 2.5px; text-transform: uppercase; color: #2e7ad8; margin-bottom: 18px; }
        .cardTag { font-size: 9px; font-weight: 700; letter-spacing: 1px; color: #3a5070; background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 4px; margin-left: 8px; text-transform: uppercase; }

        /* Input row */
        .inputRow { display: flex; gap: 8px; }
        .inputWrap {
          flex: 1; display: flex; align-items: center; gap: 10px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(60,140,255,0.16); border-radius: 13px;
          padding: 4px 4px 4px 16px;
          transition: border-color .22s, box-shadow .22s;
        }
        .inputWrap:focus-within { border-color: rgba(60,140,255,0.45); box-shadow: 0 0 0 4px rgba(40,110,255,0.1); }
        .inputIcon { font-size: 16px; opacity: .4; flex-shrink: 0; }
        .inputWrap input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: #cde0ff; font-size: 15px; font-family: 'Inter',sans-serif; padding: 12px 0; }
        .inputWrap input::placeholder { color: #2e4a68; }
        .campaignPanel { flex: 0 0 100%; min-width: 0; padding: 12px 14px; border: 1px solid rgba(60,140,255,0.13); border-radius: 12px; background: rgba(2,8,24,0.48); }
        .campaignPanel summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #9ccaff; cursor: pointer; font-size: 13px; font-weight: 700; list-style-position: inside; }
        .campaignPanel summary span { color: #3e6287; font-size: 10px; font-weight: 500; }
        .campaignHelp { margin: 10px 0 12px; color: #6d88a7; font-size: 11.5px; line-height: 1.5; }
        .campaignFields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        .campaignFields label { display: flex; min-width: 0; flex-direction: column; gap: 5px; color: #7898ba; font-size: 10.5px; font-weight: 600; }
        .campaignFields label:last-child:nth-child(odd) { grid-column: 1 / -1; }
        .campaignFields input { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid rgba(70,130,220,.18); border-radius: 8px; outline: none; background: rgba(255,255,255,.04); color: #d6e9ff; font: 13px 'Inter',sans-serif; }
        .campaignFields input:focus { border-color: rgba(70,150,255,.55); box-shadow: 0 0 0 3px rgba(40,110,255,.1); }
        .campaignFields input::placeholder { color: #3c5573; }

        /* Textarea */
        .taWrap textarea {
          width: 100%; resize: vertical; min-height: 120px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(60,140,255,0.15); border-radius: 13px;
          padding: 14px 16px; color: #cde0ff;
          font-size: 14px; font-family: 'Inter',sans-serif; line-height: 1.65;
          outline: none; transition: border-color .22s, box-shadow .22s;
        }
        .taWrap textarea:focus { border-color: rgba(60,140,255,0.42); box-shadow: 0 0 0 4px rgba(40,110,255,0.1); }
        .taWrap textarea::placeholder { color: #1e3850; }
        .taMeta { display: flex; justify-content: space-between; align-items: center; margin-top: 7px; font-size: 11.5px; color: #2e4868; }

        /* Buttons */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          border: none; cursor: pointer; border-radius: 10px; font-family: 'Inter',sans-serif;
          font-weight: 700; text-decoration: none; white-space: nowrap; transition: all .2s;
        }
        .btnPrimary {
          height: 48px; padding: 0 28px; font-size: 14.5px;
          background: linear-gradient(135deg, #1a7aff, #8030f0);
          color: #fff; box-shadow: 0 6px 24px rgba(26,122,255,0.38);
        }
        .btnPrimary:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(26,122,255,0.55); }
        .btnPrimary:disabled { opacity: .5; cursor: not-allowed; transform: none; }
        .btnGhost { height: 40px; padding: 0 18px; font-size: 13px; background: rgba(20,44,90,0.65); color: #6090c0; border: 1px solid rgba(40,90,200,0.18); }
        .btnGhost:hover { background: rgba(30,60,120,0.8); color: #90c0e8; }
        .btnBlue { height: 40px; padding: 0 18px; font-size: 13px; background: linear-gradient(135deg, #1a6aff, #5020d0); color: #fff; box-shadow: 0 4px 14px rgba(26,106,255,0.35); }
        .btnBlue:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(26,106,255,0.5); }
        .btnSm { height: 40px; padding: 0 14px; font-size: 12.5px; }
        .btnGreen { background: rgba(15,100,60,0.7) !important; color: #30f0a0 !important; border: 1px solid rgba(30,200,100,0.2) !important; }
        .btnActive { background: rgba(20,70,160,0.8) !important; color: #60c0ff !important; }
        .ghostBtn { background: none; border: none; cursor: pointer; font-family: 'Inter',sans-serif; font-size: 12px; color: #2e4868; font-weight: 600; padding: 0; transition: color .2s; }
        .ghostBtn:hover { color: #607898; }
        .ghostBtn.red:hover { color: #ff6a80; }
        .ghostBtn:disabled { opacity: .4; cursor: not-allowed; }
        .arr { font-size: 17px; transition: transform .2s; }
        .btnPrimary:hover .arr { transform: translate(3px,-3px); }

        /* Spinner */
        .spin { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff; display: inline-block; animation: spinAnim .65s linear infinite; }
        @keyframes spinAnim { to { transform: rotate(360deg); } }

        /* Hint */
        .hint { font-size: 11.5px; color: #253a58; margin-top: 9px; }

        /* Error */
        .errBox { margin-top: 14px; padding: 12px 16px; background: rgba(200,40,60,0.1); border: 1px solid rgba(220,60,80,0.22); border-radius: 10px; color: #ff8a9c; font-size: 13px; animation: fadeUp .28s ease; }

        /* ═══════════════════════════════════════════════
           RESULT
        ═══════════════════════════════════════════════ */
        .resultBox {
          margin-top: 20px; padding: 20px 22px;
          background: rgba(4,10,28,0.92);
          border: 1px solid rgba(40,200,110,0.18); border-radius: 16px;
          box-shadow: 0 0 40px rgba(40,200,110,0.05), 0 14px 48px rgba(0,0,0,0.35);
          animation: popIn .38s cubic-bezier(.34,1.56,.64,1);
        }
        @keyframes popIn { from{opacity:0;transform:translateY(12px) scale(.97)} to{opacity:1;transform:none} }
        .rbTop { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .rbOk { font-size: 11.5px; font-weight: 700; color: #30f0a0; background: rgba(40,220,120,0.1); padding: 4px 11px; border-radius: 99px; border: 1px solid rgba(40,220,120,0.22); }
        .rbX { border: none; background: rgba(255,255,255,0.07); color: #507090; width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 18px; transition: background .2s; }
        .rbX:hover { background: rgba(255,255,255,0.13); color: #fff; }
        .rbRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .rbLink {
          flex: 1; min-width: 160px; display: block; padding: 11px 15px; border-radius: 10px;
          background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.07);
          color: #50d0ff; text-decoration: none; font-size: 14px;
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
          transition: border-color .2s, color .2s;
        }
        .rbLink:hover { color: #fff; border-color: rgba(60,180,255,0.38); }
        .rbSrc { font-size: 11px; color: #2a4060; margin-top: 9px; }

        /* QR */
        .qrBox { margin-top: 14px; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px; background: rgba(2,8,24,0.7); border-radius: 14px; border: 1px solid rgba(40,100,220,0.12); animation: fadeUp .28s ease; }
        .qrImg { width: 148px; height: 148px; border-radius: 10px; border: 1px solid rgba(40,120,255,0.2); }
        .qrDl { color: #50d0ff; font-size: 12px; font-weight: 600; text-decoration: none; transition: color .2s; }
        .qrDl:hover { color: #fff; }
        .qrInline { width: 100%; margin-top: 8px; }

        /* ═══════════════════════════════════════════════
           BULK
        ═══════════════════════════════════════════════ */
        .progWrap { margin: 14px 0; }
        .progBar { width: 100%; height: 5px; background: rgba(255,255,255,0.07); border-radius: 99px; overflow: hidden; margin-bottom: 6px; }
        .progFill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, #1a7aff, #8030f0); transition: width .3s ease; }
        .progLbl { font-size: 11px; color: #50d0ff; font-weight: 600; }
        .bulkBtns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
        .bulkList { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; }
        .bulkListHdr { font-size: 11px; color: #304060; font-weight: 700; padding-bottom: 8px; border-bottom: 1px solid rgba(40,100,220,0.1); }
        .bulkRow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 10px 14px; border-radius: 11px; background: rgba(255,255,255,0.025); border: 1px solid rgba(40,100,220,0.08); transition: border-color .2s; }
        .bulkRow:hover { border-color: rgba(40,100,220,0.22); }
        .bulkOk { border-left: 3px solid rgba(40,220,120,0.38); }
        .bulkErr { border-left: 3px solid rgba(220,60,80,0.38); }
        .brDomain { flex: 0 0 130px; font-size: 12px; color: #4a6888; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .brShort { flex: 1; min-width: 0; font-size: 13px; color: #50d0ff; text-decoration: none; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .brShort:hover { color: #fff; }
        .brErr { font-size: 12px; color: #ff7080; }

        /* ═══════════════════════════════════════════════
           FEATURES
        ═══════════════════════════════════════════════ */
        .feats { padding: 70px 0 50px; animation: fadeUp 1s .5s ease both; }
        .sectTag { text-align: center; font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #244060; text-transform: uppercase; margin-bottom: 10px; }
        .sectTitle { text-align: center; font-family: 'Syne',sans-serif; font-size: clamp(26px,3.5vw,42px); font-weight: 800; color: #c8e0f0; margin-bottom: 44px; letter-spacing: -1px; }
        .featsGrid { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap: 14px; }
        .featCard {
          padding: 26px; border-radius: 18px;
          background: rgba(6,12,36,0.7); border: 1px solid rgba(40,100,220,0.1);
          transition: transform .18s ease-out, border-color .25s, box-shadow .25s;
          position: relative; overflow: hidden;
        }
        .featCard::before {
          content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0;
          background: radial-gradient(circle at var(--pointer-x, 50%) var(--pointer-y, 50%), rgba(65,135,255,.16), transparent 60%);
          transition: opacity .2s ease;
        }
        .featCard:hover::before { opacity: 1; }
        .featCard::after {
          content:''; position:absolute; inset:0; border-radius:inherit;
          background: linear-gradient(135deg, rgba(40,110,255,0.04) 0%, transparent 55%);
          pointer-events:none;
        }
        .featCard:hover { border-color: rgba(60,140,255,0.3); box-shadow: 0 20px 50px rgba(0,0,0,0.35), 0 0 0 1px rgba(40,110,255,0.08); }
        .featIco { font-size: 30px; margin-bottom: 14px; display: block; filter: drop-shadow(0 0 14px rgba(60,160,255,0.5)); }
        .featName { font-size: 15px; font-weight: 700; color: #b8d8f0; margin-bottom: 8px; }
        .featDesc { font-size: 12.5px; color: #3a5878; line-height: 1.6; }

        /* ═══════════════════════════════════════════════
           HISTORY
        ═══════════════════════════════════════════════ */
        .histSec { padding: 44px 0; }
        .histHdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .histTitle { font-family: 'Syne',sans-serif; font-size: 20px; font-weight: 800; color: #a0c0e0; letter-spacing: -0.5px; }
        .histEmpty { padding: 18px 20px; border-radius: 13px; border: 1px solid rgba(40,100,220,0.09); background: rgba(6,12,36,0.45); color: #3a5878; font-size: 13px; }
        .histEntry { margin-bottom: 8px; }
        .histRow { display: flex; align-items: center; gap: 10px; padding: 13px 18px; border-radius: 13px; background: rgba(6,12,36,0.65); border: 1px solid rgba(40,100,220,0.09); transition: border-color .2s; }
        .histRow:hover { border-color: rgba(40,100,220,0.22); }
        .histLeft { flex: 1; min-width: 0; }
        .histDomain { font-size: 13.5px; font-weight: 600; color: #6090b8; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .histTime { font-size: 10.5px; color: #1e3050; margin-top: 2px; }
        .histCode { flex: 0 0 auto; font-size: 12.5px; color: #50d0ff; text-decoration: none; padding: 5px 12px; border-radius: 8px; background: rgba(0,0,0,0.25); font-weight: 600; transition: color .2s; }
        .histCode:hover { color: #fff; }
        .linkAnalytics { margin-top: 7px; padding: 16px; border: 1px solid rgba(40,100,220,0.12); border-radius: 13px; background: rgba(6,12,36,0.55); }
        .linkAnalyticsTop { display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #b8d8f0; font-size: 12px; }
        .linkAnalyticsTop span { color: #6d88a7; font-size: 10px; }
        .linkTrafficChart { display: flex; align-items: stretch; gap: 8px; height: 112px; margin-top: 12px; }
        .linkTrafficDay { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .linkTrafficCount { color: #70baff; font-size: 9px; font-weight: 700; }
        .linkTrafficTrack { flex: 1; width: 100%; display: flex; align-items: end; justify-content: center; border-bottom: 1px solid rgba(75,112,170,.15); background: linear-gradient(180deg,transparent,rgba(32,63,112,.07)); }
        .linkTrafficTrack span { width: min(22px,70%); min-height: 3px; border-radius: 6px 6px 2px 2px; background: linear-gradient(180deg,#62dfff,#4c84ff 60%,#754be4); }
        .linkTrafficLabel { color: #6d88a7; font-size: 9px; }

        /* ═══════════════════════════════════════════════
           FOOTER
        ═══════════════════════════════════════════════ */
        .footer { padding: 32px 0 26px; border-top: 1px solid rgba(40,100,220,0.08); text-align: center; }
        .footerTxt { font-size: 12.5px; color: #1e3050; }
        .heart { color: #f06080; }
        .footerNav { display: flex; gap: 22px; justify-content: center; margin-top: 9px; }
        .footerNav a { font-size: 11.5px; color: #1e3050; text-decoration: none; transition: color .2s; }
        .footerNav a:hover { color: #50d0ff; }

        /* ── Account dialog ── */
        .authBackdrop {
          position: fixed; inset: 0; z-index: 500; display: grid; place-items: center;
          padding: 20px; background: rgba(1,5,14,0.78); backdrop-filter: blur(12px);
          animation: fadeUp .2s ease both;
        }
        .authDialog {
          width: min(100%, 430px); padding: 36px; border-radius: 24px; position: relative;
          background: linear-gradient(145deg, rgba(10,22,52,.98), rgba(5,10,26,.99));
          border: 1px solid rgba(70,140,255,.24);
          box-shadow: 0 32px 100px rgba(0,0,0,.65), 0 0 55px rgba(35,100,255,.12);
        }
        .authClose {
          position: absolute; top: 16px; right: 18px; border: 0; background: transparent;
          color: #7893b3; font-size: 27px; cursor: pointer;
        }
        .authClose:hover { color: #fff; }
        .authIcon {
          width: 48px; height: 48px; display: grid; place-items: center; margin-bottom: 20px;
          border-radius: 15px; font-size: 22px;
          background: linear-gradient(135deg, rgba(35,120,255,.25), rgba(130,55,230,.25));
          border: 1px solid rgba(90,150,255,.2);
        }
        .authEyebrow { color: #64baff; font-size: 10px; font-weight: 800; letter-spacing: 2px; margin-bottom: 8px; }
        .authDialog h2 { color: #f2f7ff; font: 800 27px 'Syne',sans-serif; }
        .authIntro { margin-top: 8px; color: #718baa; font-size: 13px; line-height: 1.6; }
        .authNotice { margin-top: 14px; padding: 12px 14px; border: 1px solid rgba(48,200,145,.2); border-radius: 10px; background: rgba(28,150,105,.09); color: #82d8b7; font-size: 12px; line-height: 1.6; }
        .authForm { display: flex; flex-direction: column; margin-top: 24px; }
        .authForm label { margin: 14px 0 8px; color: #9ab4d1; font-size: 12px; font-weight: 600; }
        .authForm input {
          width: 100%; padding: 13px 14px; border-radius: 11px; outline: none;
          border: 1px solid rgba(70,130,220,.2); background: rgba(255,255,255,.045);
          color: #e2efff; font: 14px 'Inter',sans-serif;
        }
        .authForm input:focus { border-color: rgba(70,150,255,.6); box-shadow: 0 0 0 3px rgba(40,110,255,.12); }
        .authForm input::placeholder { color: #3c5573; }
        .authPasswordWrap { position: relative; }
        .authForm .authPasswordWrap input { padding-right: 48px; }
        .authEye {
          position: absolute; top: 50%; right: 6px; transform: translateY(-50%);
          width: 36px; height: 36px; border: 0; border-radius: 8px;
          background: none; font-size: 16px; cursor: pointer; opacity: .7; transition: opacity .2s, background .2s;
        }
        .authEye:hover, .authEye:focus-visible { opacity: 1; background: rgba(80,150,255,.12); }
        .authForgot {
          align-self: flex-end; margin-top: 10px; border: 0; background: none;
          color: #6bbaff; font: 600 12px 'Inter',sans-serif; cursor: pointer;
        }
        .authForgot:hover { color: #b9e2ff; }
        .authSubmit { width: 100%; margin-top: 22px; }
        .authSwitch { margin-top: 20px; text-align: center; color: #637f9f; font-size: 12px; }
        .authSwitch button { border: 0; background: none; color: #6bbaff; font: 700 12px 'Inter',sans-serif; cursor: pointer; }
        .authSwitch button:hover { color: #b9e2ff; }

        /* ═══════════════════════════════════════════════
           KEYFRAMES
        ═══════════════════════════════════════════════ */
        @keyframes fadeUp { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:none} }
        @keyframes fadeOpacity { from{opacity:0} to{opacity:1} }
        @keyframes fadeRight { from{opacity:0;transform:translateX(32px)} to{opacity:1;transform:none} }

        /* ═══════════════════════════════════════════════
           RESPONSIVE
        ═══════════════════════════════════════════════ */
        @media(max-width:900px) {
          .hero { flex-direction: column; padding: 52px 0 40px; gap: 32px; }
          .hcWrap { display: none; }
          .sStat { padding: 14px 8px; }
          .sNum { font-size: 20px; }
        }
        @media(max-width:640px) {
          .nav { padding: 0 18px; }
          .navLinks { gap: 10px; }
          .navUser { display: none; }
          .wrap { padding: 0 16px; }
          .hero { padding: 38px 0 28px; }
          .heroH1 { letter-spacing: -2px; }
          .statsStrip { flex-wrap: wrap; }
          .sStat { flex: 0 0 50%; border-bottom: 1px solid rgba(40,100,220,0.1); }
          .card { padding: 20px 16px; }
          .inputRow { flex-direction: column; }
          .btnPrimary { width: 100%; }
          .rbRow { flex-direction: column; }
          .rbLink { min-width: unset; }
          .rbRow .btn { width: 100%; }
          .bulkBtns { flex-direction: column; }
          .bulkBtns .btn { width: 100%; }
          .brDomain { flex: 0 0 100%; }
          .tab { padding: 8px 16px; font-size: 12.5px; }
          .analytics { padding: 8px 0 35px; }
          .analyticsGrid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
          .analyticsCard { padding: 16px 14px; }
          .analyticsNumber { font-size: 26px; }
          .trafficCard { grid-column: span 2; }
          .topLinksCard { grid-column: span 2; min-height: 170px; }
        }
        @media(max-width:400px) {
          .navLinks a:not(.navCta) { display: none; }
          .navAuth { padding: 7px 9px; font-size: 11px; }
          .heroH1 { font-size: 38px; }
          .authDialog { padding: 30px 22px; }
          .analyticsGrid { grid-template-columns: 1fr 1fr; }
          .analyticsCard { min-height: 145px; }
          .trafficCard,.topLinksCard { grid-column: span 2; }
          .trafficChart { gap: 5px; padding: 0 2px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .tilt3d { transform: none !important; transition: none !important; will-change: auto; }
          .analyticsCard,.trafficBar,.topLinkTrack span { transition: none !important; }
          .sparkline span { animation: none !important; }
        }
        @media (max-width: 640px) {
          .nav {
            gap: 8px;
            height: calc(64px + env(safe-area-inset-top));
            padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
          }
          .navBrand { min-width: 0; gap: 7px; font-size: clamp(14px, 4.2vw, 18px); white-space: nowrap; }
          .navLogo { width: 32px; height: 32px; flex: 0 0 32px; font-size: 16px; }
          .navLinks { min-width: 0; gap: 8px; }
          .navLinks > a:not(.navCta) { display: none; }
          .navAuth { min-height: 44px; padding: 8px 10px; }
          .navCta { min-height: 44px; padding: 8px 12px; }
          .wrap { width: 100%; padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
          .heroH1 { font-size: clamp(34px, 10vw, 48px); overflow-wrap: anywhere; }
          .heroSub { font-size: 14px; }
          .inputWrap input, .taWrap textarea, .authForm input { font-size: 16px; }
          .campaignFields input { font-size: 16px; }
          .btn, .navAuth, .rbX, .ghostBtn { touch-action: manipulation; }
          .btnSm, .btnGhost, .btnBlue { min-height: 44px; }
          .histRow { min-width: 0; flex-wrap: wrap; gap: 8px; padding: 12px; }
          .histLeft { flex: 1 1 calc(100% - 70px); min-width: 0; }
          .histCode { flex: 1 1 100%; order: 3; min-width: 0; overflow-wrap: anywhere; white-space: normal; line-height: 1.5; }
          .histRow > .btn { order: 2; }
          .bulkRow { min-width: 0; }
          .brShort { min-width: 0; overflow-wrap: anywhere; white-space: normal; }
          .footerTxt { padding-left: 8px; padding-right: 8px; line-height: 1.6; overflow-wrap: anywhere; }
          .authBackdrop { align-items: start; overflow-y: auto; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); }
          .authDialog { max-height: calc(100vh - 32px); max-height: calc(100dvh - max(32px, env(safe-area-inset-top) + env(safe-area-inset-bottom))); overflow-y: auto; overscroll-behavior: contain; }
        }
        @media (max-width: 400px) {
          .navCta { display: none; }
          .nav { padding-left: max(10px, env(safe-area-inset-left)); padding-right: max(10px, env(safe-area-inset-right)); }
          .wrap { padding-left: max(10px, env(safe-area-inset-left)); padding-right: max(10px, env(safe-area-inset-right)); }
          .card { padding: 18px 12px; }
          .campaignFields { grid-template-columns: minmax(0, 1fr); }
          .campaignFields label:last-child:nth-child(odd) { grid-column: auto; }
          .resultBox { padding: 16px 12px; }
          .analyticsCard { padding: 15px 12px; }
          .histTitle { font-size: 18px; }
        }
        @media (hover: none) {
          .btnPrimary:hover:not(:disabled), .btnBlue:hover, .analyticsCard:hover { transform: none; }
        }

        html[data-theme="light"] body { background: #f4f7fc; color: #24344d; }
        html[data-theme="light"] .bgRoot {
          background:
            radial-gradient(ellipse 80% 60% at 50% -10%, rgba(83,145,255,.12) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 90% 80%, rgba(158,105,240,.08) 0%, transparent 55%),
            #f4f7fc;
        }
        html[data-theme="light"] .bgMesh { opacity: .48; }
        html[data-theme="light"] .orb { opacity: .48; }
        html[data-theme="light"] .nav { background: rgba(255,255,255,.84); border-bottom-color: #e1e8f2; }
        html[data-theme="light"] .navBrand { color: #172844; }
        html[data-theme="light"] .navLinks a { color: #52647d; }
        html[data-theme="light"] .navLinks a:hover { color: #172844; }
        html[data-theme="light"] .navAuth { color: #345b91; background: #f4f8ff; border-color: #d7e3f4; }
        html[data-theme="light"] .navAuth:hover { color: #174c9c; background: #eaf2ff; border-color: #a9c5ed; }
        html[data-theme="light"] .navUser { color: #52647d; }
        html[data-theme="light"] .navTheme {
          min-height: 38px; padding: 0 11px; border: 1px solid #d7e3f4; border-radius: 9px;
          color: #345b91; background: #f4f8ff; font: 600 12px 'Inter',sans-serif; cursor: pointer;
          white-space: nowrap; transition: background .2s, border-color .2s;
        }
        html[data-theme="light"] .navTheme:hover { background: #eaf2ff; border-color: #a9c5ed; }
        .navTheme {
          min-height: 38px; padding: 0 11px; border: 1px solid rgba(80,150,255,.24); border-radius: 9px;
          color: #9ccaff; background: rgba(20,50,100,.32); font: 600 12px 'Inter',sans-serif;
          cursor: pointer; white-space: nowrap; transition: background .2s, border-color .2s;
        }
        .navTheme:hover { background: rgba(40,90,170,.35); border-color: rgba(80,150,255,.55); }
        html[data-theme="light"] .heroH1 { color: #172844; }
        html[data-theme="light"] .hero3dText {
          background: none;
          -webkit-text-fill-color: #172844;
          background-clip: border-box;
          transform: none;
          filter: none;
          text-shadow: none;
          transition: transform .24s cubic-bezier(.2,.8,.2,1), filter .24s ease, text-shadow .24s ease;
        }
        html[data-theme="light"] .heroSub { color: #52647d; }
        html[data-theme="light"] .chip { color: #526b8b; background: #fff; border-color: #e0e8f3; }
        html[data-theme="light"] .pill { color: #2861a1; background: #eaf3ff; border-color: #d3e5ff; }
        html[data-theme="light"] .statsStrip { background: rgba(255,255,255,.76); border-color: #e2e9f3; box-shadow: 0 14px 36px rgba(29,54,91,.08); }
        html[data-theme="light"] .sStat { border-right-color: #e6edf5; }
        html[data-theme="light"] .sLbl { color: #667995; }
        html[data-theme="light"] .analyticsCard { background: linear-gradient(145deg,#fff,#f7faff); border-color: #e1e9f4; box-shadow: 0 10px 26px rgba(29,54,91,.07); }
        html[data-theme="light"] .analyticsClicks { background: radial-gradient(ellipse at 95% 0%, rgba(35,120,250,.08), transparent 60%), linear-gradient(145deg,#fff,#f7faff); }
        html[data-theme="light"] .analyticsTitle,
        html[data-theme="light"] .sectTitle { color: #1d304b; }
        html[data-theme="light"] .analyticsCardTop,
        html[data-theme="light"] .analyticsMessage,
        html[data-theme="light"] .trafficLabel,
        html[data-theme="light"] .analyticsFoot,
        html[data-theme="light"] .analyticsPeriod { color: #657894; }
        html[data-theme="light"] .analyticsNumber { color: #263d5c; }
        html[data-theme="light"] .trafficTrack { border-bottom-color: #e3eaf3; background: linear-gradient(180deg,transparent,#edf3fb); }
        html[data-theme="light"] .tabs { background: rgba(255,255,255,.8); border-color: #e0e8f2; }
        html[data-theme="light"] .tab { color: #657894; }
        html[data-theme="light"] .tab:hover:not(.on) { color: #27466f; background: #edf3fb; }
        html[data-theme="light"] .card { background: rgba(255,255,255,.94); border-color: #e0e8f2; box-shadow: 0 18px 48px rgba(29,54,91,.13); }
        html[data-theme="light"] .tilt3d.isTilted { box-shadow: 0 28px 54px rgba(34,71,125,.22), 0 0 0 1px rgba(55,125,230,.16); }
        html[data-theme="light"] .featCard.isTilted { box-shadow: 0 24px 48px rgba(34,71,125,.2), 0 0 0 1px rgba(55,125,230,.14); }
        html[data-theme="light"] .hc { box-shadow: 0 28px 62px rgba(39,91,164,.34), 0 0 0 1px rgba(55,125,230,.22), 0 0 55px rgba(66,135,255,.2); }
        html[data-theme="light"] .cardTag { color: #617693; background: #edf3fb; }
        html[data-theme="light"] .inputWrap,
        html[data-theme="light"] .campaignPanel,
        html[data-theme="light"] .campaignFields input,
        html[data-theme="light"] .taWrap textarea,
        html[data-theme="light"] .authForm input { background: #f7f9fd; border-color: #dce5f1; color: #263d5c; }
        html[data-theme="light"] .inputWrap input { color: #263d5c; }
        html[data-theme="light"] .inputWrap input::placeholder,
        html[data-theme="light"] .taWrap textarea::placeholder,
        html[data-theme="light"] .campaignFields input::placeholder,
        html[data-theme="light"] .authForm input::placeholder { color: #8a9ab0; }
        html[data-theme="light"] .campaignPanel summary { color: #315b91; }
        html[data-theme="light"] .campaignPanel summary span,
        html[data-theme="light"] .campaignHelp,
        html[data-theme="light"] .campaignFields label { color: #657894; }
        html[data-theme="light"] .hint,
        html[data-theme="light"] .taMeta,
        html[data-theme="light"] .ghostBtn,
        html[data-theme="light"] .bulkListHdr { color: #71829b; }
        html[data-theme="light"] .btnGhost { background: #edf3fb; color: #345b91; border-color: #d9e4f2; }
        html[data-theme="light"] .resultBox { background: #f5fbf8; border-color: #ccebd9; box-shadow: 0 12px 34px rgba(29,54,91,.08); }
        html[data-theme="light"] .rbX { background: #e8eef6; color: #52647d; }
        html[data-theme="light"] .rbX:hover { background: #dce6f2; color: #263d5c; }
        html[data-theme="light"] .rbLink { background: #fff; border-color: #e0e8f2; }
        html[data-theme="light"] .rbSrc { color: #657894; }
        html[data-theme="light"] .qrBox { background: #fff; border-color: #e0e8f2; }
        html[data-theme="light"] .bulkRow,
        html[data-theme="light"] .histRow,
        html[data-theme="light"] .histEmpty { background: rgba(255,255,255,.8); border-color: #e0e8f2; }
        html[data-theme="light"] .brDomain,
        html[data-theme="light"] .histDomain { color: #526b8b; }
        html[data-theme="light"] .brShort,
        html[data-theme="light"] .histCode { color: #1474be; }
        html[data-theme="light"] .histCode { background: #edf3fb; }
        html[data-theme="light"] .linkAnalytics { background: rgba(255,255,255,.9); border-color: #e0e8f2; }
        html[data-theme="light"] .linkAnalyticsTop { color: #293e5d; }
        html[data-theme="light"] .linkAnalyticsTop span,
        html[data-theme="light"] .linkTrafficLabel { color: #71829b; }
        html[data-theme="light"] .linkTrafficTrack { border-bottom-color: #e3eaf3; background: linear-gradient(180deg,transparent,#edf3fb); }
        html[data-theme="light"] .histTitle,
        html[data-theme="light"] .featName { color: #293e5d; }
        html[data-theme="light"] .histTime,
        html[data-theme="light"] .sectTag,
        html[data-theme="light"] .footerTxt,
        html[data-theme="light"] .footerNav a,
        html[data-theme="light"] .featDesc { color: #71829b; }
        html[data-theme="light"] .featCard { background: rgba(255,255,255,.85); border-color: #e0e8f2; }
        html[data-theme="light"] .footer { border-top-color: #e0e8f2; }
        html[data-theme="light"] .authBackdrop { background: rgba(30,45,68,.38); }
        html[data-theme="light"] .authDialog { background: #fff; border-color: #dfe7f1; box-shadow: 0 28px 90px rgba(29,54,91,.22); }
        html[data-theme="light"] .authDialog h2 { color: #1d304b; }
        html[data-theme="light"] .authIntro,
        html[data-theme="light"] .authSwitch,
        html[data-theme="light"] .authForm label { color: #657894; }
        html[data-theme="light"] .authClose { color: #657894; }
        html[data-theme="light"] .authForgot { color: #2f6fd1; }
        html[data-theme="light"] ::-webkit-scrollbar-thumb { background: #bdcce0; }
        @media (max-width: 600px) {
          .navTheme { padding: 0 8px; font-size: 11px; }
        }
        @media (max-width: 400px) {
          .navBrand { gap: 8px; font-size: 16px; }
          .navLogo { width: 32px; height: 32px; font-size: 16px; }
          .navLinks { gap: 6px; }
          .navAuth { padding: 7px 9px; font-size: 12px; }
          .navTheme { min-height: 36px; padding: 0 7px; font-size: 11px; }
        }

        /* ═══════════════════════════════════════════════
           LAYOUT FIXES (all widths)
        ═══════════════════════════════════════════════ */
        /* Let the campaign panel drop onto its own full-width line instead of overflowing the card. */
        .inputRow { flex-wrap: wrap; }
        .inputWrap { flex: 1 1 260px; min-width: 0; }
        .campaignPanel summary { min-height: 24px; }

        /* Nav: never squash the brand or wrap button labels; shed secondary items as space runs out. */
        .navLinks { min-width: 0; }
        .navAuth, .navCta { white-space: nowrap; }
        @media (min-width: 641px) {
          /* Phones keep their tighter rules from the 640px block above. */
          .nav { gap: 16px; }
          .navBrand { flex-shrink: 0; white-space: nowrap; }
        }
        @media (max-width: 1100px) {
          .navLinks { gap: 16px; }
          .navUser { display: none; }
        }
        @media (max-width: 960px) {
          .navLinks > a:not(.navCta) { display: none; }
          .navLinks { gap: 10px; }
        }
        /* On phones the URL box is right below the hero, so "Try Now" isn't needed. */
        @media (max-width: 480px) {
          .navCta { display: none; }
        }
        @media (max-width: 360px) {
          /* Icon-only theme toggle; the button keeps its aria-label. */
          .navThemeLabel { display: none; }
          .navTheme { min-width: 40px; justify-content: center; font-size: 14px; }
          .navBrand { font-size: 14px; gap: 6px; }
          .navLogo { width: 30px; height: 30px; flex-basis: 30px; font-size: 15px; }
        }
        @media (max-width: 340px) {
          .navBrand { font-size: 12.5px; gap: 5px; }
          .navLinks { gap: 5px; }
        }

        .navThemeLabel { margin-left: 4px; }
        .histMore { display: flex; width: 100%; justify-content: center; margin-top: 10px; }
        @media (max-width: 640px) {
          /* Phone history rows: domain, then the short link, then the buttons side by side. */
          .histCode { order: 2; }
          .histRow > .btn { order: 3; flex: 1 1 0; justify-content: center; }
        }

        /* Readable minimum sizes for small labels. */
        .sLbl { font-size: 11px; }
        .analyticsFoot { font-size: 11px; }
        .analyticsPeriod { font-size: 10px; }
        .trafficLabel { font-size: 10.5px; }

        /* Touch screens: 44px-tall tap targets. */
        @media (pointer: coarse) {
          .tab { min-height: 44px; }
          .campaignPanel summary { min-height: 44px; }
          .rbX { width: 44px; height: 44px; }
          .ghostBtn { min-height: 44px; padding: 0 10px; }
          .navAuth, .navTheme { min-height: 44px; display: inline-flex; align-items: center; }
          .authClose { width: 44px; height: 44px; }
          .authSwitch button, .authForgot { min-height: 44px; padding: 0 8px; }
        }
        @media (pointer: coarse) and (min-width: 481px) {
          .navCta { display: inline-flex; align-items: center; min-height: 44px; }
        }

        /* Short landscape screens (phones turned sideways): keep the dialog scrollable. */
        @media (max-height: 520px) {
          .authBackdrop { align-items: start; overflow-y: auto; padding: 12px; }
          .authDialog { max-height: calc(100dvh - 24px); overflow-y: auto; }
        }

        /* Narrow phones down to 280px (folded Galaxy Fold): inputs and the campaign panel must
           shrink below the browser's default input width, and the summary text may wrap. */
        @media (max-width: 640px) {
          .inputWrap { flex: 0 0 auto; width: 100%; }
          .inputWrap input { width: 100%; }
          .campaignPanel { width: 100%; }
          .campaignPanel summary { flex-wrap: wrap; row-gap: 2px; }
        }
        @media (max-width: 340px) {
          /* Small enough that "possibilities." fits on one line instead of breaking mid-word. */
          .heroH1 { font-size: 10vw; letter-spacing: -1.5px; }
        }
        @media (max-width: 300px) {
          .navBrand { font-size: 11px; gap: 4px; }
          .navLogo { width: 26px; height: 26px; flex-basis: 26px; font-size: 13px; }
          .navLinks { gap: 4px; }
          .navAuth { padding: 6px 7px; font-size: 11px; }
          .navTheme { min-width: 36px; padding: 0 6px; }
        }

        /* Large screens: line the nav up with the content column, then scale the whole page up
           so 2K/4K monitors don't show a small strip in the middle. */
        @media (min-width: 641px) {
          .nav {
            padding-left: max(6%, calc((100% - 1120px) / 2 + 28px));
            padding-right: max(6%, calc((100% - 1120px) / 2 + 28px));
          }
        }
        @media (min-width: 1800px) { body { zoom: 1.15; } }
        @media (min-width: 2200px) { body { zoom: 1.35; } }
        @media (min-width: 3000px) { body { zoom: 1.8; } }

        /* Reduced motion: stop every animation and transition, not only the tilt effects. */
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>

      {/* ── BG layers ── */}
      <div className="bgRoot" />
      <div className="bgMesh" />
      <div className="orb orb1" />
      <div className="orb orb2" />
      <div className="orb orb3" />
      <ParticleCanvas />

      {/* ── Navbar ── */}
      <nav className="nav">
        <a href="/" className="navBrand">
          <div className="navLogo">🔗</div>
          LinkShortener
        </a>
        <div className="navLinks">
          <a href="#features">Features</a>
          <a href="#history">History</a>
          {user
            ? <><span className="navUser" title={user.email}>{user.email}</span><button className="navAuth" onClick={signOut}>Sign out</button></>
            : <button className="navAuth" onClick={() => { setAuthNotice(""); setAuthMode("login"); setAuthOpen(true); }}>Sign in</button>}
          <button className="navTheme" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-pressed={theme === "light"}>
            {theme === "dark" ? "☀" : "☾"}<span className="navThemeLabel">{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          <a href="#single-url-input" className="navCta">Try Now ↗</a>
        </div>
      </nav>

      {/* ── App root ── */}
      <div className="appRoot" ref={interactiveRef}>
        <div className="wrap">

          {/* ── Hero ── */}
          <section className="hero">
            <div className="heroLeft">
              <div className="pill">
                <div className="pillDot" />
                Free · Click analytics · Account optional
              </div>
              <h1 className="heroH1">
                <span
                  className="hero3dText"
                  onMouseEnter={event => setHeroTextHover(event.currentTarget, true)}
                  onMouseLeave={event => setHeroTextHover(event.currentTarget, false)}
                >Short links.</span><br />
                <span className="line2">Big possibilities.</span>
              </h1>
              <p className="heroSub">
                Turn long, messy URLs into clean, memorable links in one click.
                Now with <strong>bulk mode</strong> — shorten up to 20 URLs at once,
                export CSV, and generate QR codes instantly.
              </p>
              <div className="heroChips">
                <span className="chip">⚡ Instant</span>
                <span className="chip">📦 Bulk ready</span>
                <span className="chip">📱 QR codes</span>
                <span className="chip">🕐 History saved</span>
              </div>
            </div>
            <HeroCard />
          </section>

          {/* ── Stats strip ── */}
          <div className="statsStrip">
            {[
              { n: stats ? stats.total_links.toLocaleString() : "—", l: "Links created" },
              { n: stats ? stats.total_clicks.toLocaleString() : "—", l: "Total clicks" },
              { n: history.length, l: "Your Links" },
              { n: stats ? stats.total_users.toLocaleString() : "—", l: "Users" },
            ].map((s, i) => (
              <div className="sStat tilt3d" key={i}>
                <span className="sNum">{s.n}</span>
                <span className="sLbl">{s.l}</span>
              </div>
            ))}
          </div>

          <StatsPanel stats={stats} error={statsError} />

          {/* ── Tabs ── */}
          <div className="tabs" role="tablist">
            {[["single", "Single URL", false], ["bulk", "Bulk URLs", true]].map(([k, lbl, isNew]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)} id={`tab-${k}`}>
                {lbl}{isNew && <span className="newTag">NEW</span>}
              </button>
            ))}
          </div>

          {/* ── Shortener ── */}
          {tab === "single" ? <Single onNew={addToHistory} token={token} /> : <Bulk onNew={addToHistory} token={token} />}

          {/* ── History ── */}
          <History key={token} history={history} onClear={clearHistory} canClear={!user} token={token} />

          {/* ── Features ── */}
          <section className="feats" id="features">
            <div className="sectTag">Why LinkShortener?</div>
            <h2 className="sectTitle">Packed with everything you need</h2>
            <div className="featsGrid">
              {[
                { i: "⚡", n: "Instant Shortening", d: "Links are created in milliseconds — no queues, no delays." },
                { i: "📦", n: "Bulk Mode", d: "Paste up to 20 URLs at once. Progress bar + CSV export included." },
                { i: "📱", n: "QR Codes", d: "Every link gets a QR code, ready to scan or download." },
                { i: "🕐", n: "Synced Link History", d: "Sign in to see links saved to your account across devices." },
                { i: "🔒", n: "Secure Accounts", d: "Passwords are securely hashed, and sessions can be revoked at sign-out." },
                { i: "🐳", n: "Cloud & Docker Ready", d: "Runs on Render with PostgreSQL, or locally as three Docker containers." },
              ].map((f, i) => (
                <div className="featCard tilt3d" key={i}>
                  <span className="featIco">{f.i}</span>
                  <div className="featName">{f.n}</div>
                  <div className="featDesc">{f.d}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Footer ── */}
          <footer className="footer">
            <div className="footerTxt">Built with <span className="heart">♥</span> · LinkShortener — Free URL Shortener</div>
            <nav className="footerNav">
              <a href="#features">Features</a>
              <a href="#history">History</a>
              <a href="https://github.com/DAZYY-07/LinkShortner" target="_blank" rel="noopener noreferrer">GitHub</a>
            </nav>
          </footer>

        </div>
      </div>
      {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onAuthenticated={handleAuthenticated} initialNotice={authNotice} initialMode={authMode} resetToken={resetToken} />}
    </>
  );
}