// Dismiss page — opened from a link under each line of the emailed brief.
// Signed-link auth (lib/mark/dismiss.ts), no login, so it works from a phone.

import { notFound } from "next/navigation";
import { verifyDismissToken, SNOOZE_DAYS } from "@/lib/mark/dismiss";
import { loadDismissView } from "@/lib/mark/dismiss-actions";
import { brisbaneDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const ANSWER_TEXT: Record<string, string> = {
  done: "Marked as dealt with. It won't come back.",
  wrong: "Marked as not a real problem. It won't come back.",
  snooze: `Snoozed for ${SNOOZE_DAYS} days.`,
  "not-care-supplier": "Supplier won't be flagged for vetting again.",
  undo: "Undone — the item is back in the brief.",
};

const btn: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "14px 16px",
  marginTop: 10,
  fontSize: 16,
  fontWeight: 600,
  borderRadius: 10,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-card-elev)",
  color: "var(--fg-strong)",
  textAlign: "left",
  cursor: "pointer",
};

function money(n: unknown): string | null {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v) || Math.round(Math.abs(v)) === 0) return null;
  return `$${Math.round(Math.abs(v)).toLocaleString("en-AU")}`;
}

export default async function DismissPage(ctx: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ok?: string; err?: string }>;
}) {
  const { token } = await ctx.params;
  const { ok, err } = await ctx.searchParams;
  const issueId = verifyDismissToken(token);
  if (!issueId) notFound();
  const view = await loadDismissView(issueId);
  if (!view) notFound();
  const { issue, findings, expired, vettingSupplier, answered } = view;
  const action = `/api/f/${token}`;
  const amount = money(issue.amount);

  return (
    <main className="container" style={{ maxWidth: 560, padding: "20px 16px 48px" }}>
      <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1.2 }}>
        Brief item · {issue.entityCode} · {brisbaneDate(issue.createdAt)}
      </div>
      <h1 style={{ fontSize: 22, lineHeight: 1.3, marginTop: 8 }}>
        {issue.title}
        {amount && <span className="muted"> — {amount}</span>}
      </h1>

      {ok && (
        <div className="card" style={{ borderColor: "var(--emerald)", marginTop: 14 }}>
          {ANSWER_TEXT[ok] ?? "Saved."}
        </div>
      )}
      {err && (
        <div className="card" style={{ borderColor: "var(--rose)", marginTop: 14 }}>
          {err}
        </div>
      )}

      {findings.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Details ({findings.length} finding{findings.length === 1 ? "" : "s"})
          </summary>
          {findings.map((f) => (
            <div key={f.id} className="card" style={{ marginTop: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
              <strong>{f.title}</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                {f.sourceAgent} · {f.detector}
                {f.resolved ? " · closed" : ""}
              </div>
              <div style={{ marginTop: 6 }}>{f.detail.slice(0, 600)}</div>
            </div>
          ))}
        </details>
      )}

      {expired ? (
        <p className="muted" style={{ marginTop: 20 }}>
          This link has expired. Use the link in a newer brief.
        </p>
      ) : answered ? (
        <div style={{ marginTop: 20 }}>
          <p>
            {ANSWER_TEXT[answered.action] ?? "Answered."}{" "}
            <span className="muted">
              ({brisbaneDate(answered.at)}
              {answered.until ? `, until ${brisbaneDate(answered.until)}` : ""})
            </span>
          </p>
          <form method="post" action={action}>
            <button name="action" value="undo" style={{ ...btn, fontWeight: 500 }}>
              Undo
            </button>
          </form>
        </div>
      ) : (
        <form method="post" action={action} style={{ marginTop: 20 }}>
          <button name="action" value="done" style={btn}>
            ✓ Done — I&apos;ve dealt with it
          </button>
          <button name="action" value="wrong" style={btn}>
            ✕ Wrong — this isn&apos;t a real problem
          </button>
          <button name="action" value="snooze" style={btn}>
            ⏸ Snooze for {SNOOZE_DAYS} days
          </button>
          {vettingSupplier && (
            <button name="action" value="not-care-supplier" style={btn}>
              {`⊘ ${vettingSupplier} isn't a care supplier — never vet`}
            </button>
          )}
          <input
            name="note"
            placeholder="Optional note (e.g. why it's wrong)"
            style={{
              ...btn,
              fontWeight: 400,
              fontSize: 15,
              cursor: "text",
              marginTop: 16,
            }}
          />
        </form>
      )}
    </main>
  );
}
