import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET /api/briefs — recent briefs. Basic-auth via proxy.ts. */
export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "20", 10) || 20, 100);
  const briefs = await prisma.financeBrief.findMany({
    orderBy: { generatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      briefType: true,
      entityScope: true,
      generatedAt: true,
      headline: true,
      recipients: true,
      deliveryStatus: true,
    },
  });
  return NextResponse.json({ briefs });
}
