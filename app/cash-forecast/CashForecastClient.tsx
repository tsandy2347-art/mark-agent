// Cash forecast client — the editable input form + summary ribbon + week table.
// Server component (page.tsx) computes the forecast and passes it in; this
// component handles typed input + save.

"use client";

import { useState } from "react";

type ForecastWeek = {
  weekNumber: number;
  weekEnding: string;
  openingBalance: number;
  totalInflows: number;
  totalOutflows: number;
  netFlow: number;
  closingBalance: number;
  belowMinimum: boolean;
  notes: string[];
};

type Forecast = {
  asOfDate: string;
  startingCash: number;
  minimumBalanceAlert: number;
  weeks: ForecastWeek[];
  summary: {
    lowestWeek: ForecastWeek | null;
    lowestBalance: number;
    weeksBelowMinimum: number;
    totalInflows13w: number;
    totalOutflows13w: number;
    endingBalance: number;
  };
};

export type FormValues = {
  westpacBalance: number;
  stGeorgeBalance: number;
  otherCashBalance: number;
  ndiaOutstanding: number;
  planManagerOutstanding: number;
  selfManagedOutstanding: number;
  hospitalsOutstanding: number;
  privateOutstanding: number;
  sahReceiptsMonthly: number;
  apOpenBalance: number;
  apWeeklyRun: number;
  atoArrearsBalance: number;
  atoMonthlyPaymentPlan: number;
  weeklyPayrollGross: number;
  weeklyEmployerSuper: number;
  weeklyPaygSc: number;
  monthlyPaygCq: number;
  minimumBalanceAlert: number;
  notes: string;
};

const aud = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const audSigned = (n: number) => `${n < 0 ? "-" : "+"}${aud(Math.abs(n))}`;

export function CashForecastClient({
  initialForm,
  initialForecast,
  hasInput,
  savedBy,
}: {
  initialForm: FormValues;
  initialForecast: Forecast | null;
  hasInput: boolean;
  savedBy: string | null;
}) {
  const [editing, setEditing] = useState(!hasInput);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormValues>(initialForm);

  const set =
    (key: keyof FormValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const v = e.target.value;
      setForm((f) => ({ ...f, [key]: key === "notes" ? v : v === "" ? 0 : Number(v) }));
    };

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/cash-forecast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "save failed");
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const f = initialForecast;
  const totalCash = form.westpacBalance + form.stGeorgeBalance + form.otherCashBalance;
  const totalAr =
    form.ndiaOutstanding +
    form.planManagerOutstanding +
    form.selfManagedOutstanding +
    form.hospitalsOutstanding +
    form.privateOutstanding;

  return (
    <main className="container">
      <h1>13-week cash forecast</h1>
      <p className="muted">
        Honest read on where cash lands week-by-week. Bank balances are typed in by you — Xero&apos;s
        bank summary shows the reconciled balance, not live cash, so it&apos;s wrong for forecasting.
        Money owed is entered by debtor type, because Xero due dates don&apos;t reflect real NDIS/SaH
        payment cycles. Red = a week that closes below your floor.
        {savedBy ? <> · Last saved by <strong>{savedBy}</strong>.</> : null}
      </p>

      {/* Summary ribbon */}
      {f ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "18px 0" }}>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>Starting cash</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{aud(f.startingCash)}</div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>Ending wk 13</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700,
              color: f.summary.endingBalance >= f.startingCash ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)" }}>
              {aud(f.summary.endingBalance)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{audSigned(f.summary.endingBalance - f.startingCash)} over 13w</div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>Lowest week</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700,
              color: f.summary.lowestBalance < f.minimumBalanceAlert ? "var(--rose, #f43f5e)" : undefined }}>
              {aud(f.summary.lowestBalance)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Week {f.summary.lowestWeek?.weekNumber ?? "—"} · {f.summary.lowestWeek?.weekEnding ?? "—"}
            </div>
          </div>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>Weeks below floor</div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 700,
              color: f.summary.weeksBelowMinimum > 0 ? "var(--rose, #f43f5e)" : "var(--emerald, #34d399)" }}>
              {f.summary.weeksBelowMinimum} / 13
            </div>
            <div className="muted" style={{ fontSize: 12 }}>Floor = {aud(f.minimumBalanceAlert)}</div>
          </div>
        </div>
      ) : null}

      {!editing ? (
        <button className="btn" onClick={() => setEditing(true)} style={{ marginBottom: 16 }}>
          Update inputs
        </button>
      ) : null}

      {/* Input form */}
      {editing ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ marginTop: 0 }}>Update inputs</h2>

          <Section title="Bank balances (live, not Xero)">
            <Field label="Westpac" value={form.westpacBalance} onChange={set("westpacBalance")} />
            <Field label="St George" value={form.stGeorgeBalance} onChange={set("stGeorgeBalance")} />
            <Field label="Other cash" value={form.otherCashBalance} onChange={set("otherCashBalance")} />
          </Section>
          <p className="muted" style={{ fontSize: 12 }}>Total cash today: <strong>{aud(totalCash)}</strong></p>

          <Section title="Money owed to you (by debtor type)">
            <Field label="NDIA (~10d)" value={form.ndiaOutstanding} onChange={set("ndiaOutstanding")} />
            <Field label="Plan managers (~30d)" value={form.planManagerOutstanding} onChange={set("planManagerOutstanding")} />
            <Field label="Self-managed (~14d)" value={form.selfManagedOutstanding} onChange={set("selfManagedOutstanding")} />
            <Field label="Hospitals (~30d)" value={form.hospitalsOutstanding} onChange={set("hospitalsOutstanding")} />
            <Field label="Private (~21d)" value={form.privateOutstanding} onChange={set("privateOutstanding")} />
            <Field label="SaH receipts / month" value={form.sahReceiptsMonthly} onChange={set("sahReceiptsMonthly")} />
          </Section>
          <p className="muted" style={{ fontSize: 12 }}>Total owed: <strong>{aud(totalAr)}</strong></p>

          <Section title="Money going out — suppliers + ATO">
            <Field label="Supplier bills owing now" value={form.apOpenBalance} onChange={set("apOpenBalance")} />
            <Field label="Supplier bills / week" value={form.apWeeklyRun} onChange={set("apWeeklyRun")} />
            <Field label="ATO arrears balance" value={form.atoArrearsBalance} onChange={set("atoArrearsBalance")} />
            <Field label="ATO payment plan / month" value={form.atoMonthlyPaymentPlan} onChange={set("atoMonthlyPaymentPlan")} />
          </Section>

          <Section title="Payroll (per week)">
            <Field label="Weekly pay (gross)" value={form.weeklyPayrollGross} onChange={set("weeklyPayrollGross")} />
            <Field label="Weekly super" value={form.weeklyEmployerSuper} onChange={set("weeklyEmployerSuper")} />
            <Field label="Weekly tax — SC" value={form.weeklyPaygSc} onChange={set("weeklyPaygSc")} />
            <Field label="Monthly tax — CQ" value={form.monthlyPaygCq} onChange={set("monthlyPaygCq")} />
          </Section>

          <Section title="Alert">
            <Field label="Minimum balance floor" value={form.minimumBalanceAlert} onChange={set("minimumBalanceAlert")} />
          </Section>

          <div style={{ marginTop: 12 }}>
            <label className="field-label">Notes</label>
            <textarea rows={2} value={form.notes} onChange={set("notes")}
              placeholder="e.g. awaiting March SaH receipt, expected week 2" style={{ width: "100%" }} />
          </div>

          {error ? <div style={{ color: "var(--rose, #f43f5e)", fontSize: 13, marginTop: 8 }}>{error}</div> : null}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            {hasInput ? (
              <button className="btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            ) : null}
            <button className="btn btn-primary" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save + recompute"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Week-by-week table */}
      {f && !editing ? (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Wk</th>
                <th>Ending</th>
                <th style={{ textAlign: "right" }}>Open</th>
                <th style={{ textAlign: "right" }}>In</th>
                <th style={{ textAlign: "right" }}>Out</th>
                <th style={{ textAlign: "right" }}>Net</th>
                <th style={{ textAlign: "right" }}>Close</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {f.weeks.map((w) => (
                <tr key={w.weekNumber} style={w.belowMinimum ? { background: "rgba(244,63,94,0.12)" } : undefined}>
                  <td className="mono">{w.weekNumber}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{w.weekEnding}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{aud(w.openingBalance)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--emerald, #34d399)" }}>{aud(w.totalInflows)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--rose, #f43f5e)" }}>{aud(w.totalOutflows)}</td>
                  <td className="mono" style={{ textAlign: "right", color: w.netFlow >= 0 ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)" }}>{audSigned(w.netFlow)}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: w.belowMinimum ? "var(--rose, #f43f5e)" : undefined }}>{aud(w.closingBalance)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{w.notes.length ? w.notes.join(" · ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!f && !editing ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No forecast yet — click &quot;Update inputs&quot; to create your first 13-week projection.</p></div>
      ) : null}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 8px" }} className="muted">{title}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <input type="number" step="0.01" value={value} onChange={onChange} className="mono" style={{ width: "100%", textAlign: "right" }} />
    </div>
  );
}
