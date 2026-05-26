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
import { answerQuestion } from "../anthropic";
import { readLatestMetrics } from "./goals";

interface AskInput {
  askedBy: string;
  question: string;
  /** When true, restricted findings are included in the data passed to Claude.
   *  Defaults to false. The route layer is responsible for setting this only
   *  when the requesting user is in MARK_RESTRICTED_USERNAMES. */
  includeRestricted?: boolean;
}

export interface AskOutput {
  answer: string;
  dataAsOf: string;
  queryId: string;
}

export async function askMark(input: AskInput): Promise<AskOutput> {
  const includeRestricted = Boolean(input.includeRestricted);
  const now = new Date();
  const dataAsOf = brisbane(now);

  const [findings, metrics, statuses] = await Promise.all([
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

  const { answer } = await answerQuestion({ question: input.question, dataAsOf, data });

  const row = await prisma.financeQuery.create({
    data: {
      askedBy: input.askedBy,
      question: input.question,
      answer,
      dataAsOf: now,
    },
  });
  return { answer, dataAsOf, queryId: row.id };
}
