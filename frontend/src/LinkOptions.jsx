import "./dashboard.css";

function Field({ id, label, hint, wide, children }) {
  return (
    <div className={`optField${wide ? " optWide" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function LinkOptionsFields({ values, onChange, editing = false, hasPassword = false, idPrefix = "opt" }) {
  const set = field => event => onChange({ ...values, [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value });
  return (
    <div className="optFields">
      <Field id={`${idPrefix}-alias`} label={editing ? "Short code / alias" : "Custom alias"}
        hint={`3–30 letters, numbers or hyphens${editing ? ". Changing it stops the old short link from working." : ""}`}>
        <input id={`${idPrefix}-alias`} value={values.alias} onChange={set("alias")} placeholder="my-sale" maxLength={30} autoComplete="off" spellCheck={false} />
      </Field>
      <Field id={`${idPrefix}-expires`} label="Expires on" hint="Leave empty for no expiry">
        <input id={`${idPrefix}-expires`} type="datetime-local" value={values.expires} onChange={set("expires")} />
      </Field>
      <Field id={`${idPrefix}-max`} label="Maximum clicks" hint="The link stops working after this many clicks">
        <input id={`${idPrefix}-max`} type="number" min="1" max="10000000" inputMode="numeric" value={values.maxClicks} onChange={set("maxClicks")} placeholder="Unlimited" />
      </Field>
      <Field id={`${idPrefix}-redirect`} label="Redirect type" hint="Browsers remember 301s, so later edits and clicks may be missed">
        <select id={`${idPrefix}-redirect`} value={values.redirectType} onChange={set("redirectType")}>
          <option value="302">302 Temporary (recommended)</option>
          <option value="301">301 Permanent</option>
        </select>
      </Field>
      <Field id={`${idPrefix}-folder`} label="Folder">
        <input id={`${idPrefix}-folder`} value={values.folder} onChange={set("folder")} placeholder="Campaigns" maxLength={40} autoComplete="off" />
      </Field>
      <Field id={`${idPrefix}-tags`} label="Tags" hint="Separate with commas">
        <input id={`${idPrefix}-tags`} value={values.tags} onChange={set("tags")} placeholder="promo, newsletter" autoComplete="off" />
      </Field>
      <Field id={`${idPrefix}-password`} wide label={editing && hasPassword ? "New password" : "Password protection"}>
        <input id={`${idPrefix}-password`} type="password" value={values.password} onChange={set("password")} minLength={4} maxLength={128}
          placeholder={editing && hasPassword ? "Leave empty to keep the current password" : "Optional: visitors must enter it"} autoComplete="new-password" />
        {editing && hasPassword && (
          <span className="optCheck">
            <input type="checkbox" checked={values.removePassword} onChange={set("removePassword")} id={`${idPrefix}-removepw`} />
            <label htmlFor={`${idPrefix}-removepw`}>Remove the password</label>
          </span>
        )}
      </Field>
    </div>
  );
}
