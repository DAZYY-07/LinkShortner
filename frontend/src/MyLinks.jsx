import { useEffect, useMemo, useRef, useState } from "react";
import "./dashboard.css";
import { apiRequest, domainOf, downloadQr, errorMessage, fmtDateTime, qrUrl } from "./api.js";
import EditLinkDialog from "./EditLinkDialog.jsx";
import LinkAnalytics from "./LinkAnalytics.jsx";

const PAGE_SIZE = 20;
const DEFAULT_FILTERS = { q: "", status: "all", archived: "exclude", tag: "", folder: "", sort: "newest" };
const STATUS_LABEL = { active: "Active", disabled: "Disabled", expired: "Expired", limit_reached: "Limit reached" };

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function ConfirmDialog({ title, message, confirmLabel, busy, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = event => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="modalBackdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal modalSmall" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text">
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-text" className="modalText">{message}</p>
        <div className="modalActions">
          <button type="button" className="btn btnGhost" ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btnDanger" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default function MyLinks({ token, refreshKey, onChanged }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const debouncedQuery = useDebounced(filters.q);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState({ tags: [], folders: [] });
  const [selected, setSelected] = useState(() => new Set());
  const [analyticsFor, setAnalyticsFor] = useState("");
  const [qrFor, setQrFor] = useState("");
  const [menuFor, setMenuFor] = useState("");
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (filters.status !== "all") params.set("status", filters.status);
    params.set("archived", filters.archived);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.folder) params.set("folder", filters.folder);
    params.set("sort", filters.sort);
    params.set("limit", String(PAGE_SIZE));
    return params.toString();
  }, [debouncedQuery, filters.status, filters.archived, filters.tag, filters.folder, filters.sort]);

  // The list is "loading" until a response for the latest search and refresh arrives.
  const loadKey = `${query}|${refreshKey}`;
  const loading = loadedKey !== loadKey;

  useEffect(() => {
    let cancelled = false;
    apiRequest(`/my-links?${query}&offset=0`, { token }).then(result => {
      if (cancelled) return; // a newer search replaced this one
      setLoadedKey(loadKey);
      if (!result.ok) { setError(errorMessage(result, "Unable to load your links.")); return; }
      setError("");
      setTotal(Number(result.headers.get("X-Total-Count")) || result.data.length);
      setItems(result.data);
      setSelected(new Set());
    });
    return () => { cancelled = true; };
  }, [query, token, loadKey]);

  const loadMore = async () => {
    const shown = items.length;
    setLoadingMore(true);
    const result = await apiRequest(`/my-links?${query}&offset=${shown}`, { token });
    setLoadingMore(false);
    if (!result.ok) { setError(errorMessage(result, "Unable to load more links.")); return; }
    setTotal(Number(result.headers.get("X-Total-Count")) || total);
    // Ignore the page if the list was replaced (new search) while it was loading.
    setItems(current => (current.length === shown ? [...current, ...result.data] : current));
  };

  useEffect(() => {
    let cancelled = false;
    apiRequest("/my-links/filters", { token }).then(result => { if (!cancelled && result.ok) setChoices(result.data); });
    return () => { cancelled = true; };
  }, [token, refreshKey]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!menuFor) return undefined;
    const close = event => { if (!event.target.closest("[data-menu]")) setMenuFor(""); };
    const onKey = event => { if (event.key === "Escape") setMenuFor(""); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", onKey); };
  }, [menuFor]);

  const flash = (type, text) => setNotice({ type, text });
  const encoded = link => encodeURIComponent(link.short_code);

  const mutate = async (request, successText) => {
    const result = await request();
    if (!result.ok) { flash("error", errorMessage(result)); return false; }
    if (successText) flash("ok", successText);
    onChanged();
    return true;
  };
  const patch = (link, body, successText) => mutate(
    () => apiRequest(`/my-links/${encoded(link)}`, { token, method: "PATCH", body }), successText);
  const bulk = (action, codes, successText) => mutate(
    () => apiRequest("/my-links/bulk", { token, method: "POST", body: { action, codes } }), successText);

  const askDelete = (links) => {
    const many = links.length > 1;
    setConfirm({
      title: many ? `Delete ${links.length} links?` : "Delete this link?",
      message: many
        ? "These short links will stop working and their click history will be deleted. This can't be undone."
        : `${domainOf(links[0].original_url)} (${links[0].short_code}) will stop working and its click history will be deleted. This can't be undone.`,
      confirmLabel: many ? `Delete ${links.length} links` : "Delete link",
      run: () => bulk("delete", links.map(link => link.short_code), many ? `${links.length} links deleted.` : "Link deleted."),
    });
  };

  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1600); }
    catch { flash("error", "Couldn't copy to the clipboard."); }
  };

  const setFilter = changes => setFilters(current => ({ ...current, ...changes }));
  const filtersChanged = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);
  const selectedLinks = items.filter(link => selected.has(link.short_code));
  const allSelected = items.length > 0 && selectedLinks.length === items.length;
  const toggleOne = code => setSelected(current => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const runBulk = (action, text) => async () => { const done = await bulk(action, [...selected], text); if (done) setSelected(new Set()); };

  return (
    <section className="dash" id="history" aria-labelledby="dash-title">
      <div className="dHead">
        <h2 className="histTitle" id="dash-title">My Links</h2>
        <span className="dCount" aria-live="polite">{loading ? "Loading…" : `${total.toLocaleString()} link${total === 1 ? "" : "s"}`}</span>
      </div>

      <div className="dToolbar" role="search">
        <div className="dField dSearch">
          <label htmlFor="dash-search" className="srOnly">Search links</label>
          <input id="dash-search" type="search" value={filters.q} onChange={event => setFilter({ q: event.target.value })}
            placeholder="Search links, tags or folders…" autoComplete="off" />
        </div>
        <div className="dField">
          <label htmlFor="dash-show">Show</label>
          <select id="dash-show" value={filters.archived} onChange={event => setFilter({ archived: event.target.value })}>
            <option value="exclude">Active list</option>
            <option value="only">Archived</option>
            <option value="all">Everything</option>
          </select>
        </div>
        <div className="dField">
          <label htmlFor="dash-status">Status</label>
          <select id="dash-status" value={filters.status} onChange={event => setFilter({ status: event.target.value })}>
            <option value="all">Any status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="expired">Expired</option>
            <option value="limit_reached">Limit reached</option>
          </select>
        </div>
        <div className="dField">
          <label htmlFor="dash-folder">Folder</label>
          <select id="dash-folder" value={filters.folder} onChange={event => setFilter({ folder: event.target.value })}>
            <option value="">All folders</option>
            {choices.folders.map(folder => <option key={folder.name} value={folder.name}>{folder.name} ({folder.count})</option>)}
          </select>
        </div>
        <div className="dField">
          <label htmlFor="dash-tag">Tag</label>
          <select id="dash-tag" value={filters.tag} onChange={event => setFilter({ tag: event.target.value })}>
            <option value="">All tags</option>
            {choices.tags.map(tag => <option key={tag.name} value={tag.name}>#{tag.name} ({tag.count})</option>)}
          </select>
        </div>
        <div className="dField">
          <label htmlFor="dash-sort">Sort by</label>
          <select id="dash-sort" value={filters.sort} onChange={event => setFilter({ sort: event.target.value })}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="clicks">Most clicks</option>
            <option value="alias">Alias A–Z</option>
            <option value="expiring">Expiring soon</option>
          </select>
        </div>
        {filtersChanged && <button type="button" className="ghostBtn dClear" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button>}
      </div>

      {notice && <div className={`dNotice ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</div>}
      {error && <div className="errBox" role="alert">⚠ {error}</div>}

      {items.length > 0 && (
        <div className="dBulk">
          <span className="optCheck">
            <input id="dash-all" type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map(link => link.short_code)))} />
            <label htmlFor="dash-all">{selected.size ? `${selected.size} selected` : "Select all"}</label>
          </span>
          {selected.size > 0 && (
            <div className="dBulkActions" role="group" aria-label="Actions for selected links">
              {filters.archived === "only"
                ? <button type="button" className="btn btnSm btnGhost" onClick={runBulk("unarchive", "Links restored.")}>Unarchive</button>
                : <button type="button" className="btn btnSm btnGhost" onClick={runBulk("archive", "Links archived.")}>Archive</button>}
              <button type="button" className="btn btnSm btnGhost" onClick={runBulk("enable", "Links enabled.")}>Enable</button>
              <button type="button" className="btn btnSm btnGhost" onClick={runBulk("disable", "Links disabled.")}>Disable</button>
              <button type="button" className="btn btnSm btnDangerGhost" onClick={() => askDelete(selectedLinks)}>Delete</button>
            </div>
          )}
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <p className="dEmpty">
          {filtersChanged ? "No links match these filters." : "You haven't created any links yet. Paste a URL above to make your first one."}
          {filtersChanged && <> <button type="button" className="linkBtn" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button></>}
        </p>
      )}

      <div className="dList" aria-busy={loading}>
        {items.map(link => {
          const code = link.short_code;
          const isOpen = analyticsFor === code;
          return (
            <article className={`dRow${selected.has(code) ? " isSelected" : ""}${link.is_archived ? " isArchived" : ""}`} key={code}>
              <div className="dRowMain">
                <label className="dCheckWrap"><input type="checkbox" className="dCheck" checked={selected.has(code)} onChange={() => toggleOne(code)} aria-label={`Select ${code}`} /></label>
                <div className="dInfo">
                  <div className="dTitle">
                    <span className="dDomain" title={link.original_url}>{domainOf(link.original_url)}</span>
                    <span className={`sChip st-${link.status}`}>{STATUS_LABEL[link.status]}</span>
                    {link.has_password && <span className="sChip">🔒 Protected</span>}
                    {link.is_archived && <span className="sChip st-disabled">Archived</span>}
                    {link.redirect_type === 301 && <span className="sChip">301</span>}
                  </div>
                  <div className="dDest" title={link.original_url}>{link.original_url}</div>
                  <div className="dMeta">
                    <span>Created {fmtDateTime(link.created_at)}</span>
                    {link.expires_at && <span>{link.status === "expired" ? "Expired" : "Expires"} {fmtDateTime(link.expires_at)}</span>}
                    {link.max_clicks != null && <span>{link.clicks.toLocaleString()} of {link.max_clicks.toLocaleString()} clicks used</span>}
                    {link.folder && <button type="button" className="dFolder" onClick={() => setFilter({ folder: link.folder })} title="Show this folder">📁 {link.folder}</button>}
                  </div>
                  {link.tags.length > 0 && (
                    <div className="dTags">
                      {link.tags.map(tag => <button type="button" className="tagChip" key={tag} onClick={() => setFilter({ tag })} title={`Show #${tag}`}>#{tag}</button>)}
                    </div>
                  )}
                </div>
                <div className="dClicks"><strong>{link.clicks.toLocaleString()}</strong><span>click{link.clicks === 1 ? "" : "s"}</span></div>
              </div>

              <div className="dRowFoot">
                <a className="dShort" href={link.short_url} target="_blank" rel="noopener noreferrer">{link.short_url}</a>
                <div className="dButtons">
                  <button type="button" className={`btn btnSm ${isOpen ? "btnActive" : "btnGhost"}`} aria-expanded={isOpen} onClick={() => setAnalyticsFor(isOpen ? "" : code)}>Analytics</button>
                  <button type="button" className={`btn btnSm ${copied === code ? "btnGreen" : "btnGhost"}`} onClick={() => copy(link.short_url, code)}>{copied === code ? "✓ Copied" : "Copy"}</button>
                  <button type="button" className={`btn btnSm ${qrFor === code ? "btnActive" : "btnGhost"}`} aria-expanded={qrFor === code} onClick={() => setQrFor(qrFor === code ? "" : code)}>QR</button>
                  <button type="button" className="btn btnSm btnGhost" onClick={() => setEditing(link)}>Edit</button>
                  <button type="button" className="btn btnSm btnGhost dMore" data-menu aria-haspopup="menu" aria-expanded={menuFor === code} aria-label={`More actions for ${code}`}
                    onClick={() => setMenuFor(menuFor === code ? "" : code)}>⋯</button>
                </div>
              </div>

              {menuFor === code && (
                <div className="dMenu" role="menu" data-menu>
                  <button type="button" role="menuitem" onClick={() => { copy(link.direct_url, `${code}-direct`); setMenuFor(""); }}>Copy direct link (HTTP {link.redirect_type})</button>
                  <button type="button" role="menuitem" onClick={() => { patch(link, { is_active: !link.is_active }, link.is_active ? "Link disabled." : "Link enabled."); setMenuFor(""); }}>
                    {link.is_active ? "Disable link" : "Enable link"}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { patch(link, { is_archived: !link.is_archived }, link.is_archived ? "Link restored." : "Link archived."); setMenuFor(""); }}>
                    {link.is_archived ? "Unarchive" : "Archive"}
                  </button>
                  <button type="button" role="menuitem" className="danger" onClick={() => { askDelete([link]); setMenuFor(""); }}>Delete…</button>
                </div>
              )}

              {qrFor === code && (
                <div className="qrBox">
                  <img src={qrUrl(link.short_url)} alt={`QR code for ${link.short_url}`} className="qrImg" />
                  <a href={qrUrl(link.short_url)} download="qr.png" className="qrDl" onClick={event => { event.preventDefault(); downloadQr(link.short_url); }}>⤓ Download QR</a>
                </div>
              )}
              {isOpen && <LinkAnalytics code={code} token={token} />}
            </article>
          );
        })}
      </div>

      {items.length < total && (
        <button type="button" className="btn btnGhost dMoreBtn" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : `Show more (${(total - items.length).toLocaleString()} more)`}
        </button>
      )}

      {editing && (
        <EditLinkDialog link={editing} token={token} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash("ok", "Changes saved."); onChanged(); }} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} busy={confirmBusy} onCancel={() => setConfirm(null)}
          onConfirm={async () => { setConfirmBusy(true); await confirm.run(); setConfirmBusy(false); setConfirm(null); setSelected(new Set()); }} />
      )}
    </section>
  );
}
