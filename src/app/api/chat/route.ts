import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentEvent } from "@/lib/agent";

// Tool-using turns (search, open pages, reason) can take a while.
export const maxDuration = 300;

const MAX_BODY_BYTES = 12 * 1024 * 1024; // room for a couple of rating-plate photos
const MAX_MESSAGES = 120;

type Body = { messages?: Anthropic.Beta.BetaMessageParam[] };

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server." }, { status: 500 });
  }

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: "That message is too large — try a smaller photo." }, { status: 413 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const messages = body.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES ||
    messages[0]?.role !== "user" ||
    messages.at(-1)?.role !== "user"
  ) {
    return Response.json(
      { error: "Conversation is empty or too long — start a new search." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await runAgent(messages, emit);
      } catch (err) {
        console.error("Chat turn failed", err);
        let message = "Something went wrong. Please try again.";
        if (err instanceof Anthropic.RateLimitError) {
          message = "We're a bit busy right now — please try again in a minute.";
        } else if (err instanceof Anthropic.AuthenticationError) {
          message = "The server's Anthropic API key is invalid.";
        } else if (err instanceof Anthropic.BadRequestError) {
          message = "The conversation couldn't be processed — try starting a new search.";
        } else if (err instanceof Anthropic.APIError) {
          message = `The AI service returned an error (${err.status}). Please try again.`;
        }
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
