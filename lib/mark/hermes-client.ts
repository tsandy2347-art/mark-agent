// Mark -> Hermes shim.
//
// Mark's /qa code is built around the Anthropic SDK message shape. To route
// through hermes-jbc (OpenAI-compatible /v1/chat/completions) WITHOUT a full
// rewrite of the agentic loop, this shim translates between the two formats:
//
//   - Anthropic system + messages + tools  ->  OpenAI messages array + tools
//   - OpenAI choices[0].message            ->  Anthropic-shape response
//
// The caller continues to think in Anthropic blocks (text, tool_use,
// tool_result). The wire layer just speaks OpenAI to Hermes.
//
// Gated by env MARK_LLM_BACKEND. When unset (default) Mark talks to Anthropic
// directly — the existing well-trodden path. When "hermes", Mark talks to
// hermes-jbc and the conversation feeds Hermes's autonomous skill-creation
// loop (skill_manage tool fires after complex tasks; new skills persist in
// the hermes-jbc volume).
//
// Reuses the same Anthropic SDK types so the surrounding loop is unchanged.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

interface CallArgs {
  systemPrompt: string;
  messages: Anthropic.Messages.MessageParam[];
  tools: Anthropic.Messages.Tool[];
  maxTokens: number;
}

/** Anthropic-shape Message that the rest of /qa already knows how to consume. */
type AnthropicShapeMessage = Anthropic.Messages.Message;

/** OpenAI message types ------------------------------------------------- */
interface OAITextPart { type: "text"; text: string }
interface OAIImagePart {
  type: "image_url";
  image_url: { url: string };
}
type OAIContent = string | Array<OAITextPart | OAIImagePart>;

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: OAIContent | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIChatResponse {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}


/** Anthropic -> OpenAI tools. */
function toOAITools(tools: Anthropic.Messages.Tool[]): OAIToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema as object,
    },
  }));
}


/** Flatten one Anthropic content block into the OpenAI parts a user/assistant
 *  message can carry. Image blocks become base64 data URLs. */
function anthropicBlockToOAIParts(
  block: Anthropic.Messages.ContentBlockParam,
): Array<OAITextPart | OAIImagePart> {
  if (block.type === "text") {
    return [{ type: "text", text: block.text }];
  }
  if (block.type === "image") {
    const src = block.source as unknown as {
      type: string;
      media_type?: string;
      data?: string;
      url?: string;
    };
    if (src.type === "base64") {
      return [
        {
          type: "image_url",
          image_url: {
            url: `data:${String(src.media_type)};base64,${String(src.data)}`,
          },
        },
      ];
    }
    if (src.type === "url" && typeof src.url === "string") {
      return [{ type: "image_url", image_url: { url: src.url } }];
    }
  }
  // Tool blocks are handled at message level, not here.
  return [];
}


/** Convert a single Anthropic-shape message into one or more OpenAI messages.
 *  Tool-use + tool-result blocks become separate top-level messages. */
function anthropicMessageToOAI(
  m: Anthropic.Messages.MessageParam,
): OAIMessage[] {
  const role = m.role;
  if (typeof m.content === "string") {
    return [{ role, content: m.content }];
  }
  // Block array case.
  const blocks = m.content;
  if (role === "assistant") {
    const parts: Array<OAITextPart | OAIImagePart> = [];
    const toolCalls: OAIToolCall[] = [];
    for (const b of blocks) {
      if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else {
        parts.push(...anthropicBlockToOAIParts(b));
      }
    }
    const msg: OAIMessage = {
      role: "assistant",
      content: parts.length ? (parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts) : null,
    };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return [msg];
  }

  // user role: tool_result blocks become separate {role: "tool"} messages.
  // Non-tool-result content stays as one user message.
  const userParts: Array<OAITextPart | OAIImagePart> = [];
  const toolMessages: OAIMessage[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      let content: string;
      if (typeof b.content === "string") content = b.content;
      else if (Array.isArray(b.content))
        content = b.content
          .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      else content = "";
      toolMessages.push({
        role: "tool",
        content,
        tool_call_id: b.tool_use_id,
      });
    } else {
      userParts.push(...anthropicBlockToOAIParts(b));
    }
  }
  const out: OAIMessage[] = [];
  if (userParts.length) {
    out.push({
      role: "user",
      content: userParts.length === 1 && userParts[0].type === "text" ? userParts[0].text : userParts,
    });
  }
  out.push(...toolMessages);
  return out;
}


/** Convert OpenAI assistant response back to Anthropic-shape Message. */
function oaiResponseToAnthropic(resp: OAIChatResponse): AnthropicShapeMessage {
  const choice = resp.choices[0];
  const blocks: Anthropic.Messages.ContentBlock[] = [];
  const text = choice.message.content ?? "";
  if (text) {
    blocks.push({ type: "text", text, citations: null } as Anthropic.Messages.TextBlock);
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { raw_arguments: tc.function.arguments };
    }
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    } as Anthropic.Messages.ToolUseBlock);
  }

  const stop_reason: Anthropic.Messages.Message["stop_reason"] =
    choice.finish_reason === "tool_calls"
      ? "tool_use"
      : choice.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content: blocks,
    model: resp.model ?? "hermes-agent",
    stop_reason,
    stop_sequence: null,
    usage: resp.usage
      ? {
          input_tokens: resp.usage.prompt_tokens,
          output_tokens: resp.usage.completion_tokens,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
        }
      : {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
        },
  } as AnthropicShapeMessage;
}


/**
 * Call hermes-jbc /v1/chat/completions and return an Anthropic-shape Message
 * so the surrounding /qa loop is unchanged.
 *
 * Throws on HTTP failure; caller is expected to fall back to direct Anthropic
 * if it wants to be defensive.
 */
export async function callHermesAsAnthropic(
  args: CallArgs,
): Promise<AnthropicShapeMessage> {
  const baseUrl = env.HERMES_BASE_URL.replace(/\/+$/, "");
  const apiKey = env.HERMES_API_SERVER_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "HERMES_BASE_URL or HERMES_API_SERVER_KEY not set on mark-agent env",
    );
  }

  // Build OAI message list: system first, then each anthropic message in
  // order (with tool blocks split out per the converter).
  const oaiMessages: OAIMessage[] = [
    { role: "system", content: args.systemPrompt },
  ];
  for (const m of args.messages) {
    oaiMessages.push(...anthropicMessageToOAI(m));
  }

  const body = {
    model: "hermes-agent",
    messages: oaiMessages,
    max_tokens: args.maxTokens,
    ...(args.tools.length ? { tools: toOAITools(args.tools) } : {}),
  };

  const controller = new AbortController();
  // Hermes is slower than direct Anthropic — it loads skills + memory + ctx.
  // 2-min cap is generous but bounded.
  const timer = setTimeout(() => controller.abort(), 120_000);

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hermes /v1/chat/completions ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = (await resp.json()) as OAIChatResponse;
  return oaiResponseToAnthropic(data);
}
