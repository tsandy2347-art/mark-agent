// Form target for the dismiss page. Signed-link auth (see lib/mark/dismiss.ts);
// bypasses Basic auth in proxy.ts. Answers with a 303 back to the page so a
// refresh doesn't resubmit.

import { NextResponse, type NextRequest } from "next/server";
import { publicBaseUrl, verifyDismissToken, type DismissAction } from "@/lib/mark/dismiss";
import { applyDismiss } from "@/lib/mark/dismiss-actions";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<DismissAction | "undo">(["done", "wrong", "snooze", "not-care-supplier", "undo"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  // Behind Railway's proxy req.nextUrl.origin is the container's own
  // http://localhost:8080 — redirecting there broke the page after every
  // click. Send people back to the public address.
  const back = new URL(`/f/${token}`, publicBaseUrl() || req.nextUrl.origin);
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
