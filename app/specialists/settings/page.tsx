// /specialists/settings — read-only view of every tunable knob on every
// specialist. Mark writes via the change_specialist_setting tool; this page
// just renders the current state so you can see at a glance "what's Monty
// chasing invoices at right now."

import { brisbane } from "@/lib/time";
import { listSettings, SPECIALIST_KNOBS } from "@/lib/specialist-settings";
import { specialists } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function SpecialistSettingsPage() {
  const all = await listSettings();
  const byPair = new Map(all.map((s) => [`${s.specialist}|${s.key}`, s]));
  const desc = specialists();
  const nameFor = (slug: string) => desc.find((d) => d.agent === slug)?.name ?? slug;
  const labelFor = (slug: string) => desc.find((d) => d.agent === slug)?.label ?? slug;

  const supported = Object.keys(SPECIALIST_KNOBS);

  return (
    <main className="container">
      <h1>Specialist settings</h1>
      <p className="muted">
        Tunable thresholds for each specialist. Mark can change these on your
        say-so during a call — &quot;have Monty chase at 90 days&quot;,
        &quot;drop the write-off threshold to 100 days&quot;. Changes are
        durable and take effect on the next nightly run.
      </p>

      {supported.length === 0 && (
        <p className="muted">No specialists have settable knobs yet.</p>
      )}

      {supported.map((slug) => {
        const knobs = SPECIALIST_KNOBS[slug];
        return (
          <div key={slug} className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
            <h2 style={{ padding: "12px 16px", margin: 0 }}>
              {nameFor(slug)} <span className="muted">— {labelFor(slug)}</span>
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Setting</th>
                  <th style={{ textAlign: "right" }}>Value</th>
                  <th>Range</th>
                  <th>Description</th>
                  <th>Updated</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(knobs).map(([key, knob]) => {
                  const row = byPair.get(`${slug}|${key}`);
                  return (
                    <tr key={key}>
                      <td className="mono" style={{ fontSize: 13 }}>{key}</td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {row?.value ?? <span className="dim">(unset)</span>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {knob.min}–{knob.max} {knob.type}
                      </td>
                      <td style={{ fontSize: 13 }}>{knob.description}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {row ? brisbane(row.updatedAt) : "—"}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {row?.updatedBy ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </main>
  );
}
