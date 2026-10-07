export interface DesignerRow {
  id: string;
  name: string;
  active: boolean;
  specialisation: "home" | "office" | "both";
  areas_served: string[];
  telegram_chat_id: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Location text is free-form ("Dahanukar Colony, Kothrud"), so match an area name appearing anywhere in it. */
export function servesArea(areas: string[], location: string | null): boolean {
  if (areas.length === 0) return true; // no list = serves all of Pune/PCMC
  if (!location) return true; // area unknown: do not exclude on it (type match + load still apply)
  const loc = ` ${norm(location)} `;
  return areas.some((a) => loc.includes(` ${norm(a)} `));
}

export function servesType(d: DesignerRow, projectType: string): boolean {
  return projectType === "unknown" || d.specialisation === "both" || d.specialisation === projectType;
}

/**
 * Brief §8: active designer matching project type and area, fewest open leads.
 * Ties break on name so routing is deterministic. `exclude` is used by Reassign.
 */
export function pickDesigner(
  designers: DesignerRow[],
  openLeads: Record<string, number>,
  lead: { project_type: string; location: string | null },
  exclude: string[] = [],
): DesignerRow | null {
  const eligible = designers.filter(
    (d) => d.active && !exclude.includes(d.id) && servesType(d, lead.project_type) && servesArea(d.areas_served, lead.location),
  );
  eligible.sort((a, b) => (openLeads[a.id] ?? 0) - (openLeads[b.id] ?? 0) || a.name.localeCompare(b.name));
  return eligible[0] ?? null;
}
