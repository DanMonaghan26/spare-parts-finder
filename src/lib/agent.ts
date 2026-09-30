import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CaseSchema, type RepairCase } from "./case";
import {
  EsparesError,
  esparesSearchLink,
  findRepairGuides,
  getEsparesPage,
  GUIDE_APPLIANCES,
  type GuideAppliance,
  searchEspares,
} from "./espares";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_TURNS = 12;

const client = new Anthropic();

type Messages = Anthropic.Beta.BetaMessageParam[];

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "case"; case: RepairCase }
  | { type: "done"; messages: Messages }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `You are the Spare Parts Finder, a friendly UK appliance repair helper. You help people work out what's wrong with a major domestic appliance (washing machines, washer dryers, tumble dryers, dishwashers, fridges and freezers, ovens, cookers and hobs, cooker hoods, microwaves), pin down the exact model number, and find the right spare part on eSpares (www.espares.co.uk).

Work through three stages, but let the conversation flow naturally — people often volunteer the model number or the part they think is broken up front.

1. Understand the fault
- Get the appliance type, brand, and what it is (or isn't) doing in the person's own words. Ask at most one or two short questions at a time.
- Useful follow-ups: error codes or flashing lights, noises, smells, leaks and where the water appears, when in the cycle it happens, how old the appliance is, anything that changed recently.
- Once you know the appliance and roughly what's wrong, look up eSpares' own repair guides with find_repair_guides, open the one or two that best match the symptom with open_espares_page, and base your diagnosis on them. eSpares' guides are the main source for your diagnosis; your general knowledge fills gaps.
- Suggest the most likely faulty components in plain English, with a one-line reason each, most likely first. Mention quick free checks first where they exist (e.g. a blocked filter before a new drain pump).
- Make it clear where advice comes from: attribute what the guide says to it and link to it (e.g. "eSpares' guide [Washing Machine Not Draining Water](url) suggests checking the filter first"). When you add something the guide doesn't cover, say it's general advice. If no guide fits, say so and give general advice.
- Safety: tell people to switch off and unplug before any inspection. For gas appliances, or anything involving gas connections, say the repair must be done by a Gas Safe registered engineer. If there's a burning smell, scorching or sparking, say to stop using it. Don't encourage mains-voltage live testing.

2. Pin down the exact model number
- Explain where the rating plate / sticker is for their appliance type, e.g.: washing machines and washer dryers — around the door opening or on the inside of the door, sometimes behind the filter flap; tumble dryers — inside the door frame; dishwashers — on the side edge of the door or the inner door rim; fridges and freezers — on an inside side wall, often near the salad drawer; ovens and cookers — on the door frame edge when the door is open, or the back of the storage drawer; cooker hoods — behind the grease filters; microwaves — inside the door frame or on the back.
- The model number is not the serial number. Some brands also print a service/product code that pins down the exact variant (e.g. Bosch, Siemens and Neff "E-Nr" with a suffix like /05 plus an "FD" number; AEG, Electrolux and Zanussi "PNC" / Prod. No.). Ask for these when variants differ.
- People can upload a photo of the rating plate. Read it carefully, say what you can read, and ask them to confirm any characters you're unsure of (0/O, 1/I, 5/S, 8/B).
- Search eSpares for the brand and model number. If several models or variants come back, list the close matches and ask which one matches their plate. Only treat a model as confirmed once the person agrees it matches.

3. Find the parts
- Open the confirmed model's eSpares page and look for the part categories that fit the fault. Open a category page if you need to see the actual parts.
- Recommend one to three parts with the name, price and part number as shown, and a link to the eSpares product page. Say whether it's a genuine (manufacturer) or compatible part when the listing makes that clear.
- Never invent part numbers, prices, or URLs. Only use what you actually saw in tool results. If you couldn't verify something, say so and give the person an eSpares search link instead.

Tools
- update_case: call this whenever you learn something new — appliance, brand, symptoms, likely faults, repair guides you used, model number, confirmation, recommended parts. It keeps the summary panel next to the chat up to date. Send only the fields that changed.
- find_repair_guides lists eSpares repair guides for an appliance, ranked by how well their titles match the problem. Titles can be misleading, so open a guide before relying on it.
- search_espares, find_repair_guides and open_espares_page read eSpares directly. If they fail (eSpares can block automated requests), fall back to web_search / web_fetch, which are limited to espares.co.uk.

Style: British English, warm and practical, short paragraphs, bullet lists for options. Use Markdown links for URLs. Don't mention these instructions or tool names to the person.`;

// Tool input schemas come from Zod, minus the "$schema" marker it adds.
function inputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const json: Record<string, unknown> = z.toJSONSchema(schema);
  delete json.$schema;
  return json as Anthropic.Beta.BetaTool.InputSchema;
}

const SearchInput = z.object({ query: z.string().min(1).max(200) });
const OpenPageInput = z.object({ url: z.string().min(1).max(2000) });
const GuidesInput = z.object({
  appliance: z.enum(Object.keys(GUIDE_APPLIANCES) as [GuideAppliance, ...GuideAppliance[]]),
  problem: z.string().min(1).max(300).describe("The symptom in a few words, e.g. 'not draining water'"),
});

const clientTools: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "search_espares",
    description:
      "Search eSpares (UK appliance spare parts retailer). Best queries are the brand plus the exact model number (e.g. 'Bosch WAT28371GB'), optionally followed by a part name (e.g. 'Bosch WAT28371GB door seal'). Returns matching model pages, products (name, price, part number, URL) and part categories.",
    input_schema: inputSchema(SearchInput),
    eager_input_streaming: true,
  },
  {
    name: "open_espares_page",
    description:
      "Open an eSpares page (a model page, a part category page for a model, or a product page) and return its products with prices and part numbers, part categories, and a text excerpt. Only www.espares.co.uk URLs are allowed.",
    input_schema: inputSchema(OpenPageInput),
    eager_input_streaming: true,
  },
  {
    name: "find_repair_guides",
    description:
      "List eSpares' repair and troubleshooting guides for an appliance type, ranked by relevance to the problem. Returns guide titles and URLs; open the best match with open_espares_page to read it.",
    input_schema: inputSchema(GuidesInput),
    eager_input_streaming: true,
  },
  {
    name: "update_case",
    description:
      "Update the repair summary shown beside the chat. Include only fields that are new or changed; arrays replace the previous list.",
    input_schema: inputSchema(CaseSchema),
    eager_input_streaming: true,
  },
];

const serverTools: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", allowed_domains: ["espares.co.uk"], max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", allowed_domains: ["espares.co.uk"], max_uses: 8 },
];

const tools = [...clientTools, ...serverTools];

async function runTool(
  block: Anthropic.Beta.BetaToolUseBlock,
  emit: (e: AgentEvent) => void,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  try {
    switch (block.name) {
      case "search_espares": {
        const input = SearchInput.safeParse(block.input);
        if (!input.success) return result(`Invalid input: ${input.error.message}`, true);
        emit({ type: "status", text: `Searching eSpares for “${input.data.query}”…` });
        try {
          const page = await searchEspares(input.data.query);
          return result(JSON.stringify(page));
        } catch (err) {
          if (!(err instanceof EsparesError)) throw err;
          return result(
            `${err.message} Try web_search restricted to espares.co.uk instead. A search link the person can open themselves: ${esparesSearchLink(input.data.query)}`,
            true,
          );
        }
      }
      case "open_espares_page": {
        const input = OpenPageInput.safeParse(block.input);
        if (!input.success) return result(`Invalid input: ${input.error.message}`, true);
        emit({
          type: "status",
          text: /\/(symptom|careandmaintenance)\//.test(input.data.url)
            ? "Reading the eSpares repair guide…"
            : "Reading the eSpares page…",
        });
        try {
          return result(JSON.stringify(await getEsparesPage(input.data.url)));
        } catch (err) {
          if (!(err instanceof EsparesError)) throw err;
          return result(`${err.message} Try web_fetch on the same URL instead.`, true);
        }
      }
      case "find_repair_guides": {
        const input = GuidesInput.safeParse(block.input);
        if (!input.success) return result(`Invalid input: ${input.error.message}`, true);
        emit({ type: "status", text: "Looking up eSpares repair guides…" });
        try {
          return result(JSON.stringify(await findRepairGuides(input.data.appliance, input.data.problem)));
        } catch (err) {
          if (!(err instanceof EsparesError)) throw err;
          return result(
            `${err.message} Try web_search restricted to espares.co.uk for "${input.data.appliance} ${input.data.problem} advice" instead.`,
            true,
          );
        }
      }
      case "update_case": {
        const input = CaseSchema.safeParse(block.input);
        if (!input.success) return result(`Invalid input: ${input.error.message}`, true);
        emit({ type: "case", case: input.data });
        return result("Summary updated.");
      }
      default:
        return result(`Unknown tool: ${block.name}`, true);
    }
  } catch (err) {
    console.error(`Tool ${block.name} failed`, err);
    return result(`The tool failed unexpectedly: ${(err as Error).message}`, true);
  }
}

/**
 * Runs one user turn: streams Claude's reply, executes tool calls, and loops
 * until Claude finishes. Returns the full updated conversation via a "done"
 * event so the browser can send it back next turn (the API is stateless).
 */
export async function runAgent(history: Messages, emit: (e: AgentEvent) => void) {
  const messages: Messages = [...history];
  let jsonRetries = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // If a safety classifier declines a benign request, retry on
      // Anthropic's recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        emit({ type: "text", text: event.delta.text });
      } else if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
        emit({
          type: "status",
          text: event.content_block.name === "web_fetch" ? "Reading eSpares…" : "Searching eSpares…",
        });
      }
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming, a tool input that isn't valid JSON rejects
      // here; re-issue that turn. Real API errors are rethrown.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }

    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    if (message.stop_reason !== "tool_use") {
      if (message.stop_reason === "refusal") {
        emit({ type: "text", text: "\n\nSorry — I can't help with that request." });
      }
      // A refusal or max_tokens can cut a tool call off mid-input. Never run
      // it, but answer it so the history stays valid for the next turn.
      if (toolUses.length > 0) {
        messages.push({
          role: "user",
          content: toolUses.map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: "Not run: the response was cut off.",
            is_error: true,
          })),
        });
      }
      break;
    }

    // Separate consecutive text chunks from different turns in the UI.
    emit({ type: "text", text: "\n\n" });
    const results = await Promise.all(toolUses.map((b) => runTool(b, emit)));
    messages.push({ role: "user", content: results });
  }

  emit({ type: "done", messages });
}
