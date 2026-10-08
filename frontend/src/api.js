// Shared helpers for talking to the backend and formatting values.

export const API = import.meta.env.VITE_API_URL !== undefined && import.meta.env.VITE_API_URL !== ""
  ? import.meta.env.VITE_API_URL
  : (import.meta.env.DEV ? "" : "https://linkshortner-backend-uwgj.onrender.com");

export function requestHeaders(token, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Call the API. Never throws: a network failure comes back as { ok: false, status: 0 }. */
export async function apiRequest(path, { token, method = "GET", body } = {}) {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: requestHeaders(token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON body */ }
    return { ok: response.ok, status: response.status, data, headers: response.headers };
  } catch {
    return { ok: false, status: 0, data: { detail: "Unable to reach the server. Please try again." }, headers: new Headers() };
  }
}

/** A readable message from a failed API result (handles FastAPI's validation error lists too). */
export function errorMessage(result, fallback = "Something went wrong. Please try again.") {
  const detail = result?.data?.detail;
  if (Array.isArray(detail)) return detail.map(item => item.msg).join(" ") || fallback;
  return typeof detail === "string" && detail ? detail : fallback;
}

/** Short links are /site/code (or the older /?r=code); read the code out of the address bar path. */
export function codeFromPath(pathname) {
  const match = pathname.match(/^\/([a-z0-9-]{1,40})\/([A-Za-z0-9-]{3,30})\/?$/i);
  return match ? match[2] : "";
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

export function fmtDateTime(value) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function regionName(code) {
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code; } catch { return code; }
}

export function qrUrl(text) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(text)}&bgcolor=050916&color=60d0ff&margin=12`;
}

export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function downloadQr(text) {
  // The QR image is cross-origin, so the <a download> attribute is ignored; fetch it as a blob instead.
  try {
    const response = await fetch(qrUrl(text));
    if (!response.ok) throw new Error("QR download failed");
    saveBlob(await response.blob(), "qr.png");
  } catch {
    window.open(qrUrl(text), "_blank", "noopener");
  }
}

/** Download a file from an authenticated endpoint (a plain link can't send the Authorization header). */
export async function downloadFromApi(path, token, filename) {
  const response = await fetch(`${API}${path}`, { headers: requestHeaders(token) });
  if (!response.ok) throw new Error("Download failed");
  saveBlob(await response.blob(), filename);
}
