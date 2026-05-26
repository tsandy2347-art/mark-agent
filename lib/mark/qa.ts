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
import { readLatestMetrics } from "./goals";

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
}

export async function askMark(input: AskInput): Promise<AskOutput> {
  const includeRestricted = Boolean(input.includeRestricted);
  const now = new Date();
  const dataAsOf = brisbane(now);
  const userPeer = input.askedBy || "anonymous";

  const [findings, metrics, statuses, memory] = await Promise.all([
    prisma.ingestedFinding.findMany({
      where: {
        resolved: false,
        ...(includeRestricted ? {} : { isPeopleFlag: false }),
      },
      orderBy: [{ severity: "asc" }, { at: "desc" }],
      take: 400,
    }),
    readLatestMetrics(),
    prisma.specialistRunStatus.findMany(),
    input.sessionId
      ? fetchMarkMemory({ sessionId: input.sessionId, userPeer })
      : Promise.resolve({ resume: [], memoryBlock: null, disabled: !env.HONCHO_BASE_URL, errored: false }),
  ]);

  // Compact the findings to a shape that's cheap to put in the context window
  // and that excludes raw evidence ids (which are noisy and not useful for
  // the model).
  const compactFindings = findings.map((f) => ({
    agent: f.specialistAgent,
    severity: f.severity,
    entity: f.entityCode,
    detector: f.detector,
    title: f.title,
    body: f.body.slice(0, 600),
    amount: f.amount == null ? null : Number(f.amount),
    at: f.at.toISOString(),
  }));

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

  const { answer } = await answerQuestion({
    question: input.question,
    dataAsOf,
    data,
    attachments: input.attachments,
    history: input.history,
    memoryAddendum: formatMemoryAddendum(memory),
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
  };
}
