// Cash forecast client — auto-pull-first. REWORKED 2026-06.
//
// The hero action is "Pull from Xero": one click fills bank balances, money
// owed (by the 7 debtor types) and bills owed for BOTH companies. Tony only
// ticks which bank accounts count as spendable cash and tweaks a handful of
// forward outflow assumptions (weekly pay, super, PAYG, ATO plan). Then Save.
// Three tabs show the week-by-week table for SC, CQ, and the combined total.

"use client";

import { useMemo, useState } from "react";
import {
  DEBTOR_TYPES,
  DEBTOR_LABELS,
  buildForecast,
  type CashForecastState,
  type DebtorType,
  type EntityState,
  type ForecastResult,
  type EntityForecast,
  type TenantCode,
} from "@/lib/cash-forecast";

const aud = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const audSigned = (n: number) => `${n < 0 ? "-" : "+"}${aud(Math.abs(n))}`;

const ENTITY_LABEL: Record<TenantCode, string> = {
  SC: "Sunshine Coast",
  CQ: "Centacare (CQ)",
};

const KIND_LABEL: Record<string, string> = {
  cash: "Everyday cash",
  card: "Credit card",
  restricted: "Trust / property",
};

type PullTenant = {
  bankAccounts: EntityState["bankAccounts"];
  cashTotalDefault: number;
  ar: Record<string, number>;
  apTotal: number;
  arInvoiceCount: number;
  apBillCount: number;
};

export function CashForecastClient({
  initialState,
  initialForecast,
  hasInput,
  savedBy,
}: {
  initialState: CashForecastState;
  initialForecast: ForecastResult;
  hasInput: boolean;
  savedBy: string | null;
}) {
  const [state, setState] = useState<CashForecastState>(initialState);
  const [forecast, setForecast] = useState<ForecastResult>(initialForecast);
  const [tab, setTab] = useState<"COMBINED" | TenantCode>("COMBINED");
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Recompute locally whenever the state changes (instant feedback, no save).
  function recompute(next: CashForecastState) {
    setState(next);
    setForecast(buildForecast(next));
    setDirty(true);
  }

  async function onPull() {
    setPulling(true);
    setError(null);
    try {
      const res = await fetch("/api/cash-forecast/pull", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "pull failed");
      const tenants = json.tenants as Record<string, PullTenant>;
      const next: CashForecastState = structuredClone(state);
      for (const code of ["SC", "CQ"] as TenantCode[]) {
        const t = tenants[code];
        if (!t) continue;
        const ent = next.entities[code];
        ent.bankAccounts = t.bankAccounts;
        for (const dt of DEBTOR_TYPES) ent.ar[dt] = t.ar[dt] ?? 0;
        ent.apOpenBalance = t.apTotal;
      }
      next.pulledAt = new Date().toISOString();
      recompute(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
    }
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/cash-forecast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "save failed");
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function toggleBank(code: TenantCode, idx: number) {
    const next = structuredClone(state);
    const acc = next.entities[code].bankAccounts[idx];
    acc.include = !acc.include;
    recompute(next);
  }

  function setAssumption(code: TenantCode, key: keyof EntityState["assumptions"], v: number) {
    const next = structuredClone(state);
    next.entities[code].assumptions[key] = v;
    recompute(next);
  }

  function setCadence(dt: DebtorType, v: number) {
    const next = structuredClone(state);
    next.cadenceDays[dt] = v;
    recompute(next);
  }

  function setFloor(v: number) {
    const next = structuredClone(state);
    next.minimumBalanceAlert = v;
    recompute(next);
  }

  const shown: EntityForecast =
    tab === "COMBINED" ? forecast.combined : tab === "SC" ? forecast.sc : forecast.cq;

  const pulledLabel = useMemo(() => {
    if (!state.pulledAt) return null;
    try {
      return new Date(state.pulledAt).toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return null;
    }
  }, [state.pulledAt]);

  return (
    <main className="container">
      <h1>13-week cash forecast</h1>
      <p className="muted">
        Where cash lands week-by-week, per company and combined. Click{" "}
        <strong>Pull from Xero</strong> to fill everything in automatically — bank balances, money
        owed (split by who owes it), and bills owed. Then just tick which bank accounts are real
        spendable cash and check the few payroll/ATO figures. Red = a week closing below your floor.
        {savedBy ? (
          <>
            {" "}
            · Last saved by <strong>{savedBy}</strong>.
          </>
        ) : null}
      </p>

      {/* Hero actions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "16px 0" }}>
        <button className="btn btn-primary" onClick={onPull} disabled={pulling || saving}>
          {pulling ? "Pulling from Xero…" : "↻ Pull from Xero"}
        </button>
        <button className="btn" onClick={onSave} disabled={saving || pulling || !dirty}>
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
        {pulledLabel ? (
          <span className="muted" style={{ fontSize: 12 }}>
            Xero data pulled {pulledLabel}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            No Xero data yet — click Pull from Xero.
          </span>
        )}
      </div>

      {error ? (
        <div className="card" style={{ borderColor: "var(--rose, #f43f5e)", marginBottom: 14 }}>
          <strong style={{ color: "var(--rose, #f43f5e)" }}>Couldn&apos;t do that:</strong> {error}
        </div>
      ) : null}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["COMBINED", "SC", "CQ"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "btn btn-primary" : "btn"}
            onClick={() => setTab(t)}
          >
            {t === "COMBINED" ? "Combined" : ENTITY_LABEL[t]}
          </button>
        ))}
      </div>

      {/* Summary ribbon for the shown view */}
      <SummaryRibbon f={shown} floor={forecast.minimumBalanceAlert} />

      {/* Per-entity editing (not on combined — combined is a read-only roll-up) */}
      {tab !== "COMBINED" ? (
        <EntityEditor
          code={tab}
          entity={state.entities[tab]}
          onToggleBank={(idx) => toggleBank(tab, idx)}
          onAssumption={(k, v) => setAssumption(tab, k, v)}
        />
      ) : (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Combined = Sunshine Coast + Centacare added together. Cash can&apos;t move freely between
            the two companies, so always check each one on its own tab too — a healthy combined total
            can still hide one company running short.
          </p>
        </div>
      )}

      {/* Week table */}
      <WeekTable f={shown} />

      {/* Settings: cadences + floor (collapsible) */}
      <Settings
        cadenceDays={state.cadenceDays}
        floor={state.minimumBalanceAlert}
        onCadence={setCadence}
        onFloor={setFloor}
      />

      {!hasInput && !state.pulledAt ? (
        <div className="card" style={{ marginTop: 14 }}>
          <p className="muted" style={{ margin: 0 }}>
            Nothing saved yet. Click <strong>Pull from Xero</strong> to build your first 13-week
            picture, then Save.
          </p>
        </div>
      ) : null}
    </main>
  );
}

function SummaryRibbon({ f, floor }: { f: EntityForecast; floor: number }) {
  return (
    <div
      style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "8px 0 16px" }}
    >
      <div className="card">
        <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
          Spendable cash now
        </div>
        <div className="mono" style={{ fontSize: 24, fontWeight: 700 }}>
          {aud(f.startingCash)}
        </div>
      </div>
      <div className="card">
        <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
          Ending wk 13
        </div>
        <div
          className="mono"
          style={{
            fontSize: 24,
            fontWeight: 700,
            color:
              f.summary.endingBalance >= f.startingCash
                ? "var(--emerald, #34d399)"
                : "var(--rose, #f43f5e)",
          }}
        >
          {aud(f.summary.endingBalance)}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {audSigned(f.summary.endingBalance - f.startingCash)} over 13w
        </div>
      </div>
      <div className="card">
        <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
          Lowest week
        </div>
        <div
          className="mono"
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: f.summary.lowestBalance < floor ? "var(--rose, #f43f5e)" : undefined,
          }}
        >
          {aud(f.summary.lowestBalance)}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Week {f.summary.lowestWeek?.weekNumber ?? "—"} ·{" "}
          {f.summary.lowestWeek?.weekEnding ?? "—"}
        </div>
      </div>
      <div className="card">
        <div className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
          Weeks below floor
        </div>
        <div
          className="mono"
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: f.summary.weeksBelowMinimum > 0 ? "var(--rose, #f43f5e)" : "var(--emerald, #34d399)",
          }}
        >
          {f.summary.weeksBelowMinimum} / 13
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Floor = {aud(floor)}
        </div>
      </div>
    </div>
  );
}

function EntityEditor({
  code,
  entity,
  onToggleBank,
  onAssumption,
}: {
  code: TenantCode;
  entity: EntityState;
  onToggleBank: (idx: number) => void;
  onAssumption: (key: keyof EntityState["assumptions"], v: number) => void;
}) {
  const cashIncluded = entity.bankAccounts
    .filter((a) => a.include)
    .reduce((s, a) => s + a.balance, 0);
  const arTotal = DEBTOR_TYPES.reduce((s, t) => s + (entity.ar[t] || 0), 0);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h2 style={{ marginTop: 0 }}>{ENTITY_LABEL[code]}</h2>

      {/* Bank accounts tick-list */}
      <h3 className="muted" style={subhead}>
        Bank accounts — tick what counts as spendable cash
      </h3>
      {entity.bankAccounts.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No accounts yet — click <strong>Pull from Xero</strong> above.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 36 }}></th>
              <th>Account</th>
              <th>Type</th>
              <th style={{ textAlign: "right" }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {entity.bankAccounts.map((a, idx) => (
              <tr key={idx} style={!a.include ? { opacity: 0.5 } : undefined}>
                <td style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={a.include} onChange={() => onToggleBank(idx)} />
                </td>
                <td>{a.name}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {KIND_LABEL[a.kind] ?? a.kind}
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {aud(a.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        Counted as spendable cash: <strong>{aud(cashIncluded)}</strong>
      </p>

      {/* Money owed — read-only, from Xero */}
      <h3 className="muted" style={subhead}>
        Money owed to you (from Xero, by who owes it)
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {DEBTOR_TYPES.map((t) => (
          <div key={t}>
            <div className="field-label">{DEBTOR_LABELS[t]}</div>
            <div className="mono" style={{ textAlign: "right" }}>
              {aud(entity.ar[t] || 0)}
            </div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Total owed to you: <strong>{aud(arTotal)}</strong> · Bills you owe:{" "}
        <strong>{aud(entity.apOpenBalance)}</strong>
      </p>

      {/* Assumptions — the only typed fields */}
      <h3 className="muted" style={subhead}>
        Money going out — check these few figures
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <NumField
          label="Weekly pay (gross)"
          value={entity.assumptions.weeklyPayrollGross}
          onChange={(v) => onAssumption("weeklyPayrollGross", v)}
        />
        <NumField
          label="Weekly super"
          value={entity.assumptions.weeklyEmployerSuper}
          onChange={(v) => onAssumption("weeklyEmployerSuper", v)}
        />
        {code === "SC" ? (
          <NumField
            label="Weekly tax (PAYG)"
            value={entity.assumptions.weeklyPaygSc}
            onChange={(v) => onAssumption("weeklyPaygSc", v)}
          />
        ) : (
          <NumField
            label="Monthly tax (PAYG)"
            value={entity.assumptions.monthlyPaygCq}
            onChange={(v) => onAssumption("monthlyPaygCq", v)}
          />
        )}
        <NumField
          label="Other bills / week"
          value={entity.assumptions.apWeeklyRun}
          onChange={(v) => onAssumption("apWeeklyRun", v)}
        />
        <NumField
          label="ATO plan / month"
          value={entity.assumptions.atoMonthlyPaymentPlan}
          onChange={(v) => onAssumption("atoMonthlyPaymentPlan", v)}
        />
      </div>
    </div>
  );
}

function WeekTable({ f }: { f: EntityForecast }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
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
            <tr
              key={w.weekNumber}
              style={w.belowMinimum ? { background: "rgba(244,63,94,0.12)" } : undefined}
            >
              <td className="mono">{w.weekNumber}</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {w.weekEnding}
              </td>
              <td className="mono" style={{ textAlign: "right" }}>
                {aud(w.openingBalance)}
              </td>
              <td className="mono" style={{ textAlign: "right", color: "var(--emerald, #34d399)" }}>
                {aud(w.totalInflows)}
              </td>
              <td className="mono" style={{ textAlign: "right", color: "var(--rose, #f43f5e)" }}>
                {aud(w.totalOutflows)}
              </td>
              <td
                className="mono"
                style={{
                  textAlign: "right",
                  color: w.netFlow >= 0 ? "var(--emerald, #34d399)" : "var(--rose, #f43f5e)",
                }}
              >
                {audSigned(w.netFlow)}
              </td>
              <td
                className="mono"
                style={{
                  textAlign: "right",
                  fontWeight: 700,
                  color: w.belowMinimum ? "var(--rose, #f43f5e)" : undefined,
                }}
              >
                {aud(w.closingBalance)}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                {w.notes.length ? w.notes.join(" · ") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings({
  cadenceDays,
  floor,
  onCadence,
  onFloor,
}: {
  cadenceDays: Record<DebtorType, number>;
  floor: number;
  onCadence: (dt: DebtorType, v: number) => void;
  onFloor: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <button
        className="btn"
        onClick={() => setOpen((o) => !o)}
        style={{ marginBottom: open ? 12 : 0 }}
      >
        {open ? "▾" : "▸"} Settings — how fast each payer pays, and your cash floor
      </button>
      {open ? (
        <>
          <h3 className="muted" style={subhead}>
            Days until money owed lands in the bank
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {DEBTOR_TYPES.map((t) => (
              <NumField
                key={t}
                label={`${DEBTOR_LABELS[t]} (days)`}
                value={cadenceDays[t]}
                step={1}
                onChange={(v) => onCadence(t, v)}
              />
            ))}
          </div>
          <h3 className="muted" style={subhead}>
            Cash floor (alert if a week closes below)
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <NumField label="Minimum balance" value={floor} onChange={onFloor} />
          </div>
        </>
      ) : null}
    </div>
  );
}

const subhead: React.CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  margin: "16px 0 8px",
};

function NumField({
  label,
  value,
  onChange,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className="mono"
        style={{ width: "100%", textAlign: "right" }}
      />
    </div>
  );
}
