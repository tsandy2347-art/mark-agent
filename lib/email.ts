// SES v2 delivery — Mark's only outbound channel.
//
// Channels: daily-brief / restricted-brief / weekly-report / monthly-pack /
//           heartbeat-failure.
//
// Hard rule (spec section 6 + section 2.5): people-flag / individual-pay
// content goes on the restricted-brief channel ONLY. The channel guard below
// throws if anyone tries to slip it into daily/weekly/monthly. That guard is
// the single source of routing truth — `lib/mark/brief.ts` defers to it.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env, recipients } from "./env";
import { prisma } from "./prisma";

const ses = new SESv2Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

export type Channel =
  | "daily-brief"
  | "recon-ar-brief"
  | "restricted-brief"
  | "weekly-report"
  | "monthly-pack"
  | "heartbeat-failure";

export interface SendArgs {
  channel: Channel;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  flagsCount?: number;
  /** True only on the restricted-brief channel. Any other channel raises a
   *  routing-violation error before we hit SES. */
  peopleFlagsIncluded?: boolean;
  /** Optional FK back to the FinanceBrief row, for audit. */
  briefId?: string;
}

export async function sendChannelEmail(args: SendArgs): Promise<void> {
  // ── Channel guard — the routing rule that cannot quietly erode. ──
  if (args.peopleFlagsIncluded && args.channel !== "restricted-brief") {
    const err = `routing violation: peopleFlagsIncluded=true on channel '${args.channel}'`;
    await logDelivery({ ...args, status: "error", errorMessage: err });
    throw new Error(err);
  }

  if (args.to.length === 0) {
    await logDelivery({ ...args, status: "skipped", errorMessage: "no recipients" });
    return;
  }

  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    // No SES creds — log the body to stdout so it's visible in Railway logs.
    // eslint-disable-next-line no-console
    console.log(`[email:${args.channel}] SES not configured — would have sent:`);
    // eslint-disable-next-line no-console
    console.log(`  to: ${args.to.join(", ")}`);
    // eslint-disable-next-line no-console
    console.log(`  subject: ${args.subject}`);
    // eslint-disable-next-line no-console
    console.log("  --- text body ---");
    // eslint-disable-next-line no-console
    console.log(args.text);
    // eslint-disable-next-line no-console
    console.log("  --- end ---");
    await logDelivery({ ...args, status: "skipped", errorMessage: "SES not configured" });
    return;
  }

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: args.from ?? env.REPORT_FROM,
        Destination: { ToAddresses: args.to },
        Content: {
          Simple: {
            Subject: { Data: args.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: args.text, Charset: "UTF-8" },
              ...(args.html ? { Html: { Data: args.html, Charset: "UTF-8" } } : {}),
            },
          },
        },
      }),
    );
    await logDelivery({ ...args, status: "sent" });
  } catch (e) {
    await logDelivery({
      ...args,
      status: "error",
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

async function logDelivery(args: SendArgs & { status: "sent" | "skipped" | "error"; errorMessage?: string }): Promise<void> {
  try {
    await prisma.alertDelivery.create({
      data: {
        channel: args.channel,
        recipients: args.to.join(", "),
        subject: args.subject,
        flagsCount: args.flagsCount ?? 0,
        peopleFlagsIncluded: Boolean(args.peopleFlagsIncluded),
        status: args.status,
        errorMessage: args.errorMessage,
        briefId: args.briefId,
      },
    });
  } catch {
    // never let an audit-log failure swallow the actual send result
  }
}

/** Heartbeat path — fired when a brief or the polling sweep falls over. */
export async function sendHeartbeatFailure(error: unknown, context: string): Promise<void> {
  const to = recipients(env.MARK_HEARTBEAT_RECIPIENTS);
  if (to.length === 0) return;
  const msg = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  await sendChannelEmail({
    channel: "heartbeat-failure",
    to,
    subject: `Mark — DID NOT RUN (${context})`,
    text:
      `Mark hit a fatal error during ${context} and did not complete.\n\n` +
      `${msg}\n\nSilence is not success — investigate.`,
  });
}
