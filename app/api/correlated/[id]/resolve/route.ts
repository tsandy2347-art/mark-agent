// POST /api/correlated/[id]/resolve — mark a CorrelatedIssue resolved.
//
// Mark cannot resolve a finding in the upstream specialist (that would mutate
// a specialist's data — explicitly forbidden by spec). What he CAN do is mark
// his own correlated card resolved, e.g. when a human decides the card is
// noise, or when every underlying finding has been resolved upstream and
// re-polled.

import { NextResponse, type NextRequest } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function currentUsername(): Promise<string | null> {
  const h = await headers();
  const auth = h.get("authorization");
  if (!auth?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString();
    return decoded.split(":")[0].toLowerCase();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { resolvedBy?: string };
  const resolvedBy = (body.resolvedBy ?? (await currentUsername()) ?? "").trim();
  if (!resolvedBy) {
    return NextResponse.json({ ok: false, error: "resolvedBy required" }, { status: 400 });
  }
  try {
    const updated = await prisma.correlatedIssue.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), resolvedBy },
    });
    return NextResponse.json({ ok: true, issue: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
