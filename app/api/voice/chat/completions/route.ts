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

  // One Vapi call == one continuous Honcho session, so Mark remembers within
  // the call (and across calls, per the Honcho deriver). Fall back to a
  // synthetic id for curl smoke-tests.
  const rawSession = body.call?.id || body.callId || `voice-${Date.now()}`;
  const sessionId = `mark-voice-${rawSession}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

  // If Vapi sends an empty opener (it sometimes does on connect), greet briefly.
  const effectiveQ =
    question ||
    "Greet me briefly as Mark and ask what I'd like to know about the JBC finances. One sentence.";

  const id = `chatcmpl-mark-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const wantStream = body.stream !== false;

  let answer = "";
  try {
    const out = await askMark({
      askedBy: "voice",
      question: effectiveQ,
      includeRestricted: false, // never expose restricted pay/people over voice
      history,
      sessionId,
      voiceMode: true,
    });
    answer = out.answer || "I'm sorry, I couldn't pull that together just now.";
  } catch (err) {
    console.error("[voice] askMark failed:", err);
    answer =
      "I'm sorry, I couldn't reach the finance data just now. Do give me a moment and try again.";
  }

  if (!wantStream) {
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

  // Stream the answer back as SSE. askMark is non-streaming, so we chunk the
  // finished text into bite-size deltas — Vapi starts speaking as they arrive.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk(id, created, { role: "assistant", content: "" }, null)));
      // Chunk on word boundaries, ~80 chars per delta.
      const words = answer.split(/(\s+)/);
      let buf = "";
      for (const w of words) {
        buf += w;
        if (buf.length >= 80) {
          controller.enqueue(encoder.encode(sseChunk(id, created, { content: buf }, null)));
          buf = "";
        }
      }
      if (buf) controller.enqueue(encoder.encode(sseChunk(id, created, { content: buf }, null)));
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
