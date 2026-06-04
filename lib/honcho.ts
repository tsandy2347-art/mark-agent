// Honcho memory layer — self-host on Railway US, shared with the rest of the
// JBC AI fleet (Adam, future Mark / Claire upgrades). Workspace `jbc-jarvis`.
//
// Mark uses Honcho for two things:
//
//   1. SESSION RESUME — when a user comes back to /qa, restore the prior
//      conversation turns so we pick up where we left off. Session ID lives
//      in browser localStorage; "Clear conversation" mints a new one.
//
//   2. CROSS-SESSION FACTS about the user — Honcho's deriver builds a
//      `peer.<user>.context` representation in the background from every
//      session that user has touched. Mark prepends it to the system prompt
//      as a "what you already know about this person" addendum so they don't
//      have to repeat themselves.
//
// Everything fail-soft: a Honcho outage or timeout NEVER blocks the chat.
// Mark proceeds without memory, the user sees a fresh session, and we log
// the warning. Mirror of Adam's pattern in adam-agent/server.js.

import { env } from "./env";

interface HonchoMessage {
  peer_id: string;
  content: string;
  created_at?: string;
}

interface SessionContextResponse {
  messages?: HonchoMessage[];
  summary?:
    | string
    | {
        content?: string;
        created_at?: string;
      };
}

interface PeerContextResponse {
  representation?: string;
  card?: string;
}

export interface HonchoSessionTurn {
  role: "user" | "assistant";
  text: string;
  createdAt: string | null;
}

export interface HonchoMemorySnapshot {
  /** Replay of the session's prior turns (oldest first). */
  resume: HonchoSessionTurn[];
  /** Cross-session facts the deriver has learned about this user, formatted
   *  newest-first. Suitable to inject as a system-prompt addendum. Null if
   *  Honcho returned nothing or wasn't reachable. */
  memoryBlock: string | null;
  /** True when Honcho is not configured for this instance (env unset). The
   *  caller can choose to render a "memory layer disabled" hint. */
  disabled: boolean;
  /** True when Honcho was configured but the call failed (timeout / 5xx).
   *  Caller proceeds without memory either way. */
  errored: boolean;
}

function isConfigured(): boolean {
  return Boolean(env.HONCHO_BASE_URL && env.HONCHO_JWT);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.HONCHO_JWT}`,
    "Content-Type": "application/json",
  };
}

/** Fail-fast wrapper. Resolves to null when the inner promise doesn't settle
 *  before the timeout (so the caller can branch on null without try/catch
 *  around every site). */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  return Promise.race([
    promise.catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[honcho] ${label} threw: ${err?.message || err}`);
      return null;
    }),
    new Promise<null>((resolve) => {
      setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn(`[honcho] ${label} timed out after ${ms}ms — skipping`);
        resolve(null);
      }, ms);
    }),
  ]);
}

/** GET session/{id}/context — returns the message history for this session
 *  PLUS any summary the deriver has produced. We map peer ids to {role:
 *  "user" | "assistant"} based on which peer is Mark. */
async function getSessionContext(sessionId: string, timeoutMs?: number): Promise<SessionContextResponse | null> {
  if (!isConfigured()) return null;
  const url = `${env.HONCHO_BASE_URL}/v3/workspaces/${encodeURIComponent(env.HONCHO_WORKSPACE)}/sessions/${encodeURIComponent(sessionId)}/context`;
  const resp = await withTimeout(
    fetch(url, { headers: authHeaders() }),
    timeoutMs ?? env.HONCHO_TIMEOUT_MS,
    `session/${sessionId}/context`,
  );
  if (!resp || !resp.ok) {
    if (resp && resp.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn(`[honcho] session context HTTP ${resp.status}`);
    }
    return null;
  }
  return (await resp.json()) as SessionContextResponse;
}

/** GET peers/{user}/context — returns the deriver's cross-session
 *  representation of that user. Shape: a long string of `[timestamp] fact`
 *  lines, oldest-first (per Adam's experience). We sort newest-first and
 *  cap the most recent ~80 lines so the prompt stays bounded. */
async function getPeerContext(peerId: string, timeoutMs?: number): Promise<PeerContextResponse | null> {
  if (!isConfigured()) return null;
  const url = `${env.HONCHO_BASE_URL}/v3/workspaces/${encodeURIComponent(env.HONCHO_WORKSPACE)}/peers/${encodeURIComponent(peerId)}/context`;
  const resp = await withTimeout(
    fetch(url, { headers: authHeaders() }),
    timeoutMs ?? env.HONCHO_TIMEOUT_MS,
    `peer/${peerId}/context`,
  );
  if (!resp || !resp.ok) {
    if (resp && resp.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn(`[honcho] peer context HTTP ${resp.status}`);
    }
    return null;
  }
  return (await resp.json()) as PeerContextResponse;
}

function buildMemoryBlock(sessionData: SessionContextResponse | null, peerData: PeerContextResponse | null): string | null {
  // Prefer a deriver-built session summary if present.
  if (sessionData?.summary) {
    if (typeof sessionData.summary === "string" && sessionData.summary.trim()) {
      return sessionData.summary.trim();
    }
    if (typeof sessionData.summary === "object" && sessionData.summary.content) {
      return sessionData.summary.content.trim();
    }
  }

  // Otherwise fall back to peer.context, parsed + sorted newest-first.
  // Per memory: peer.context returns oldest-first so a naive slice strips
  // the newest facts and Mark looks amnesiac.
  if (peerData) {
    const rep = (peerData.representation || "").toString();
    const facts: Array<{ ts: string; content: string }> = [];
    for (const line of rep.split("\n")) {
      const m = line.match(/^\[([^\]]+)\]\s+(.*)$/);
      if (m) facts.push({ ts: m[1], content: m[2] });
    }
    if (facts.length > 0) {
      facts.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
      const top = facts.slice(0, 80);
      return top.map((f) => `[${f.ts}] ${f.content}`).join("\n");
    }
    if (peerData.card) {
      return String(peerData.card).slice(0, 4000);
    }
  }
  return null;
}

function mapSessionTurns(sessionData: SessionContextResponse | null, markPeer: string): HonchoSessionTurn[] {
  if (!sessionData?.messages) return [];
  return sessionData.messages
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({
      role: m.peer_id === markPeer ? ("assistant" as const) : ("user" as const),
      text: m.content,
      createdAt: m.created_at ?? null,
    }));
}

/** One call: fetch session resume + cross-session peer facts in parallel,
 *  with the timeout guards baked in. Returns a structured snapshot the API
 *  layer can hand straight to the model. */
export async function fetchMarkMemory(args: { sessionId: string; userPeer: string; timeoutMs?: number }): Promise<HonchoMemorySnapshot> {
  const disabled = !isConfigured();
  if (disabled) {
    return { resume: [], memoryBlock: null, disabled: true, errored: false };
  }

  let errored = false;
  let sessionData: SessionContextResponse | null = null;
  let peerData: PeerContextResponse | null = null;
  try {
    [sessionData, peerData] = await Promise.all([
      getSessionContext(args.sessionId, args.timeoutMs),
      getPeerContext(args.userPeer, args.timeoutMs),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[honcho] fetchMarkMemory failed: ${err instanceof Error ? err.message : String(err)}`);
    errored = true;
  }

  const resume = mapSessionTurns(sessionData, env.HONCHO_MARK_PEER);
  const memoryBlock = buildMemoryBlock(sessionData, peerData);
  return { resume, memoryBlock, disabled: false, errored };
}

/** Append ONE message to a session. Fire-and-forget — never blocks the
 *  caller on the network. */
export async function postTurn(args: {
  sessionId: string;
  peerId: string;
  content: string;
}): Promise<void> {
  if (!isConfigured() || !args.sessionId || !args.content.trim()) return;
  const url = `${env.HONCHO_BASE_URL}/v3/workspaces/${encodeURIComponent(env.HONCHO_WORKSPACE)}/sessions/${encodeURIComponent(args.sessionId)}/messages`;
  const body = JSON.stringify({
    messages: [{ peer_id: args.peerId, content: args.content }],
  });
  // We DO await so we capture errors in logs, but with a short timeout.
  // The caller has already responded to the user when we call this.
  await withTimeout(
    fetch(url, { method: "POST", headers: authHeaders(), body }),
    env.HONCHO_TIMEOUT_MS,
    `session/${args.sessionId}/messages POST`,
  );
}

/** Format the cross-session memory block as a system-prompt addendum.
 *  Empty string when there's nothing to add — caller can concatenate freely. */
export function formatMemoryAddendum(snapshot: HonchoMemorySnapshot): string {
  if (!snapshot.memoryBlock) return "";
  return (
    `\n\n## WHAT YOU REMEMBER ABOUT THIS USER (from prior conversations)\n` +
    `These facts were extracted by the Honcho memory layer's deriver across every chat ` +
    `they've had with you. Newest first. Treat as background context, not as authoritative ` +
    `truth — when the user's CURRENT question is about live data, prefer the specialists' ` +
    `findings over recollection.\n\n` +
    snapshot.memoryBlock
  );
}
