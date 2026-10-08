import { useEffect, useState } from "react";
import "./dashboard.css";
import { apiRequest, downloadFromApi, errorMessage, regionName } from "./api.js";

const RANGES = [7, 30, 90];

function DailyChart({ days }) {
  const max = Math.max(1, ...days.map(day => day.clicks));
  const compact = days.length > 14; // too many bars for a number above each one
  return (
    <div className={`aChart${compact ? " aChartCompact" : ""}`} role="img" aria-label={`Clicks per day over the last ${days.length} days`}>
      {days.map((day, index) => {
        const date = new Date(`${day.date}T12:00:00`);
        const showLabel = !compact || index === 0 || index === days.length - 1 || index === Math.floor(days.length / 2);
        return (
          <div className="aDay" key={day.date} title={`${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${day.clicks} click${day.clicks === 1 ? "" : "s"}`}>
            <span className="aCount">{compact ? "" : day.clicks}</span>
            <div className="aTrack"><span style={{ height: `${Math.max(day.clicks ? 8 : 3, (day.clicks / max) * 100)}%` }} /></div>
            <span className="aLabel">
              {showLabel ? (compact ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : date.toLocaleDateString(undefined, { weekday: "short" })) : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BarList({ title, items, format = name => name }) {
  const total = items.reduce((sum, item) => sum + item.clicks, 0);
  return (
    <section className="aCard" aria-label={title}>
      <h4>{title}</h4>
      {items.length === 0 ? <p className="aEmpty">No data yet</p> : (
        <ul>
          {items.map(item => (
            <li key={item.name}>
              <div className="aRowTop"><span title={format(item.name)}>{format(item.name)}</span><strong>{item.clicks.toLocaleString()}</strong></div>
              <div className="aBar"><span style={{ width: `${Math.max(4, (item.clicks / total) * 100)}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const countryLabel = name => (/^[A-Z]{2}$/.test(name) ? regionName(name) : name);

export default function LinkAnalytics({ code, token }) {
  const [days, setDays] = useState(7);
  const requestKey = `${code}:${days}`;
  // Results remember which request they answer, so "loading" is simply "not the latest request yet".
  const [state, setState] = useState({ key: "", error: "", data: null });
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest(`/my-links/${encodeURIComponent(code)}/analytics?days=${days}`, { token }).then(result => {
      if (cancelled) return;
      setState(result.ok
        ? { key: requestKey, error: "", data: result.data }
        : { key: requestKey, error: errorMessage(result, "Unable to load link analytics."), data: null });
    });
    return () => { cancelled = true; };
  }, [code, days, token, requestKey]);

  const exportCsv = async () => {
    setExportError("");
    try { await downloadFromApi(`/my-links/${encodeURIComponent(code)}/analytics/export`, token, `${code}-analytics.csv`); }
    catch { setExportError("The export failed. Please try again."); }
  };

  const loading = state.key !== requestKey;
  const { data } = state;
  const error = loading ? "" : state.error;
  return (
    <div className="aPanel" aria-label={`Click analytics for ${code}`}>
      <div className="aTop">
        <div className="aTotals">
          <strong>{data ? data.total_clicks.toLocaleString() : "…"}</strong> total clicks
          {data && <span> · {data.period_clicks.toLocaleString()} in the last {days} days</span>}
        </div>
        <div className="aTools">
          <div className="aRanges" role="group" aria-label="Time range">
            {RANGES.map(range => (
              <button key={range} type="button" className={range === days ? "on" : ""} aria-pressed={range === days} onClick={() => setDays(range)}>{range}d</button>
            ))}
          </div>
          <button type="button" className="btn btnSm btnGhost" onClick={exportCsv} disabled={!data}>Export CSV ⤓</button>
        </div>
      </div>
      {exportError && <p className="aError" role="alert">{exportError}</p>}
      {error && <p className="aError" role="alert">{error}</p>}
      {loading && !data && <p className="aEmpty" role="status">Loading click analytics…</p>}
      {data && (
        <div className={loading ? "aBody aBusy" : "aBody"}>
          <DailyChart days={data.clicks_by_day} />
          {data.period_clicks === 0 && <p className="aEmpty">No clicks in this period yet. Share the link and check back.</p>}
          <div className="aGrid">
            <BarList title="Top referrers" items={data.referrers} />
            <BarList title="Countries" items={data.countries} format={countryLabel} />
            <BarList title="Devices" items={data.devices} />
            <BarList title="Browsers" items={data.browsers} />
            <BarList title="Operating systems" items={data.operating_systems} />
          </div>
        </div>
      )}
    </div>
  );
}
