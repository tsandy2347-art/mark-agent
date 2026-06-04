// Function E — natural-language Q&A.
//
// Mark answers questions from Tony or the team against the current ingested
// data + recent goal metrics. The Anthropic system prompt enforces the
// guardrails: only answer from provided data, never invent numbers, never make
// a recommendation a specialist would not, always end with the data-as-of
// timestamp.
//
// Restricted content (people / individual pay) is excluded from the data we
// pass to the model unless the caller is explicitly in the restricted group
// (gated at the route layer, NOT here — this function takes a flag).

import { prisma } from "../prisma";
import { brisbane } from "../time";
import { answerQuestion, type QaAttachment, type QaHistoryTurn } from "../anthropic";
import { env } from "../env";
import { fetchMarkMemory, formatMemoryAddendum, postTurn } from "../honcho";
import { listOpenFindingsForQa } from "../hermes-findings";
import { readLatestMetrics } from "./goals";
import { getFinancialsForQa } from "../financials";

interface AskInput {
  askedBy: string;
  question: string;
  /** When true, restricted findings are included in the data passed to Claude.
   *  Defaults to false. The route layer is responsible for setting this only
   *  when the requesting user is in MARK_RESTRICTED_USERNAMES. */
  includeRestricted?: boolean;
  /** Optional files the user uploaded — PDFs, images (screenshots), or
   *  spreadsheets. Forwarded to Anthropic appropriately for each type.
   *  All attachments bind to the first user message of the conversation so
   *  they persist across follow-up turns. */
  attachments?: QaAttachment[];
  /** Prior conversation turns, oldest first. The Anthropic API is stateless
   *  so the browser sends the full conversation on every follow-up. */
  history?: QaHistoryTurn[];
  /** Honcho session id — one continuous thread per user. Stored in browser
   *  localStorage; "Clear conversation" mints a new one. When supplied,
   *  Mark fetches the session resume + per-user cross-session memory from
   *  Honcho, and writes the new user/assistant turns back. Omit to skip
   *  memory entirely (useful for ad-hoc API calls). */
  sessionId?: string;
  /** When true, Mark's reply is shaped for text-to-speech (Vapi voice call):
   *  spoken style, no markdown/URLs, pronounceable numbers, no data-as-of
   *  footer. Set by the /api/voice endpoint; defaults to false for the
   *  browser chat. */
  voiceMode?: boolean;
}

export interface AskOutput {
  answer: string;
  dataAsOf: string;
  queryId: string;
  /** Echoed back so the browser knows which session this turn landed in
   *  (useful when the server mints a new session id). */
  sessionId: string | null;
  /** Diagnostics for the UI: was the memory layer disabled or errored
   *  this turn? */
  memory: { disabled: boolean; errored: boolean };
  /** Number of times Mark fired the create-draft tool this turn. >0 means
   *  a draft was actually written to Xero via recon. */
  toolCallsFired: number;
}

export async function askMark(input: AskInput): Promise<AskOutput> {
  const includeRestricted = Boolean(input.includeRestricted);
  const now = new Date();
  const dataAsOf = brisbane(now);
  const userPeer = input.askedBy || "anonymous";

  const [findings, metrics, statuses, memory, financials, payrollMonths] = await Promise.all([
    // Pull directly from the shared hermes-jbc findings DB — the table every
    // Hermes skill writes to. We bypass Mark's local IngestedFinding mirror
    // because the legacy specialist /api/findings poll cycle has been
    // decommissioned in Phase 2 of the consolidation plan. Skills write
    // direct, Mark reads direct, no middle layer.
    listOpenFindingsForQa({ includePeopleFlag: includeRestricted, limit: 400 }),
    readLatestMetrics(),
    prisma.specialistRunStatus.findMany(),
    input.sessionId
      ? fetchMarkMemory({ sessionId: input.sessionId, userPeer })
      : Promise.resolve({ resume: [], memoryBlock: null, disabled: !env.HONCHO_BASE_URL, errored: false }),
    // P&L per entity. DB-first: stored closed months (zero Xero calls) plus
    // ONLY the live current month (1 call/entity, cached). Lets Mark answer
    // profit / income / expense questions with real figures while protecting the
    // daily Xero cap. Non-fatal: { ok:false } if both DB and live are empty.
    getFinancialsForQa(),
    // Payroll month TOTALS (gross/super/allowances) per entity. Mark fetches the
    // per-pay-type detail on demand via lookup_payroll_detail. Cheap small read.
    prisma.payrollMonth.findMany({
      orderBy: { month: "desc" },
      select: { entityCode: true, month: true, totalGross: true, totalSuper: true, totalAllowances: true, totalLeaveTaken: true },
    }),
  ]);

  // Findings shape passed to Claude. Previously this was aggressively
  // compacted (body capped at 600 chars, evidence stripped, explanation
  // omitted) which meant Mark physically had nothing to drill into when
  // the user asked a follow-up like "tell me more about X". He'd just
  // re-summarise the same 600 chars. We now include:
  //   - Full body up to 2500 chars (enough for most narratives — only
  //     pathologically long ones get clipped, and we mark when we do)
  //   - The full `evidence` object — that's where per-detector richness
  //     lives now (Xero deep-links, ManualJournalID, narrations,
  //     top-N worst-offender lists, etc.)
  //   - The AI `explanation` from the source specialist's classifier
  //   - `suggestedAction` — the bounded next-step vocab the specialist chose
  // Cost: ~2-3KB per finding × 400 findings ≈ 1MB of context. Sonnet 4.6's
  // window has plenty of room; this is well worth it for drill-down quality.
  const compactFindings = findings.map((f) => {
    const fullBody = f.detail ?? "";
    const body = fullBody.length > 2500 ? fullBody.slice(0, 2497) + "..." : fullBody;
    return {
      agent: f.sourceAgent,
      severity: f.severity,
      entity: f.entityCode,
      detector: f.detector,
      title: f.title,
      body,
      bodyTruncated: fullBody.length > 2500,
      amount: f.amount,
      at: f.createdAt.toISOString(),
      // Per-detector evidence — Xero deep-links, source ids, narrations etc.
      // Treat as opaque; quote keys verbatim if the user asks for the source.
      evidence: f.evidence ?? null,
      // Specialist's AI explanation of why this matters. May be null.
      explanation: f.aiExplanation ?? null,
      // The shared schema has no suggestedAction column — Mark infers next
      // action from severity in the system prompt.
      suggestedAction: null,
    };
  });

  // Compact P&L summary that MUST survive truncation — the findings payload
  // below can be ~700KB and the brain backend truncates long input, which is
  // why financials buried inside `data` never reached Mark. We hoist it into
  // priorityData (rendered at the very top of the prompt).
  //
  // We carry TOTALS for every month only (income, costs, net profit) — small and
  // accurate. The heavy per-account line items live in the DB; Mark fetches the
  // detail for a specific month ON DEMAND via the lookup_month_detail tool when
  // the user asks for a breakdown. This keeps the prompt lean (so the numbers
  // never get garbled by truncation) while still giving full drill-down.
  const stripDetail = (ms: Array<{ lineItems?: unknown }> | undefined) =>
    ms ? ms.map(({ lineItems: _drop, ...rest }) => rest) : null;

  const financialsBlock = financials.ok
    ? {
        note:
          "Per-entity Profit & Loss (AUD), TOTALS per month. SC and CQ are " +
          "SEPARATE legal entities/taxpayers — 'consolidated' is a management sum " +
          "only, NEVER statutory. CRITICAL ARREARS CAVEAT: JBC bills most care in " +
          "arrears, so any month with partialMonthToDate=true (the current month) " +
          "AND the single most-recent completed month are UNDER-BOOKED on income " +
          "and will show a FALSE loss. Do NOT report a recent-month loss as real — " +
          "explain the lag and cite the last FULLY-settled month as the " +
          "trustworthy figure. EXPENSE/INCOME BREAKDOWN: these are TOTALS only. " +
          "When the user asks what made up a month — biggest expenses, how much on " +
          "wages, income by account, etc. — call the lookup_month_detail tool with " +
          "the entity and month to get the line-by-line accounts, then quote those " +
          "amounts EXACTLY. Don't guess a breakdown from the totals.",
        SC: stripDetail(financials.SC?.months),
        CQ: stripDetail(financials.CQ?.months),
        consolidated: financials.consolidated ?? null,
      }
    : { unavailable: true, reason: financials.error };

  const data = {
    findings: compactFindings,
    goalMetrics: metrics,
    specialistHealth: statuses.map((s) => ({
      agent: s.agent,
      status: s.lastRunStatus,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      exceptionsOpen: s.exceptionsOpen,
    })),
  };

  // Payroll month TOTALS (per entity), newest first. Detail is fetched on demand
  // via lookup_payroll_detail. Hoisted into priorityData so it survives prompt
  // truncation alongside the P&L.
  const payrollBlock = payrollMonths.length
    ? {
        note:
          "Monthly labour cost from MYOB payroll (weekly pay runs grouped into the " +
          "month). TOTALS only: gross = actual wage cost, super = employer super, " +
          "allowances, leaveTaken. For the pay-TYPE breakdown (overtime, casual " +
          "loading, travel, weekend loadings, individual leave types, etc.) call " +
          "the lookup_payroll_detail tool with entity+month. NOT split by funding " +
          "stream (NDIS vs Home Care) — payroll codes carry pay type, not client " +
          "programme; say so if asked for stream-level wages.",
        months: payrollMonths.map((p) => ({
          entity: p.entityCode,
          month: p.month,
          gross: p.totalGross,
          super: p.totalSuper,
          allowances: p.totalAllowances,
          leaveTaken: p.totalLeaveTaken,
        })),
      }
    : { note: "No payroll data uploaded yet (Payroll detail page)." };

  const { answer, toolCallsFired } = await answerQuestion({
    question: input.question,
    dataAsOf,
    data,
    priorityData: { financials: financialsBlock, payroll: payrollBlock },
    attachments: input.attachments,
    history: input.history,
    memoryAddendum: formatMemoryAddendum(memory),
    voiceMode: input.voiceMode,
    // Identity that flows to recon as x-triggered-by when Mark calls the
    // create_draft_manual_journal tool. Always populated — "user:nicole" etc.
    draftJournalTriggeredBy: `user:${userPeer}`,
  });

  // Audit log: if the user attached files, record the filenames in the
  // question text so FinanceQuery shows "[Attached: a.pdf, b.xlsx, c.png] ..."
  // instead of a bare question with no trace of the inputs.
  const auditQuestion =
    input.attachments && input.attachments.length > 0
      ? `[Attached: ${input.attachments.map((a) => a.filename).join(", ")}] ${input.question}`
      : input.question;

  const row = await prisma.financeQuery.create({
    data: {
      askedBy: input.askedBy,
      question: auditQuestion,
      answer,
      dataAsOf: now,
    },
  });

  // Persist the turn to Honcho (best-effort; doesn't block the response).
  // Both messages get posted so the deriver builds an accurate transcript.
  if (input.sessionId) {
    await Promise.all([
      postTurn({
        sessionId: input.sessionId,
        peerId: userPeer,
        content: auditQuestion,
      }),
      postTurn({
        sessionId: input.sessionId,
        peerId: env.HONCHO_MARK_PEER,
        content: answer,
      }),
    ]);
  }

  return {
    answer,
    dataAsOf,
    queryId: row.id,
    sessionId: input.sessionId ?? null,
    memory: { disabled: memory.disabled, errored: memory.errored },
    toolCallsFired: toolCallsFired ?? 0,
  };
}
