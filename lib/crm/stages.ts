export interface HubspotStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata?: { isClosed?: string | boolean; probability?: string | number };
}

const isClosed = (s: HubspotStage) => String(s.metadata?.isClosed) === "true";
const prob = (s: HubspotStage) => Number(s.metadata?.probability ?? NaN);

/**
 * Map our lead statuses onto a real HubSpot pipeline's stage ids, using the pipeline itself rather than guessing names:
 * open stages in order -> new / accepted / contacted; the closed stage with probability 1 -> won; probability 0 -> lost.
 * With fewer than three open stages the later statuses reuse the last open one.
 */
export function suggestStageMap(stages: HubspotStage[]): Record<string, string> {
  const sorted = [...stages].sort((a, b) => a.displayOrder - b.displayOrder);
  const open = sorted.filter((s) => !isClosed(s));
  const won = sorted.find((s) => isClosed(s) && prob(s) === 1);
  const lost = sorted.find((s) => isClosed(s) && prob(s) === 0);
  if (!open.length || !won || !lost) throw new Error("pipeline needs at least one open stage, a closed-won and a closed-lost stage");
  const at = (i: number) => open[Math.min(i, open.length - 1)].id;
  return {
    new: at(0), sent_to_designer: at(0), in_review: at(0),
    accepted: at(1), contacted: at(2),
    won: won.id, lost: lost.id, closed: lost.id,
  };
}
