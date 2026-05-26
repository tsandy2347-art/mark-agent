import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  let lastBrief: { id: string; briefType: string; generatedAt: Date; deliveryStatus: string } | null = null;
  let mostRecentPoll: Date | null = null;
  try {
    lastBrief = await prisma.financeBrief.findFirst({
      orderBy: { generatedAt: "desc" },
      select: { id: true, briefType: true, generatedAt: true, deliveryStatus: true },
    });
    const statuses = await prisma.specialistRunStatus.findMany({
      where: { lastRunAt: { not: null } },
      orderBy: { lastRunAt: "desc" },
      take: 1,
    });
    mostRecentPoll = statuses[0]?.lastRunAt ?? null;
  } catch {
    // healthz should never throw — DB unreachable is its own signal.
  }
  return NextResponse.json({
    ok: true,
    service: "mark-agent",
    ts: new Date().toISOString(),
    lastBrief,
    mostRecentPoll: mostRecentPoll ? mostRecentPoll.toISOString() : null,
  });
}
