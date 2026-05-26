import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Next.js 16: route params arrive as a Promise. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const brief = await prisma.financeBrief.findUnique({
    where: { id },
    include: {
      correlatedIssues: { orderBy: { priority: "asc" } },
    },
  });
  if (!brief) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ brief });
}
