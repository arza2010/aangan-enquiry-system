import { ExtractionSchema, type Extraction } from "./schema";
import { loadPostCallPrompt } from "./context";
import { hasPriceLeak, redactPrices } from "./priceGuard";
import { getProvider, type LlmProvider, type Usage } from "./provider";

export type { Usage };

export type PostCallResult =
  | { ok: true; data: Extraction; usage: Usage; attempts: number; flags: string[]; model: string }
  | { ok: false; error: string; usage: Usage; attempts: number; rawText: string; model: string };

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Transcript in, validated extraction out. Never throws on bad model output: after one retry it
 * returns ok:false so the caller can mark the lead `needs_review` (the call is never lost).
 * API/network errors are thrown; the pipeline records those the same way.
 */
export async function runPostCall(args: {
  transcript: string;
  startedAt?: string;
  provider?: LlmProvider;
}): Promise<PostCallResult> {
  const provider = args.provider ?? getProvider();
  const model = `${provider.name}:${provider.model}`;
  const system = loadPostCallPrompt();
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  const userContent = `${args.startedAt ? `Call started: ${args.startedAt}\n\n` : ""}<transcript>\n${args.transcript}\n</transcript>`;
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: userContent }];

  let lastText = "";
  let lastError = "";
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await provider.complete({ system, messages });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    lastText = res.text;

    let problem = "";
    try {
      const parsed = ExtractionSchema.safeParse(extractJson(lastText));
      if (parsed.success) {
        const flags: string[] = [];
        if (hasPriceLeak(parsed.data.handoff_note)) {
          if (attempt < MAX_ATTEMPTS) {
            problem = "handoff_note contains a price/budget figure or currency word. Rewrite it with no figures at all.";
          } else {
            parsed.data.handoff_note = redactPrices(parsed.data.handoff_note);
            flags.push("handoff_note_redacted");
            return { ok: true, data: parsed.data, usage, attempts: attempt, flags, model };
          }
        } else {
          return { ok: true, data: parsed.data, usage, attempts: attempt, flags, model };
        }
      } else {
        problem = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }

    lastError = problem;
    messages.push(
      { role: "assistant", content: lastText || "(empty)" },
      { role: "user", content: `That output was rejected: ${problem}\nReturn ONLY the corrected JSON object.` },
    );
  }

  return { ok: false, error: lastError, usage, attempts: MAX_ATTEMPTS, rawText: lastText, model };
}
