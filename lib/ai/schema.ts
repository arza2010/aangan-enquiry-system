import { z } from "zod";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Strict output of the post-call LLM (brief §7, plus `call_type`; see docs/open-questions.md). */
export const ExtractionSchema = z.object({
  call_type: z.enum(["new_enquiry", "existing_client", "other"]),
  caller_name: z.string().nullable(),
  project_type: z.enum(["home", "office", "unknown"]),
  location: z.string().nullable(),
  carpet_area_sqft: z.number().nullable(),
  bhk_or_rooms: z.string().nullable(),
  scope: z.string().nullable(),
  budget_range: z.string().nullable(),
  timeline: z.string().nullable(),
  possession_status: z.enum(["ready", "under_construction", "unknown"]),
  source: z.string().nullable(),
  language: z.enum(["en", "hi", "mr", "mixed"]),
  classification: z.enum(["qualified", "borderline", "not_qualified"]),
  classification_reason: z.string().min(1),
  missing_info: z.array(z.string()),
  handoff_note: z.string().refine((s) => words(s) <= 120, "handoff_note must be 120 words or fewer"),
  price_mentioned_in_call: z.boolean(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
