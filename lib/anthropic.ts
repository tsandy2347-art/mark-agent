// Anthropic client + Mark's persona. Two entry points:
//
//   - synthesiseBrief(): writes the narrative + headline for a brief from the
//     provided structured data. Fail-quiet: if Claude is unreachable we return
//     a deterministic plain-English fallback assembled from the data itself,
//     so the brief always goes out, even on an Anthropic outage.
//
//   - answerQuestion(): Function E — natural-language Q&A. Same fail-quiet
//     behaviour: if Claude is unreachable we tell the user that, rather than
//     inventing a number.
//
// The system prompt encodes Mark's persona and his guardrails. It is the
// single place the synthesis voice is defined.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

const MARK_SYSTEM = `You are Mark, the Finance Manager for Just Better Care (JBC).
JBC operates two separate Pty Ltd entities: SC (Just Better Care Sunshine Coast)
and CQ (Just Better Care Central Queensland). They are separate taxpayers.

You sit on top of 7 finance specialists — Reconciliation, Controls & Audit,
Payroll & Labour, Payables, Revenue & Claims, Receivables, Tax & Compliance.
Each specialist does the maths; you do the SYNTHESIS.

HOW YOU "SEE" SOURCE SYSTEMS — read this carefully, it matters:

You do not call Xero, MYOB, AlayaCare, or the ATO portal yourself. You see
those systems THROUGH the specialists' findings. The findings are detailed:
they carry the source record's id (e.g. ManualJournalID, ContactID,
InvoiceID), narrations, amounts, line counts, ages, AI explanations, and
where available a clickable deep-link into the source system (look for
\`evidence.xeroLink\`, \`evidence.ManualJournalID\`, \`evidence.invoiceUrl\`,
etc.).

When a team member asks about a specific Xero / MYOB / AlayaCare record,
DO NOT respond "I don't have API access to Xero" or similar. That answer
is misleading — the specialist DOES read it for you, and the finding is in
your ingested data. Instead:

  1. Look through the structured findings for one whose \`evidence\` matches
     the record they're asking about (matching id, name, narration, or
     amount).
  2. If you find a match, quote what the specialist captured — narration,
     amount, age, lines — and offer the deep-link verbatim so they can
     drill in themselves.
  3. If you don't find a match, say "the specialists' current findings
     don't include that record" — that's honest. Don't claim you have no
     access.

The Reconciliation specialist holds Xero scopes
\`accounting.transactions.read\`, \`accounting.journals.read\`,
\`accounting.reports.read\`, \`accounting.settings.read\` — manual journals,
posted GL journals, contacts, reports, and settings are all reachable
through its findings.

ABSOLUTE RULES — these never bend:

1. You never overrule a specialist's maths. If two specialists disagree about a
   fact, surface the conflict for a human. Never silently pick a winner.

2. You escalate, you never act. You do not pay anything, lodge anything, send
   anything to suppliers, debtors, participants, or the ATO. You do not approve,
   release, or write off anything. The decision belongs to a human — Tony,
   Nicole, or the external accountant.

3. You never invent numbers. Only use the figures present in the data provided
   to you in this turn. If a figure is missing, say "I don't have that number"
   — never make one up, never average a guess.

4. Restricted routing is held. People-flag and individual-pay items go on the
   restricted brief only. If you are writing a daily / weekly / monthly brief,
   you reference the existence of restricted items only as a count: "1 restricted
   item — see separate brief". Names, salary figures, individual-staff details
   never appear in the non-restricted briefs.

5. Brisbane time, always. Display dates as "Sat 30 May 2026, 14:30 AEST". Never
   show raw UTC.

6. JBC terminology. Frontline office staff are Care Partners (not coordinators,
   not case managers). Field staff are Support Workers. Service recipients are
   participants (not clients, not customers, not patients). Care Partners at JBC
   work exclusively on SaH (aged care) — never frame them as NDIS-facing.

VOICE:
- A finance manager of 30 years. Plain English. Headline first.
- No jargon unless the jargon is doing real work.
- Honest about a worsening trend. Don't soften "we're behind on the $3M target"
  into "we're tracking carefully toward goal".
- Never accusatory. Specialists raise SIGNALS; you summarise signals; humans
  draw conclusions about people.

OUTPUT:
- When asked for a brief, return TWO sections in plain text:
    HEADLINE: <one line, the single most important thing>
    NARRATIVE: <the plain-English body — short paragraphs, no markdown headers
                unless the input explicitly asks for sections>
- When asked a question, answer in plain English. If you cannot answer from
  the data, say so. Always end with "Data as of <Brisbane timestamp>".`;

interface SynthesiseBriefInput {
  /** "daily" | "weekly" | "monthly" | "restricted" */
  briefType: string;
  /** "SC" | "CQ" | "consolidated" */
  entityScope: string;
  /** Brisbane-formatted timestamp string. */
  dataAsOf: string;
  /** Structured input — the maths Mark must NOT change. */
  data: unknown;
  /** Extra constraints to weave into the system prompt for this turn. */
  extraInstructions?: string;
}

export interface SynthesisOutput {
  headline: string;
  narrative: string;
  fromModel: boolean;
}

export async function synthesiseBrief(input: SynthesiseBriefInput): Promise<SynthesisOutput> {
  const c = client();
  const userPayload = JSON.stringify({
    briefType: input.briefType,
    entityScope: input.entityScope,
    dataAsOf: input.dataAsOf,
    data: input.data,
  });

  const userMsg =
    `Brief: ${input.briefType} / ${input.entityScope}\n` +
    `Data as of: ${input.dataAsOf}\n\n` +
    (input.extraInstructions ? `Extra constraints for this turn:\n${input.extraInstructions}\n\n` : "") +
    `Structured input:\n${userPayload}\n\n` +
    `Return your output in the format:\n` +
    `HEADLINE: <one line>\n` +
    `NARRATIVE: <plain English body>`;

  if (!c) {
    return fallbackSynthesis(input, "(Anthropic not configured — deterministic fallback)");
  }

  try {
    const resp = await c.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1800,
      system: MARK_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseHeadlineNarrative(text);
    if (!parsed) {
      return fallbackSynthesis(input, "(Anthropic returned unparseable output — deterministic fallback)");
    }
    return { headline: parsed.headline, narrative: parsed.narrative, fromModel: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return fallbackSynthesis(input, `(Anthropic call failed: ${reason} — deterministic fallback)`);
  }
}

function parseHeadlineNarrative(text: string): { headline: string; narrative: string } | null {
  // Tolerate markdown fences and extra leading text.
  const cleaned = text
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const headlineMatch = /HEADLINE:\s*(.+)/i.exec(cleaned);
  const narrativeMatch = /NARRATIVE:\s*([\s\S]+)/i.exec(cleaned);
  if (!headlineMatch || !narrativeMatch) return null;
  return {
    headline: headlineMatch[1].trim(),
    narrative: narrativeMatch[1].trim(),
  };
}

/** When Claude is down or unconfigured, render a minimal brief from the
 *  structured input directly so the channel still fires. Better a thin
 *  brief than silence (silence is the failure mode Mark must not have). */
function fallbackSynthesis(input: SynthesiseBriefInput, why: string): SynthesisOutput {
  // The structured input always carries an itemsForAction list — see brief.ts.
  // We don't try to be clever here; we just say "n items at priority X" and
  // hand the rest off to the rendered itemsForAction in the email body.
  let headline = `Mark ${input.briefType} brief (${input.entityScope}) — ${input.dataAsOf}`;
  let narrative = `Brief assembled without AI synthesis. ${why}\n\nThe structured items are listed below.`;
  try {
    const data = input.data as { itemsForAction?: Array<{ priority: string }>; specialistHealth?: Array<{ status: string }> };
    const items = data.itemsForAction ?? [];
    const today = items.filter((i) => i.priority === "today").length;
    const thisWeek = items.filter((i) => i.priority === "this-week").length;
    const note = items.filter((i) => i.priority === "note").length;
    const broken = (data.specialistHealth ?? []).filter((s) => s.status === "failed" || s.status === "stale").length;
    if (today > 0) {
      headline = `${today} item(s) need attention today`;
    } else if (thisWeek > 0) {
      headline = `${thisWeek} item(s) for this week, nothing on fire`;
    } else if (broken > 0) {
      headline = `${broken} specialist(s) silent — investigate before trusting the picture`;
    } else if (note > 0) {
      headline = `Nothing actionable — ${note} note(s) for the record`;
    } else {
      headline = `All clear`;
    }
    narrative =
      `${why}\n\n` +
      `Today: ${today}. This week: ${thisWeek}. Notes: ${note}. Silent specialists: ${broken}.\n\n` +
      `Detail follows below.`;
  } catch {
    // keep the default scaffolding
  }
  return { headline, narrative, fromModel: false };
}

export interface QaHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface QaPdf {
  filename: string;
  base64: string;
}

interface QaInput {
  question: string;
  dataAsOf: string;
  data: unknown;
  /** Optional PDFs the user uploaded. Anthropic API takes the bytes directly
   *  as `document` content blocks — no local pdf-parse. All PDFs are attached
   *  to the FIRST user message of the conversation, so they persist in context
   *  across follow-up turns. */
  pdfs?: QaPdf[];
  /** Prior conversation turns, oldest first. Each follow-up turn replays the
   *  full conversation — the Anthropic API is stateless, so we send the whole
   *  thing every time. */
  history?: QaHistoryTurn[];
}

export interface QaOutput {
  answer: string;
  fromModel: boolean;
}

export async function answerQuestion(input: QaInput): Promise<QaOutput> {
  const c = client();
  if (!c) {
    return {
      answer:
        `I can't answer right now — the AI layer isn't configured on this Mark instance. ` +
        `Data as of ${input.dataAsOf}.`,
      fromModel: false,
    };
  }
  try {
    const pdfs = input.pdfs ?? [];
    const pdfNote =
      pdfs.length > 0
        ? `The user has ATTACHED ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"}: ` +
          pdfs.map((p) => `"${p.filename}"`).join(", ") +
          `. Read each one carefully. Reason about their contents alongside the JBC ` +
          `finance data below. Same rules apply: only use figures that actually appear ` +
          `in the PDFs or the data — do not invent. If a document is outside JBC ` +
          `finance scope, say so honestly. When referring to a figure or quote from ` +
          `a PDF, name the file it came from so the reader can trace it.\n\n`
        : "";

    // Build the full message history. PDFs (if any) all go on the first user
    // message — that's either history[0] or, if there's no history, the
    // current question itself.
    const messages: Anthropic.Messages.MessageParam[] = [];
    let pdfPlaced = false;

    function userContentBlocks(text: string, attachPdfs: boolean): Anthropic.Messages.ContentBlockParam[] {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (attachPdfs) {
        for (const p of pdfs) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: p.base64 },
            title: p.filename,
          });
        }
      }
      blocks.push({ type: "text", text });
      return blocks;
    }

    for (const turn of input.history ?? []) {
      if (turn.role === "user") {
        const attach = !pdfPlaced && pdfs.length > 0;
        messages.push({ role: "user", content: userContentBlocks(turn.text, attach) });
        if (attach) pdfPlaced = true;
      } else {
        messages.push({ role: "assistant", content: turn.text });
      }
    }

    const currentText =
      `Question from a team member: ${input.question}\n\n` +
      pdfNote +
      `Data as of: ${input.dataAsOf}\n\n` +
      `Structured data you may use to answer (only use figures present here — ` +
      `if the answer is not in here, say so):\n` +
      `${JSON.stringify(input.data)}\n\n` +
      `Answer in plain English. End with: "Data as of ${input.dataAsOf}."`;

    const attachCurrent = !pdfPlaced && pdfs.length > 0;
    messages.push({ role: "user", content: userContentBlocks(currentText, attachCurrent) });

    const resp = await c.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1800,
      system: MARK_SYSTEM,
      messages,
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) {
      return {
        answer: `I don't have an answer for that from the current data. Data as of ${input.dataAsOf}.`,
        fromModel: false,
      };
    }
    return { answer: text, fromModel: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      answer: `I couldn't reach the AI layer (${reason}). Data as of ${input.dataAsOf}.`,
      fromModel: false,
    };
  }
}
