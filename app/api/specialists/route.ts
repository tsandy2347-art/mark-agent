import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isStale } from "@/lib/mark/poll";
import { specialists } from "@/lib/env";

export const dynamic = "force-dynamic";

/** GET /api/specialists — health of all 7. Used by the dashboard. */
export async function GET() {
  const descriptors = specialists();
  const rows = await prisma.specialistRunStatus.findMany();
  const byAgent = new Map(rows.map((r) => [r.agent, r]));
  const out = descriptors.map((d) => {
    const r = byAgent.get(d.agent);
    return {
      agent: d.agent,
      label: d.label,
      urlConfigured: Boolean(d.url),
      lastRunAt: r?.lastRunAt ?? null,
      lastRunStatus: r?.lastRunStatus ?? "never",
      exceptionsOpen: r?.exceptionsOpen ?? 0,
      stale: isStale(r?.lastRunAt ?? null),
      lastError: r?.lastError ?? null,
    };
  });
  return NextResponse.json({ specialists: out });
}
