import { requireStaff } from "@/lib/auth";
import { loadPeriod } from "@/lib/dashboard-data";
import { computeMetrics, type Metrics } from "@/lib/metrics";
import { periodsFor } from "@/lib/range";

export const metadata = { title: "Dashboard · Aangan Studio" };

const n0 = (x: number | null) => (x === null ? "—" : Math.round(x).toLocaleString("en-IN"));
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x)}%`);
const mins = (x: number | null) => (x === null ? "—" : x < 90 ? `${Math.round(x)} min` : `${(x / 60).toFixed(1)} h`);
const inr = (x: number | null) => (x === null ? "—" : `₹${x.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: x < 100 ? 2 : 0 })}`);

function Kpi({ label, value, prev, hint }: { label: string; value: string; prev?: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="vs">{prev !== undefined ? `previous: ${prev}` : ""}{hint ? ` ${hint}` : ""}</div>
    </div>
  );
}

function Bars({ items }: { items: { label: string; value: number; shown: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div>
      {items.map((i) => (
        <div key={i.label}>
          <div className="small" style={{ display: "flex", justifyContent: "space-between" }}><span>{i.label}</span><span className="muted">{i.shown}</span></div>
          <div className="bar"><span style={{ width: `${(100 * i.value) / max}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  const { sb } = await requireStaff();
  let periods;
  try { periods = periodsFor(new Date(), from, to); } catch { periods = periodsFor(new Date()); }
  const { data: settingRows } = await sb.from("settings").select("key, value, is_placeholder");
  const settings = Object.fromEntries((settingRows ?? []).map((r) => [r.key, r.value]));
  const placeholders = (settingRows ?? []).filter((r) => r.is_placeholder && /^(price_|monthly_hosting|baseline_)/.test(r.key)).map((r) => r.key);

  const [curRows, prevRows] = await Promise.all([loadPeriod(sb, periods.current, settings), loadPeriod(sb, periods.previous, settings)]);
  const m: Metrics = computeMetrics(curRows);
  const p: Metrics = computeMetrics(prevRows);
  const c = m.cost;
  const cls = m.classes;
  const iso = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">{periods.current.label} <span className="small">vs {periods.previous.label}</span></p>
      <form className="filters" method="get">
        <label>From<input type="date" name="from" defaultValue={from ?? iso(periods.current.from)} /></label>
        <label>To<input type="date" name="to" defaultValue={to ?? iso(new Date(periods.current.to.getTime() - 1))} /></label>
        <button>Apply</button>
        <a className="btn" href="/dashboard">This month vs last</a>
      </form>
      {placeholders.length > 0 && (
        <p className="banner">Cost figures use <b>placeholder unit prices</b> ({placeholders.length} still unset in Settings: {placeholders.slice(0, 4).join(", ")}…). Fill in the real rates to make the cost numbers true.</p>
      )}

      <h2>Speed (what moves conversion)</h2>
      <div className="grid">
        <Kpi label="Calls received" value={n0(m.callsReceived)} prev={n0(p.callsReceived)} />
        <Kpi label="Front desk alerted within 5 min" value={pct(m.pctAlertedWithin5Min)} prev={pct(p.pctAlertedWithin5Min)} />
        <Kpi label="After-hours calls captured" value={n0(m.afterHoursCaptured)} prev={n0(p.afterHoursCaptured)} hint={m.callsReceived ? `(${pct((100 * m.afterHoursCaptured) / m.callsReceived)} of calls)` : ""} />
        <Kpi label="Median: call to designer Accept" value={mins(m.medianMinToAccept)} prev={mins(p.medianMinToAccept)} />
        <Kpi label="Median: Telegram alert to Accept" value={mins(m.medianMinAlertToAccept)} prev={mins(p.medianMinAlertToAccept)} />
        <Kpi label="Callbacks made before promised time" value={pct(m.pctCallbacksOnTime)} prev={pct(p.pctCallbacksOnTime)} hint={`(${m.callbacksMeasured} measured)`} />
      </div>

      <h2>Leads</h2>
      <div className="grid">
        <Kpi label="Qualified leads" value={n0(m.qualified)} prev={n0(p.qualified)} />
        <Kpi label="Handed to a designer" value={n0(m.qualifiedHandedOff)} prev={n0(p.qualifiedHandedOff)} />
        <Kpi label="Consults booked on the call" value={pct(m.consultsBookedPct)} prev={pct(p.consultsBookedPct)} hint="of qualified" />
        <Kpi label="Consults completed / no-show" value={`${m.consultsCompleted} / ${m.consultsNoShow}`} prev={`${p.consultsCompleted} / ${p.consultsNoShow}`} />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <Bars items={[
          { label: "Qualified", value: cls.qualified, shown: String(cls.qualified) },
          { label: "Borderline", value: cls.borderline, shown: String(cls.borderline) },
          { label: "Not qualified", value: cls.not_qualified, shown: String(cls.not_qualified) },
          { label: "Not an enquiry (complaints etc.)", value: cls.other, shown: String(cls.other) },
          { label: "Unclassified (AI failed)", value: cls.unclassified, shown: String(cls.unclassified) },
        ]} />
      </div>

      <h2>Results (lags behind the above)</h2>
      <div className="grid">
        <Kpi label="Won / lost" value={`${m.won} / ${m.lost}`} prev={`${p.won} / ${p.lost}`} />
        <Kpi label="Conversion (won ÷ qualified)" value={pct(m.conversionPct)} prev={pct(p.conversionPct)} hint={m.baselineConversionPct !== null ? `· baseline ${pct(m.baselineConversionPct)}` : "· baseline not set"} />
        <Kpi label="Pipeline value (indicative)" value={`₹${m.pipeline.minLakh}–${m.pipeline.maxLakh} L`} prev={`₹${p.pipeline.minLakh}–${p.pipeline.maxLakh} L`} hint={`${m.qualified} × ₹${m.pipeline.range.min}–${m.pipeline.range.max} L`} />
      </div>

      <h2>What the system costs</h2>
      <div className="grid">
        <Kpi label="Total cost" value={inr(c.total)} prev={inr(p.cost.total)} hint={`incl. ${inr(c.hosting)} hosting`} />
        <Kpi label="Cost per call" value={inr(c.perCall)} prev={inr(p.cost.perCall)} />
        <Kpi label="Cost per qualified lead" value={inr(c.perQualified)} prev={inr(p.cost.perQualified)} />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <Bars items={[
          { label: "Voice (Vaani)", value: c.byService.vaani, shown: inr(c.byService.vaani) },
          { label: "AI classification", value: c.byService.llm, shown: inr(c.byService.llm) },
          { label: "SMS", value: c.byService.sms, shown: inr(c.byService.sms) },
          { label: "Telegram", value: c.byService.telegram, shown: inr(c.byService.telegram) },
          { label: "Hosting (prorated)", value: c.hosting, shown: inr(c.hosting) },
        ]} />
      </div>
    </>
  );
}
