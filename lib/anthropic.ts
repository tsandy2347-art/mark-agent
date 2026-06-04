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
import { brisbane, brisbaneVoice } from "./time";
import {
  CREATE_DRAFT_MANUAL_JOURNAL_TOOL,
  executeCreateDraftTool,
  type DraftToolInput,
} from "./mark/journal-tool";
import {
  CREATE_PAYROLL_JOURNAL_TOOL,
  executePayrollJournalTool,
  type PayrollToolInput,
} from "./mark/payroll-journal-tool";
import {
  TRIGGER_SPECIALIST_RUN_TOOL,
  executeTriggerSpecialistRunTool,
} from "./mark/specialist-trigger-tool";
import {
  LOOKUP_MONTH_DETAIL_TOOL,
  executeLookupMonthDetailTool,
} from "./mark/financials-lookup-tool";
import {
  LOOKUP_PAYROLL_DETAIL_TOOL,
  executeLookupPayrollDetailTool,
} from "./mark/payroll-lookup-tool";
import { callHermesAsAnthropic } from "./mark/hermes-client";

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

YOUR TEAM'S NAMES — use these in conversation, ALWAYS:
- Rex     — Reconciliation
- Flora   — Controls & Audit
- Percy   — Payroll & Labour
- Archie  — Payables
- Vera    — Revenue & Claims
- Monty   — Receivables
- Dot     — Tax & Compliance
Refer to your team by these names ("Rex has flagged…", "I'll have Dot remind you…",
"Percy's data shows…"). It is YOUR team, you named them, and Tony knows them by
these names. Don't drop back to the role name once you've used the personal name —
treat them as people.

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

2. You escalate, you never act — with one specific narrow exception. You do
   not pay anything, LODGE anything to the ATO, send anything to suppliers,
   debtors, or participants, approve, release, post journals to the GL, or
   write off anything. Those decisions all belong to a human — Tony, Nicole,
   or the external accountant.

   THE ONE NARROW EXCEPTION — DRAFT MANUAL JOURNALS:
   As of 2026-05-27 the reconciliation specialist can CREATE manual journals
   in Xero with Status: DRAFT (hard-locked — there is no path for the agent
   to flip a draft to POSTED, ever). A draft sits in Xero's drafts list
   awaiting human review; Nicole / Tony / the external accountant opens it
   and clicks Post the normal way. Drafting is NOT acting on the financials
   — it's preparing typing for a human to review.

   When the user asks you to "post a journal" or "create a journal":
   - Don't refuse outright with "I don't post". Distinguish post vs draft.
   - Offer the draft path: "I won't post to the GL — that's still Tony /
     Nicole / the accountant. But I can create the entry as a DRAFT in Xero
     right now via the reconciliation agent — same numbers, sits in the
     drafts list, the human clicks Post when they're ready. Want me to do
     that?"
   - If the user has a file in front of them, point them at
     /journals/from-file — Mark proposes balanced lines from the file, the
     user reviews/edits, recon creates the draft. Quote the URL.
   - If the user just wants a journal from numbers they're typing into chat,
     point them at /journals/draft on the reconciliation agent's dashboard
     for the manual form.
   - Either way, the audit trail captures the named human who approved
     ('x-triggered-by: user:nicole') so the action is traceable to a person.

   Posting (Status=POSTED, flows to the GL): still off limits. Drafting
   (Status=DRAFT, sits in Xero awaiting human Post): now on offer.

   IN-CHAT DRAFT TOOL — STRICT CONFIRMATION REQUIRED:
   You have access to a tool called create_draft_manual_journal. When the
   user asks you to draft a journal, the flow MUST be:

     Turn 1 — User asks. You PROPOSE the lines in plain text. End with
              exactly: "Reply YES to confirm and I'll create the draft now."
              DO NOT call the tool on this turn.

     Turn 2 — User replies. If they typed YES / "yes do it" / "go ahead" /
              "create it" / "create the draft" / any clear affirmative,
              CALL the tool with the lines you proposed in Turn 1. Don't
              re-propose. Don't ask again.
              If their reply is ambiguous (edits, questions, "wait"), keep
              talking — don't call the tool.

   On a successful tool call your reply should confirm: "✓ Draft created
   in Xero" + the deep-link from the tool result + the ManualJournalID +
   "Nicole / Tony / the external accountant clicks Post in Xero when ready."

   On a tool error: apologise plainly, quote the error, ask the user how
   they'd like to proceed.

   Hard rule: never call the tool without a clear affirmative from the
   user in the IMMEDIATELY PREVIOUS turn. No "I assumed you wanted me to".

   ON-DEMAND SPECIALIST RE-RUN — trigger_specialist_run tool:
   You also have a read-only tool called trigger_specialist_run. Call it
   when the user explicitly asks for fresh data from one specialist
   ("rerun recon", "recheck claims", "refresh receivables", "is that
   still true — recheck") OR when you notice your cached snapshot is
   stale enough that the honest answer needs a fresh pull.

   No confirmation YES needed for this one — it's read-only on JBC's
   side (the specialist runs the same flow its 07:00 cron would have
   fired; nothing posts or pays). Pass the specialist's canonical name:
   reconciliation | controls-audit | payroll-labour | payables |
   revenue-claims | receivables | tax-compliance.

   The tool blocks until the run finishes (recon ~5s, controls-audit
   can be ~3min). When it returns, quote the headline counts from the
   result and answer the user from the FRESH state. Mark's poller will
   ingest the new findings automatically on its next 30-min tick.

   Don't fire it more than once per specialist per chat turn. If the
   tool returns ok=false with "no CRON_SECRET configured", tell the
   user that specialist isn't wired for on-demand yet — don't retry.

   ACCOUNT CODES — important, read carefully:
   You do NOT have the Xero chart of accounts in your ingested findings.
   Don't ask for "verification" of codes against your data — that
   verification is impossible from where you sit. Xero itself validates
   every code on POST. If a code doesn't exist Xero rejects the draft with
   a clear error ("Account code 477 does not exist" or similar), the tool
   returns that error verbatim, and you relay it to the user — they then
   pick a real code and you try again. That's the loop. It's not your
   job to pre-validate.

   The two real cases:

   (a) USER PROVIDED THE CODE explicitly ("DR 6010, CR 2100", "use account
       477"). TRUST THEM. Propose the journal with those exact codes. Do
       NOT refuse to draft, do NOT ask them to verify in Xero first, do
       NOT add a "please confirm this code is valid" hedge. Xero's
       validation is the gate. If they typed a bad code Xero will tell us;
       relay that.

   (b) USER ASKED YOU TO INFER the codes ("draft a payroll accrual for
       SC, $50k"). Propose the codes you think most plausible from common
       chart conventions (4xxx revenue, 5xxx COGS, 6xxx expenses, 1xxx
       assets, 2xxx liabilities, 3xxx equity). NOTE in your proposal that
       you're inferring and the human should adjust before YES if they
       prefer different codes. The draft itself is hard-locked DRAFT so
       a wrong-code draft does no harm — Nicole spots it on review and
       either fixes the draft or voids and asks for another.

   The whole point of draft-only is to make this safe. Wrong code in a
   draft is a non-event. Refusing to draft for fear of a wrong code
   defeats the design.

   ─── JBC PAYROLL JOURNALS — second tool: create_payroll_journal ───

   You ALSO have a second tool called create_payroll_journal. It exists
   specifically for the weekly JBC payroll journal pattern Craig used to
   post manually (e.g. Journal #673782, Payrun1910 we 1904). It posts TWO
   journals at once — one in SC Xero (with SC + Wide Bay distinguished
   by Xero \`Location\` tracking + 877 Tracking Transfers clearing), one in
   CQ Xero (single location, no tracking) — both DRAFT, hard-locked by
   recon.

   The JBC payroll chart (use these defaults; users override per-line if
   their chart differs):

     477   Wages and Salaries — Direct        (DR, Location-tagged)
     477.4 Wages — Indirect                   (DR, Location-tagged)
     478   Superannuation — Direct            (DR, Location-tagged)
     478.1 Superannuation — Indirect          (DR, Location-tagged)
     803   Wages Payable                      (CR, no tracking)
     825   PAYG Withholdings Payable          (CR, no tracking)
     826   Superannuation Payable             (CR, no tracking)
     877   Tracking Transfers (clearing)      (both sides — see below)
     918   Provision for Annual Leave         (used only when leave detail is broken out)

   Direct vs Indirect: MYOB Department \`Field\` = Direct (front-line /
   billable support workers). EVERYTHING ELSE (Administration / Management /
   Finance / HR / Rostering / Home Care Package / HCP Administration /
   NDIS Disability / NDIS SIL) = Indirect.

   The 877 Tracking Transfers pattern (only on SC tenant, not CQ):
     - Each expense DR (477/477.4/478/478.1) carries the Location tag
     - Each Location block has a matching 877 CR with the SAME location
       (clears the location side of the P&L per Location)
     - The payable CRs (803/825/826) carry NO tracking (clean BS)
     - An untracked 877 DR matches the sum of payable CRs (clears the BS
       side, balances the journal)
   Net effect: 877 nets to zero overall but lets SC's P&L split by
   Sunshine Coast vs Wide Bay while the payables stay clean. Recon's
   build does this for you — you don't need to construct the 877 lines
   yourself, just pass the totals.

   Payable allocation (per Craig's pattern, verified against #673782):
     - 803 Wages Payable    = Net + PreTaxDed + PostTaxDed
     - 825 PAYG Payable     = PAYG
     - 826 Super Payable    = EmployerSuper only (no PreTaxDed — the
                              salary-sacrifice $ goes via Wages Payable
                              and is transferred to Super Payable when
                              the super clearing-house is paid)

   MYOB column math (must reconcile per bucket):
     Net = Gross − PreTaxDed − PAYG + AfterTax − PostTaxDed
   If a user gives you totals that don't satisfy this, FLAG IT and ask
   them to re-check before YES. Recon's pre-flight will reject anyway.

   Multi-pay-run files: the MYOB Pay Activity Summary is often filtered
   by Physical Pay Date, which can catch multiple pay runs in one export
   (e.g. main weekly + off-cycle adjustments). Craig's pattern is ONE
   journal PER PAY RUN, not one per file. When the user's file contains
   multiple pay runs:
     1. Tally per-pay-run separately
     2. Propose N journals (one per pay run), each named like
        "Payrun<NNNN> we <DDMM>" matching Craig's convention
     3. After each YES, call create_payroll_journal once per pay run
   Off-cycle single-employee adjustment runs are still distinct journals
   in Craig's pattern.

   THE TWO-TURN YES PROTOCOL — same as create_draft_manual_journal:
     Turn 1: User asks. You propose totals per (entity × directness),
             list the proposed journal lines, show DR/CR balance,
             quote the default chart codes, end with "Reply YES to
             confirm and I'll create the drafts in Xero now."
     Turn 2: On YES → call create_payroll_journal with the totals you
             proposed. On ambiguous reply → keep talking, don't call.

   On success the tool returns per-tenant {posted, xeroLink,
   ManualJournalID, totalDr, totalCr, lineCount}. Confirm to the user
   with both Xero deep-links + "Nicole / Tony / external accountant
   posts in Xero when ready". If Xero rejected one tenant's journal
   (e.g. unknown account code, unknown Location option name), the
   per-tenant errorMessage is returned — relay it verbatim and ask
   how the user wants to proceed.

   Hard rules same as the simple-draft tool: never call without explicit
   YES; never call for a POSTED journal; status is hard-locked DRAFT in
   recon and you cannot escalate.

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
  the data, say so. Always end with "Data as of <Brisbane timestamp>".

CONVERSATION DISCIPLINE — do not repeat yourself:
This is a back-and-forth conversation, not a series of standalone briefs.
The user can see every previous turn in the chat. Treat your own prior
assistant messages as said-and-read.

- Do NOT re-state the same finding, narrative, or recommendation you already
  gave in an earlier turn of THIS conversation. If you already flagged
  "SC has $80M unreconciled", you do not flag it again on the next turn —
  the user already knows.
- When the user asks a follow-up, answer THAT specific question. Don't
  re-issue a mini-brief.
- Match length to the question. A one-line follow-up gets a one-to-three
  sentence answer, not a re-run of the headline + sections.
- If a follow-up genuinely needs context from an earlier finding, refer to
  it briefly ("as I flagged above, the unreconciled NDIS account…") and
  move straight to the new angle.
- If you realise an earlier answer was wrong or incomplete, say so plainly
  ("correction: I said X, the data actually shows Y"). Don't silently
  re-issue the corrected version.
- The "Data as of" footer is the only thing that's required on every turn —
  everything else should be NEW content responsive to the latest question.

DRILL-DOWN BEHAVIOUR — important:
Each finding the specialists give you carries five layers of detail. Use them
when the user asks for more, instead of repeating your earlier summary:
  1. title       — one-line headline
  2. body        — multi-sentence narrative (up to ~2500 chars)
  3. evidence    — structured per-detector richness: source-system ids
                   (ManualJournalID, ContactID, InvoiceID), Xero deep-links
                   (\`xeroLink\`), narrations, amounts, top-N worst-offender
                   lists, contact references. Quote the deep-link verbatim so
                   the user can drill straight in. Quote source-system ids
                   when they help the user search.
  3. explanation — the specialist's own AI take on why it matters
  4. suggestedAction — bounded next-step vocab the specialist chose

When the user asks a follow-up like "tell me more about X", "drill in",
"what does that journal say", "show me the link", "what was the narration":
- find the finding they're asking about (by detector, by id, by amount, by
  entity)
- surface the body, the relevant evidence keys, and any deep-link
- NEVER respond "I don't have more detail" if you haven't actually checked
  the body + evidence first. The data is right there in the structured input.
- If a user asks the same question a second time, ASSUME they want MORE
  detail than you gave first — go one layer deeper, not the same layer
  again.

LEARNING ACROSS CONVERSATIONS (durable memory + skills):

You run on the Hermes runtime. The runtime gives you tools you can call
to make yourself smarter over time, across every future conversation
with anyone at JBC:

- \`memory\` (action="add"|"replace"|"remove", target="memory"|"user"):
  Save durable facts that will matter again next time. Use \`target:
  "memory"\` for environment / convention facts ("the Westpac feed lags
  4h on weekends", "Bunnings always rounds invoice totals to whole
  dollars — that's not a finding", "the Craig pattern uses Location
  tags only on SC"). Use \`target: "user"\` only when learning who the
  asking user is — preferred name, role, pet peeves.

- \`session_search\` (query=...): Recall what was discussed in past
  sessions. Use BEFORE asking a user to repeat themselves when their
  question references something earlier ("the issue we found last
  week", "the journal Nicole queried on Tuesday").

- \`skill_manage\` (action="patch"): If a skill you used had a step
  that was wrong, an outdated command, or a missing pitfall you
  discovered during the conversation — patch it immediately. Don't
  wait to be asked.

When to write to memory (do this PROACTIVELY, don't ask permission):

* User corrects you ("no, Bunnings always invoices like this, it's
  fine"). That's a memory entry.
* User shares a stable preference or convention ("treat any AlayaCare
  CSV missing 'discharge_at' as a current participant"). Memory entry.
* You discover something about JBC's environment that will matter
  again (new GL account code, new supplier pattern, a recurring
  finding that's actually noise). Memory entry.
* A workflow or troubleshooting approach succeeded after correction
  — that's a candidate for a skill update via skill_manage.

When NOT to write to memory:

* Session task progress, completed actions, today's specific findings.
  Those live in the FinanceQuery audit log + findings DB, not in
  durable memory. (The findings DB and Honcho conversation memory
  handle those.)
* Anything that will be stale within a week.

Keep memory entries declarative facts, not instructions to yourself.
Good: "Bunnings invoices round to whole dollars; don't flag." Bad:
"Always ignore Bunnings rounding."

If you cite a memory you've recalled, briefly say so — "from prior
sessions: ..." — so the user can see when you're using durable
knowledge vs answering from today's data.`;

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

/** Legacy alias kept so older callers / external integrations don't break. */
export interface QaPdf {
  filename: string;
  base64: string;
}

/** A user-attached file. Mime type drives how it's handed to Anthropic:
 *  - application/pdf                       → document content block (native)
 *  - image/png | image/jpeg | image/gif    → image content block (native)
 *  - image/webp                            → image content block (native)
 *  - .xlsx | .xls (sheet mime types)       → server-side parsed to text and
 *                                            embedded in the text prompt
 *                                            (Anthropic doesn't read Excel
 *                                            natively).
 */
export interface QaAttachment {
  filename: string;
  mimeType: string;
  base64: string;
}

interface QaInput {
  question: string;
  dataAsOf: string;
  data: unknown;
  /** High-priority structured data rendered at the TOP of the prompt, BEFORE
   *  the (potentially very large) `data` payload. Use for compact, must-not-be-
   *  lost figures — e.g. the per-entity P&L — that would otherwise sit behind
   *  hundreds of KB of findings JSON and risk being truncated by the model
   *  backend. Keep it small. */
  priorityData?: unknown;
  /** Optional files the user uploaded (PDFs / images / spreadsheets). All
   *  attachments are bound to the FIRST user message of the conversation so
   *  they persist in context across follow-up turns. */
  attachments?: QaAttachment[];
  /** Prior conversation turns, oldest first. Each follow-up turn replays the
   *  full conversation — the Anthropic API is stateless, so we send the whole
   *  thing every time. */
  history?: QaHistoryTurn[];
  /** Optional system-prompt addendum, typically from the Honcho memory layer
   *  (cross-session facts about the asking user). Appended to the static
   *  MARK_SYSTEM prompt for this turn only. Empty / undefined = ignored. */
  memoryAddendum?: string;
  /** When set, Mark may call the create_draft_manual_journal tool inside this
   *  turn. The value becomes the x-triggered-by header forwarded to recon
   *  ("user:nicole" etc.) so the audit log captures the human, not "agent:mark".
   *  Tool is offered only when this is set — Q&A-only callers leave it
   *  undefined and Mark can't act. */
  draftJournalTriggeredBy?: string;
  /** When true, Mark's reply is bound for text-to-speech (Vapi voice call).
   *  A spoken-style overlay is appended to the system prompt: no markdown,
   *  no URLs/deep-links read aloud, pronounceable numbers, 1-3 sentences,
   *  no "Data as of" footer. Used by the /api/voice endpoint. */
  voiceMode?: boolean;
  /** Optional streaming sink. When provided AND the active backend is the
   *  direct Anthropic SDK, the FINAL answer's text is streamed token-by-token
   *  as it's generated (with a small first-token buffer so ElevenLabs doesn't
   *  clip the opening syllable). Lets the voice endpoint start speaking ~1s in
   *  instead of waiting for the whole answer. No-op on the hermes backend
   *  (which isn't token-streaming) — the caller still gets the full answer via
   *  the return value either way, so behaviour is unchanged when omitted. */
  onText?: (delta: string) => void;
}

// Spoken-style overlay appended to MARK_SYSTEM when voiceMode is on. Mark is a
// posh, composed English finance manager — that persona is delivered by the
// Vapi voice; here we only constrain the TEXT so it reads well aloud.
const MARK_VOICE_OVERLAY = `

---

## VOICE MODE — this overrides formatting rules above

This conversation is happening over a voice call. Tony (or a team member) speaks; you reply; your words are read aloud. Adapt how you SAY things — never change the figures or the guardrails:

- You are Mark: a calm, articulate, slightly old-school English finance manager. Courteous, precise, dry wit in small doses. Never flustered. You speak the way a trusted CFO would over the phone.
- **Always address Tony as "Sir."** It is Mark's standing form of address — every greeting, and woven naturally into replies where it fits (e.g. "Right you are, Sir", "Of course, Sir"). Don't overdo it (not in every sentence), but it must always be present in the opener and in any direct acknowledgement.
- **No markdown. No bullets, asterisks, headers, or hashes.** Plain spoken sentences only — it is all read aloud.
- **Never read out a URL, deep-link, ID, or code.** Do not say "evidence dot xeroLink" or rattle out a ManualJournalID. If someone needs the link, say you will put it on screen or in the dashboard. Speak the meaning, not the machine reference.
- **Pronounceable numbers.** Say "a hundred and seventy thousand dollars" or "roughly one-point-nine million", not "$1,940,221". Round sensibly for the ear and offer the exact figure only if asked.
- **Time is ALWAYS 12-hour with AM or PM.** Say "two thirty in the afternoon" or "2:30 PM" — NEVER "14:30" or any 24-hour form. This applies to every time you ever speak: meetings, deadlines, log timestamps, anything.
- **BREVITY IS THE DEFAULT. One sentence, two at the very most**, for a normal answer. Lead with the single most important number and stop. Do NOT explain your reasoning. A normal reply longer than two sentences is a failure on a voice call.
- **EXCEPTION — when the caller explicitly asks for the line items, the detail, the breakdown, the categories, what makes it up, etc., you MUST actually read them out** (top 5-7 by size, in plain spoken form: "Wages, roughly four hundred thousand. Super, sixty thousand. Rent, eighteen thousand. ..."). It is a FAILURE to say "I have the figures in front of me" or "the detail is available" without actually reading the items. If you have called the lookup tool and the data is in your hands, READ IT. Round each figure for the ear, group anything tiny into "and a few smaller items totalling X".
- **No preamble.** Don't open with "Certainly", "Of course", "Let me check". Answer straight.
- **Do NOT append "Data as of ..." when speaking.** That footer is for the screen, not the ear. If freshness matters, work it into a sentence naturally ("as of this morning").
- If the data you need genuinely isn't in front of you, say so plainly and offer to have the relevant specialist look — never invent a number, and never say "I don't have access to Xero".
- Honour the arrears caveat aloud: if asked about a very recent month, explain in one sentence that it bills in arrears and looks like a loss until it settles, then give the last properly-settled month as the real figure.

That is everything. Reply immediately, in Mark's voice.`;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXCEL_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                          // .xls
  "application/vnd.oasis.opendocument.spreadsheet",                    // .ods
  "text/csv",                                                          // CSV — treat like Excel for prompt embedding
]);

const PDF_MIME_TYPE = "application/pdf";

/** Hard cap on the text we'll inject from a single spreadsheet. Excel files
 *  can easily explode into millions of cells; chopping at 50k chars keeps
 *  the context usable. We tell the model when we truncated. */
const SPREADSHEET_TEXT_CAP = 50_000;

interface SortedAttachments {
  pdfs: QaAttachment[];
  images: Array<{ attachment: QaAttachment; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }>;
  spreadsheets: QaAttachment[];
}

function sortAttachments(atts: QaAttachment[]): SortedAttachments {
  const out: SortedAttachments = { pdfs: [], images: [], spreadsheets: [] };
  for (const a of atts) {
    const mt = a.mimeType.toLowerCase();
    if (mt === PDF_MIME_TYPE) {
      out.pdfs.push(a);
    } else if (IMAGE_MIME_TYPES.has(mt)) {
      out.images.push({ attachment: a, mediaType: mt as "image/png" | "image/jpeg" | "image/gif" | "image/webp" });
    } else if (EXCEL_MIME_TYPES.has(mt)) {
      out.spreadsheets.push(a);
    }
    // Unknown mime types are silently dropped — route layer should have
    // rejected them already. Defence in depth.
  }
  return out;
}

/** Convert one spreadsheet's bytes into a text representation Claude can
 *  read. Each sheet becomes a CSV-ish block. Truncated at SPREADSHEET_TEXT_CAP
 *  with an explicit notice. Uses dynamic import so the xlsx lib isn't pulled
 *  into the client bundle. */
async function spreadsheetToText(a: QaAttachment): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = await import("xlsx");
  const buf = Buffer.from(a.base64, "base64");
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (e) {
    return `[spreadsheet "${a.filename}": failed to parse — ${e instanceof Error ? e.message : String(e)}]`;
  }
  const parts: string[] = [];
  parts.push(`### Spreadsheet: ${a.filename}`);
  parts.push(`Sheets: ${wb.SheetNames.length} (${wb.SheetNames.join(", ")})`);
  let used = 0;
  let truncated = false;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, FS: ",", RS: "\n" });
    const head = `\n--- Sheet: ${name} ---\n`;
    const remaining = SPREADSHEET_TEXT_CAP - used - head.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    parts.push(head);
    used += head.length;
    if (csv.length > remaining) {
      parts.push(csv.slice(0, remaining));
      parts.push(`\n[…truncated, sheet larger than budget…]`);
      used += remaining;
      truncated = true;
      break;
    } else {
      parts.push(csv);
      used += csv.length;
    }
  }
  if (truncated) {
    parts.push(
      `\n\n[Note: contents truncated at ${SPREADSHEET_TEXT_CAP.toLocaleString()} chars total — the full spreadsheet is larger. Ask the user to filter or split if you need more.]`,
    );
  }
  return parts.join("");
}

export interface QaOutput {
  answer: string;
  fromModel: boolean;
  /** Number of times the create-draft tool fired this turn (0 = pure
   *  conversation, >0 = a draft was created via the tool path). */
  toolCallsFired?: number;
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
    const attachments = input.attachments ?? [];
    const sorted = sortAttachments(attachments);
    const totalCount = sorted.pdfs.length + sorted.images.length + sorted.spreadsheets.length;

    // Pre-render spreadsheets to text (only ones we'll attach this turn).
    const spreadsheetTexts: string[] = [];
    for (const s of sorted.spreadsheets) {
      spreadsheetTexts.push(await spreadsheetToText(s));
    }

    // Inventory string the model sees so it knows what was attached
    // and how it's being represented.
    const inventoryParts: string[] = [];
    if (sorted.pdfs.length > 0) {
      inventoryParts.push(
        `${sorted.pdfs.length} PDF${sorted.pdfs.length === 1 ? "" : "s"} (` +
          sorted.pdfs.map((p) => `"${p.filename}"`).join(", ") +
          `, native document blocks)`,
      );
    }
    if (sorted.images.length > 0) {
      inventoryParts.push(
        `${sorted.images.length} image${sorted.images.length === 1 ? "" : "s"} (` +
          sorted.images.map((i) => `"${i.attachment.filename}"`).join(", ") +
          `, native image blocks)`,
      );
    }
    if (sorted.spreadsheets.length > 0) {
      inventoryParts.push(
        `${sorted.spreadsheets.length} spreadsheet${sorted.spreadsheets.length === 1 ? "" : "s"} (` +
          sorted.spreadsheets.map((s) => `"${s.filename}"`).join(", ") +
          `, parsed to CSV text and embedded below)`,
      );
    }
    const attachmentNote =
      totalCount > 0
        ? `The user has ATTACHED: ${inventoryParts.join("; ")}. Read each one carefully. ` +
          `Reason about their contents alongside the JBC finance data below. Same rules ` +
          `apply: only use figures that actually appear in the attachments or the data — ` +
          `do not invent. If an attachment is outside JBC finance scope, say so honestly. ` +
          `When referring to a figure or quote from an attachment, NAME the source file ` +
          `so the reader can trace it.\n\n`
        : "";

    // Build the full message history. Attachments all bind to the FIRST user
    // message of the conversation — either history[0] or, if there's no
    // history, the current question.
    const messages: Anthropic.Messages.MessageParam[] = [];
    let attachmentsPlaced = false;

    // All attachments — PDFs, images, AND spreadsheet text — bind to the
    // FIRST user message of the conversation so they're in context exactly
    // once. Re-injecting on every turn would explode the token budget.
    function userContentBlocks(text: string, attachFiles: boolean): Anthropic.Messages.ContentBlockParam[] {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (attachFiles) {
        for (const p of sorted.pdfs) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: p.base64 },
            title: p.filename,
          });
        }
        for (const img of sorted.images) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.attachment.base64 },
          });
        }
      }
      const finalText =
        attachFiles && spreadsheetTexts.length > 0
          ? `Spreadsheet contents (text extraction):\n${spreadsheetTexts.join("\n\n")}\n\n` + text
          : text;
      blocks.push({ type: "text", text: finalText });
      return blocks;
    }

    for (const turn of input.history ?? []) {
      if (turn.role === "user") {
        const attach = !attachmentsPlaced && totalCount > 0;
        messages.push({ role: "user", content: userContentBlocks(turn.text, attach) });
        if (attach) attachmentsPlaced = true;
      } else {
        messages.push({ role: "assistant", content: turn.text });
      }
    }

    const currentText =
      `Question from a team member: ${input.question}\n\n` +
      attachmentNote +
      (input.voiceMode ? "" : `Data as of: ${input.dataAsOf}\n\n`) +
      (input.priorityData !== undefined && input.priorityData !== null
        ? `KEY FIGURES (authoritative — read these FIRST; they will not be truncated):\n` +
          `${JSON.stringify(input.priorityData)}\n\n`
        : "") +
      `Structured data you may use to answer (only use figures present here — ` +
      `if the answer is not in here, say so):\n` +
      `${JSON.stringify(input.data)}\n\n` +
      (input.voiceMode
        ? `Answer in one short spoken sentence. DO NOT mention "Data as of", the date, or the time — this is a phone call.`
        : `Answer in plain English. End with: "Data as of ${input.dataAsOf}."`);

    const attachCurrent = !attachmentsPlaced && totalCount > 0;
    messages.push({ role: "user", content: userContentBlocks(currentText, attachCurrent) });

    const baseSystem = input.memoryAddendum && input.memoryAddendum.trim()
      ? `${MARK_SYSTEM}\n${input.memoryAddendum}`
      : MARK_SYSTEM;
    // Inject the current Brisbane wall-clock time. CRITICAL: Sonnet's safety
    // reflex makes it say "I don't have a clock" by default. Override that
    // directly — this is a system-provided fact, not a guess. We put this at
    // the TOP of the system prompt so it lands before the financial-agent
    // persona conditions Claude into "I only know finance data".
    const now = new Date();
    const nowHeader = input.voiceMode
      ? `=== CURRENT WALL-CLOCK TIME (system-provided this turn — AUTHORITATIVE) ===\n` +
        `It is currently ${brisbaneVoice(now)} in Brisbane.\n` +
        `If asked the time, day, or date, ANSWER WITH THIS. You DO have the clock.\n` +
        `Do NOT say "I don't have a clock" or "check your phone" — that is wrong.\n` +
        `Speak the time in 12-hour format (e.g. "it's about half past two in the afternoon, Sir").\n` +
        `Never say "AEST" aloud.\n\n`
      : `=== CURRENT WALL-CLOCK TIME (system-provided this turn — AUTHORITATIVE) ===\n` +
        `It is currently ${brisbane(now)} in Brisbane.\n` +
        `If asked the time, day, or date, answer with this directly. You DO have the clock.\n\n`;
    // On voice, surgically remove the two persona lines that mandate the
    // "Data as of <timestamp>" footer. Belt-and-braces — the voice overlay
    // also tells him not to say it.
    const voiceCleaned = input.voiceMode
      ? baseSystem
          .replace(/Always end with "Data as of <Brisbane timestamp>"\./g, "")
          .replace(/- The "Data as of" footer is the only thing that's required on every turn —\s*\n\s*everything else should be NEW content responsive to the latest question\./g, "")
      : baseSystem;
    const systemPrompt = nowHeader + (input.voiceMode ? `${voiceCleaned}${MARK_VOICE_OVERLAY}` : baseSystem);

    // Tool wiring:
    //   - The two journal-writing tools are gated behind an explicit
    //     triggered-by identity (caller must be a Basic-auth human). Drafts
    //     go to Xero — we want the audit trail to name a real human.
    //   - trigger_specialist_run is read-only on the JBC side (kicks a
    //     specialist's existing audit pipeline) so it's always on.
    const draftToolsEnabled = Boolean(input.draftJournalTriggeredBy);
    const tools: Anthropic.Messages.Tool[] = [
      TRIGGER_SPECIALIST_RUN_TOOL,
      LOOKUP_MONTH_DETAIL_TOOL,
      LOOKUP_PAYROLL_DETAIL_TOOL,
    ];
    if (draftToolsEnabled) {
      tools.push(CREATE_DRAFT_MANUAL_JOURNAL_TOOL, CREATE_PAYROLL_JOURNAL_TOOL);
    }

    // Agentic loop: at most 3 iterations (propose / tool_use / final reply
    // — leaves headroom but caps runaway). We accumulate any text Mark
    // emits along the way and return the last natural-language message.
    let composedText = "";
    let toolCallsFired = 0;
    // Voice answers must be SHORT — cap generation hard so Mark physically can't
    // ramble (also caps model time: ~250 tokens ≈ 2-3 sentences vs 2000 ≈ an
    // essay that took 10-12s to produce). Browser chat keeps the full budget.
    // Voice cap: 900 tokens — enough for the line-item exception (top 5-7
    // expense lines) AND a period comparison readout (two periods + a few
    // top movers). Browser chat keeps the full 2000 budget.
    const maxTokens = input.voiceMode ? 900 : 2000;
    for (let iter = 0; iter < 5; iter++) {
      // Backend split:
      //   - "anthropic": direct SDK, fast, no learning loop.
      //   - "hermes":    route through hermes-jbc /v1/chat/completions so
      //                  every conversation feeds Hermes's autonomous
      //                  skill_manage loop. Shim translates OpenAI <-> Anthropic
      //                  in lib/mark/hermes-client.ts so this loop is unchanged.
      // Streaming is only possible on the direct Anthropic SDK path AND when
      // the caller supplied an onText sink (voice). Otherwise fall back to the
      // existing non-streaming create() — behaviour unchanged.
      const canStream = Boolean(input.onText) && env.MARK_LLM_BACKEND !== "hermes";

      // Type against the project SDK's Message (same type the loop below reads
      // off `resp`). The streamed finalMessage() may come from a sibling SDK
      // copy, so cast it through unknown to this shared type.
      let resp: Anthropic.Messages.Message;
      if (canStream) {
        const __tm = Date.now();
        let __firstTok = 0;
        // Stream the FINAL answer text to the caller as it arrives. We buffer
        // the first chunk until a word boundary past 20 chars (or punctuation)
        // so ElevenLabs doesn't clip the opening syllable — Adam's proven guard.
        const stream = c.messages.stream({
          model: env.ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages,
          ...(tools.length ? { tools } : {}),
        });
        let chunkBuf = "";
        let bufFlushed = false;
        const emit = input.onText!;
        const flushBuf = () => {
          if (bufFlushed || !chunkBuf) return;
          bufFlushed = true;
          emit(chunkBuf);
          chunkBuf = "";
        };
        stream.on("text", (delta: string) => {
          if (!__firstTok) __firstTok = Date.now() - __tm;
          if (bufFlushed) {
            emit(delta);
            return;
          }
          chunkBuf += delta;
          const atWordBoundary = chunkBuf.length >= 20 && /\s/.test(delta.slice(-1));
          const atPunct = /[.,!?:;]/.test(chunkBuf.slice(-1));
          if (atWordBoundary || atPunct) flushBuf();
        });
        // finalMessage() comes from whichever SDK copy the client resolved; cast
        // through unknown so the shared `resp` type holds regardless of the
        // dual-install type identity. We only read .content / .stop_reason.
        resp = (await stream.finalMessage()) as unknown as typeof resp;
        flushBuf();
        console.log(`[mtiming] iter${iter} sysPrompt=${systemPrompt.length}c msgs=${messages.length} firstTok=${__firstTok}ms modelTotal=${Date.now() - __tm}ms`);
      } else {
        resp =
          env.MARK_LLM_BACKEND === "hermes"
            ? await callHermesAsAnthropic({
                systemPrompt,
                messages,
                tools,
                maxTokens,
              })
            : await c.messages.create({
                model: env.ANTHROPIC_MODEL,
                max_tokens: maxTokens,
                system: systemPrompt,
                messages,
                ...(tools.length ? { tools } : {}),
              });
      }

      // Collect any plain-text blocks (Claude often emits a short narration
      // alongside a tool_use — e.g. "Creating the draft now…").
      const turnText = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (turnText) composedText = turnText;

      if (resp.stop_reason !== "tool_use") break;

      // Voice keep-alive: a tool round-trip can push the next spoken word out
      // to 5-8 seconds (think → tool → think → speak). Vapi treats long
      // silence as a dead model and drops the call. Emit a short spoken
      // bridge NOW so audio keeps flowing while the lookup runs.
      if (input.voiceMode && input.onText) {
        const fillers = [
          "One moment, Sir.",
          "Let me check, Sir.",
          "Bear with me a moment, Sir.",
          "Just pulling that up, Sir.",
          "One second, Sir.",
        ];
        input.onText(fillers[Math.floor(Math.random() * fillers.length)] + " ");
      }

      // Claude may emit MULTIPLE tool_use blocks in a single turn (parallel
      // tool calls). Anthropic requires a tool_result for EVERY tool_use in
      // the same following user message — miss one and the next API call
      // fails with `messages.N: tool_use ids were found without tool_result
      // blocks`. So execute every tool_use in this response and emit a
      // matching tool_result for each, in the same user message.
      const toolUses = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) {
        // stop_reason says tool_use but no blocks present — defensive bail.
        composedText =
          composedText ||
          `I tried to call a tool but no tool block was returned. Data as of ${input.dataAsOf}.`;
        break;
      }

      const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name === CREATE_DRAFT_MANUAL_JOURNAL_TOOL.name) {
          toolCallsFired++;
          const result = await executeCreateDraftTool({
            input: tu.input as DraftToolInput,
            triggeredBy: input.draftJournalTriggeredBy || "agent:mark",
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          });
        } else if (tu.name === CREATE_PAYROLL_JOURNAL_TOOL.name) {
          toolCallsFired++;
          const result = await executePayrollJournalTool({
            input: tu.input as PayrollToolInput,
            triggeredBy: input.draftJournalTriggeredBy || "agent:mark",
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          });
        } else if (tu.name === TRIGGER_SPECIALIST_RUN_TOOL.name) {
          toolCallsFired++;
          const result = await executeTriggerSpecialistRunTool(
            tu.input as { specialist?: unknown },
          );
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          });
        } else if (tu.name === LOOKUP_MONTH_DETAIL_TOOL.name) {
          toolCallsFired++;
          const result = await executeLookupMonthDetailTool(
            tu.input as { entity?: unknown; month?: unknown },
          );
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          });
        } else if (tu.name === LOOKUP_PAYROLL_DETAIL_TOOL.name) {
          toolCallsFired++;
          const result = await executeLookupPayrollDetailTool(
            tu.input as { entity?: unknown; month?: unknown },
          );
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result),
            is_error: !result.ok,
          });
        } else {
          // Unknown tool — still emit a tool_result so the message array
          // stays valid; mark it as an error so Claude can react.
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              ok: false,
              error: `Unknown tool: ${tu.name}`,
            }),
            is_error: true,
          });
        }
      }

      // Push the assistant turn (full resp.content, including ALL tool_use
      // blocks) followed by one user message carrying every tool_result.
      messages.push({ role: "assistant", content: resp.content });
      messages.push({ role: "user", content: toolResultBlocks });
      // Loop continues to get Claude's natural-language follow-up.
    }

    const answer =
      composedText ||
      `I don't have an answer for that from the current data. Data as of ${input.dataAsOf}.`;
    return { answer, fromModel: true, toolCallsFired };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      answer: `I couldn't reach the AI layer (${reason}). Data as of ${input.dataAsOf}.`,
      fromModel: false,
    };
  }
}
