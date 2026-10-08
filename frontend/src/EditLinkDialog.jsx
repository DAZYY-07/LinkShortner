import { useEffect, useRef, useState } from "react";
import "./dashboard.css";
import { apiRequest, errorMessage } from "./api.js";
import LinkOptionsFields from "./LinkOptions.jsx";
import { parseTags, toLocalInput } from "./linkOptions.js";

/** Edit one link. Only the fields that changed are sent. */
export default function EditLinkDialog({ link, token, onClose, onSaved }) {
  const [url, setUrl] = useState(link.original_url);
  const [options, setOptions] = useState({
    alias: link.short_code,
    expires: toLocalInput(link.expires_at),
    maxClicks: link.max_clicks ?? "",
    redirectType: String(link.redirect_type),
    password: "",
    removePassword: false,
    folder: link.folder || "",
    tags: link.tags.join(", "),
  });
  const [active, setActive] = useState(link.is_active);
  const [archived, setArchived] = useState(link.is_archived);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = event => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (event) => {
    event.preventDefault();
    const patch = {};
    if (url.trim() !== link.original_url) patch.url = url.trim();
    if (options.alias.trim() !== link.short_code) patch.alias = options.alias.trim();
    if (options.expires !== toLocalInput(link.expires_at)) patch.expires_at = options.expires ? new Date(options.expires).toISOString() : null;
    if (String(options.maxClicks) !== String(link.max_clicks ?? "")) patch.max_clicks = options.maxClicks === "" ? null : Number(options.maxClicks);
    if (Number(options.redirectType) !== link.redirect_type) patch.redirect_type = Number(options.redirectType);
    if (options.removePassword) patch.password = null;
    else if (options.password) patch.password = options.password;
    if ((options.folder.trim() || null) !== (link.folder || null)) patch.folder = options.folder.trim() || null;
    const tags = parseTags(options.tags);
    if (tags.join(",") !== link.tags.join(",")) patch.tags = tags.length ? tags : null;
    if (active !== link.is_active) patch.is_active = active;
    if (archived !== link.is_archived) patch.is_archived = archived;

    if (Object.keys(patch).length === 0) { onClose(); return; }
    setBusy(true); setError("");
    const result = await apiRequest(`/my-links/${encodeURIComponent(link.short_code)}`, { token, method: "PATCH", body: patch });
    setBusy(false);
    if (!result.ok) { setError(errorMessage(result)); return; }
    onSaved(result.data);
  };

  return (
    <div className="modalBackdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={save}>
        <div className="modalHead">
          <h2 id="edit-title">Edit link</h2>
          <button type="button" className="modalClose" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="optField">
          <label htmlFor="edit-url">Destination URL</label>
          <input id="edit-url" ref={first} type="url" value={url} onChange={event => { setUrl(event.target.value); setError(""); }} required autoComplete="off" />
          <small>People using <b>{link.short_code}</b> will be sent here. The short link stays the same.</small>
        </div>
        <LinkOptionsFields values={options} onChange={next => { setOptions(next); setError(""); }} editing hasPassword={link.has_password} idPrefix="edit" />
        <div className="optToggles">
          <span className="optCheck">
            <input id="edit-active" type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />
            <label htmlFor="edit-active">Link is active (turn off to stop redirecting)</label>
          </span>
          <span className="optCheck">
            <input id="edit-archived" type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />
            <label htmlFor="edit-archived">Archived (hidden from the main list; still works)</label>
          </span>
        </div>
        {error && <div className="errBox" role="alert">⚠ {error}</div>}
        <div className="modalActions">
          <button type="button" className="btn btnGhost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btnBlue" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </div>
  );
}
