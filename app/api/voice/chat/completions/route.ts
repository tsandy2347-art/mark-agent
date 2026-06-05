// POST /api/voice/chat/completions
//
// OpenAI-compatible Custom-LLM endpoint for Vapi. This is Mark's VOICE brain.
// Vapi runs speech-to-text, sends the conversation here as an OpenAI
// chat-completion request, we answer through the SAME askMark() brain the
// browser chat uses (so the voice Mark and the typed Mark say the same thing),
// and stream the reply back as Server-Sent-Event chunks for Vapi to speak.
//
// AUTH: Vapi presents `Authorization: Bearer <VOICE_API_KEY>` (configured in
// the Vapi assistant's Custom-LLM settings). We check it here. The proxy.ts
// Basic-auth gate bypasses /api/voice so this Bearer check is the only gate.
//
// This endpoint is voice-only: it forces voiceMode on (spoken style, no
// markdown/URLs, pronounceable numbers) and runs UNrestricted=false — i.e. it
// never exposes individual-pay / people-restricted findings over an open voice
// line. Restricted finance stays on the authenticated browser dashboard.

import { type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { askMark } from "@/lib/mark/qa";
import type { QaHistoryTurn } from "@/lib/anthropic";
import { recordScreenPop } from "@/lib/voice-screen-pop";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MODEL = "mark-finance-voice";

// ── helpers ────────────────────────────────────────────────────────────────

type OpenAiMessage = { role?: string; content?: unknown };

/** Flatten OpenAI message content (string | array of parts) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text || ""))
      .join("\n");
  }
  return "";
}

/** Split an incoming OpenAI messages[] into:
 *   - the latest user utterance (the question to answer this turn)
 *   - the prior turns as Mark's history shape (oldest first)
 *  System messages from Vapi are ignored — Mark supplies his own persona. */
function splitMessages(messages: OpenAiMessage[]): {
  question: string;
  history: QaHistoryTurn[];
} {
  const turns: QaHistoryTurn[] = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    turns.push({ role: m.role as "user" | "assistant", text });
  }
  // The last user turn is the question; everything before it is history.
  let question = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      question = turns[i].text;
      turns.splice(i, 1);
      break;
    }
  }
  return { question, history: turns.slice(-40) };
}

function sseChunk(id: string, created: number, delta: object, finish: string | null) {
  return (
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  );
}

// ── handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Auth: shared Bearer secret with Vapi.
  const key = env.VOICE_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: "Voice endpoint disabled (VOICE_API_KEY not set)" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.slice(7).trim() !== key) {
    return new Response(
      JSON.stringify({ error: { message: "Invalid or missing VOICE_API_KEY" } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    messages?: OpenAiMessage[];
    stream?: boolean;
    call?: { id?: string };
    callId?: string;
  };

  const { question, history } = splitMessages(
    Array.isArray(body.messages) ? body.messages : [],
  );

  // Memory is keyed to ONE permanent voice session per caller, not the Vapi
  // call id — otherwise every hang-up wipes Mark's slate and he never
  // remembers across calls. Voice is anonymous (no login), so all voice
  // traffic shares Tony's stable session. Browser chat has its own logged-in
  // sessions and isn't affected.
  const sessionId = "mark-voice-tony";

  // If Vapi sends an empty opener (it does now, since firstMessage is empty and
  // the brain generates each greeting), prompt for a fresh, varied opener.
  const effectiveQ =
    question ||
    `Open the call with a fresh greeting in Mark's voice — ONE short sentence. ` +
    `ALWAYS address Tony as "Sir" (Mark's old-school English manners — this is non-negotiable). ` +
    `VARY the rest every time: do NOT use the same opener twice in a row, never the same opening word, ` +
    `mix it up across the day (e.g. "Good day, Sir", "Afternoon, Sir", "Mark here, Sir", "At your service, Sir", ` +
    `"Right then, Sir — what can I do for you", "Sir, ready when you are", "Evening, Sir", "Back with you, Sir" ` +
    `— invent new ones, don't just cycle these). Then briefly invite the question. No timestamps, no "Data as of".`;

  const id = `chatcmpl-mark-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const wantStream = body.stream !== false;

  // ── Non-streaming path (rare; Vapi normally wants a stream) ──────────────
  if (!wantStream) {
    let answer = "";
    try {
      const out = await askMark({
        askedBy: "voice",
        question: effectiveQ,
        includeRestricted: false,
        history,
        sessionId,
        voiceMode: true,
      });
      answer = out.answer || "I'm sorry, I couldn't pull that together just now.";
    } catch (err) {
      console.error("[voice] askMark failed:", err);
      answer = "I'm sorry, I couldn't reach the finance data just now. Do give me a moment and try again.";
    }
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Streaming path ───────────────────────────────────────────────────────
  // We open the SSE response IMMEDIATELY and let askMark stream the answer's
  // text into it token-by-token via onText, so Vapi starts speaking ~1s in
  // instead of waiting for Mark to compose the whole reply first. The brain's
  // tool loop (P&L / payroll lookups) runs transparently — only the FINAL
  // answer text streams. If anything throws, we emit a graceful spoken line.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Opening role delta (OpenAI-stream convention).
      controller.enqueue(encoder.encode(sseChunk(id, created, { role: "assistant", content: "" }, null)));

      let emittedAny = false;
      // Screen-pop marker. Mark emits `[SCREEN: <key>]` at the very start of
      // his turn when his answer is about something he can show on a known
      // page. We BUFFER the first ~60 chars looking for it; if present, capture
      // the key + strip it from Vapi's spoken stream. The browser polls
      // /api/voice/screen-pop and opens the matching page in an iframe.
      let preamble = "";
      let preambleDone = false;
      const SCREEN_KEYS = new Set(["profit","cash","specialists","settings","restricted","payroll","receivables"]);
      const flushPreamble = () => {
        if (preambleDone || !preamble) return;
        preambleDone = true;
        const m = preamble.match(/^\s*\[\s*SCREEN\s*:\s*([a-z\-]+)\s*\]\s*/i);
        let textOut = preamble;
        if (m) {
          const key = m[1].toLowerCase();
          textOut = preamble.slice(m[0].length);
          if (SCREEN_KEYS.has(key)) {
            // Fire-and-forget — store the latest pop keyed by sessionId.
            void recordScreenPop(sessionId, key).catch((e) =>
              console.warn("[voice] screen-pop store failed:", (e as Error)?.message),
            );
          }
        }
        if (textOut) {
          emittedAny = true;
          controller.enqueue(encoder.encode(sseChunk(id, created, { content: textOut }, null)));
        }
        preamble = "";
      };
      const onText = (delta: string) => {
        if (!delta) return;
        if (!preambleDone) {
          preamble += delta;
          // Decision point: either we have the marker by now, or we don't.
          // Wait until ~80 chars or a newline — Mark always emits the marker
          // FIRST so anything past that is just spoken text.
          if (preamble.length > 80 || /\n/.test(preamble)) {
            flushPreamble();
          }
          return;
        }
        emittedAny = true;
        controller.enqueue(encoder.encode(sseChunk(id, created, { content: delta }, null)));
      };
      const flushFinal = () => { flushPreamble(); };

      try {
        await askMark({
          askedBy: "voice",
          question: effectiveQ,
          includeRestricted: false, // never expose restricted pay/people over voice
          history,
          sessionId,
          voiceMode: true,
          onText,
        });
      } catch (err) {
        console.error("[voice] askMark stream failed:", err);
      }
      flushFinal();

      // Fallback: if nothing streamed (e.g. backend without token streaming, or
      // an early error), speak a graceful line so the call never goes silent.
      if (!emittedAny) {
        controller.enqueue(
          encoder.encode(
            sseChunk(
              id,
              created,
              { content: "I'm sorry, I couldn't pull that together just now. Do try me again." },
              null,
            ),
          ),
        );
      }

      controller.enqueue(encoder.encode(sseChunk(id, created, {}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
