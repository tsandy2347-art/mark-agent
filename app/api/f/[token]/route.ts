// Form target for the dismiss page. Signed-link auth (see lib/mark/dismiss.ts);
// bypasses Basic auth in proxy.ts. Answers with a 303 back to the page so a
// refresh doesn't resubmit.

import { NextResponse, type NextRequest } from "next/server";
import { verifyDismissToken, type DismissAction } from "@/lib/mark/dismiss";
import { applyDismiss } from "@/lib/mark/dismiss-actions";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<DismissAction | "undo">(["done", "wrong", "snooze", "not-care-supplier", "undo"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const back = new URL(`/f/${token}`, req.nextUrl.origin);
  const issueId = verifyDismissToken(token);
  if (!issueId) return new NextResponse("Invalid link", { status: 404 });

  const form = await req.formData();
  const action = String(form.get("action") ?? "") as DismissAction | "undo";
  if (!ACTIONS.has(action)) return new NextResponse("Unknown action", { status: 400 });
  const note = form.get("note");

  const result = await applyDismiss(issueId, action, typeof note === "string" ? note : null);
  back.searchParams.set(result.ok ? "ok" : "err", result.ok ? action : result.reason);
  return NextResponse.redirect(back, 303);
}
