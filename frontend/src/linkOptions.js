/** Optional settings for a link: used when creating one and when editing one. */
export const EMPTY_OPTIONS = {
  alias: "", expires: "", maxClicks: "", redirectType: "302", password: "", removePassword: false, folder: "", tags: "",
};

export function parseTags(text) {
  return [...new Set(String(text).split(",").map(tag => tag.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean))];
}

/** ISO timestamp -> the value a <input type="datetime-local"> expects, in the visitor's timezone. */
export function toLocalInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Build the POST /shorten body for the options (only the ones that were filled in). */
export function optionsToPayload(options) {
  const payload = {};
  if (options.alias.trim()) payload.alias = options.alias.trim();
  if (options.expires) payload.expires_at = new Date(options.expires).toISOString();
  if (options.maxClicks !== "") payload.max_clicks = Number(options.maxClicks);
  if (options.redirectType !== "302") payload.redirect_type = Number(options.redirectType);
  if (options.password) payload.password = options.password;
  if (options.folder.trim()) payload.folder = options.folder.trim();
  const tags = parseTags(options.tags);
  if (tags.length) payload.tags = tags;
  return payload;
}
