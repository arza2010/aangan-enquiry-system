import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The ONLY files the LLM may be given. This is an explicit allowlist, not a directory scan,
 * so a stray file (or the internal pricing guide) can never be picked up by accident.
 */
type AllowedFile = "services.md" | "qualified.md";

export function loadContext(root = process.cwd()): { services: string; qualified: string } {
  const read = (f: AllowedFile) => readFileSync(join(root, "context", f), "utf8");
  return { services: read("services.md"), qualified: read("qualified.md") };
}

export function loadPostCallPrompt(root = process.cwd()): string {
  const { services, qualified } = loadContext(root);
  return readFileSync(join(root, "prompts", "post-call.md"), "utf8")
    .replace("{{SERVICES}}", services.trim())
    .replace("{{QUALIFIED}}", qualified.trim());
}
