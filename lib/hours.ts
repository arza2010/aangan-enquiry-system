const TZ = "Asia/Kolkata";

/** Minutes since midnight in Asia/Kolkata, plus ISO weekday (1=Mon..7=Sun). */
function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wk = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday: wk };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** True when the call arrived outside front desk hours (default 10:00-19:00 IST, Mon-Sat; Sunday TBC). */
export function isAfterHours(d: Date, hours = { start: "10:00", end: "19:00" }): boolean {
  const { minutes } = istParts(d);
  return minutes < toMin(hours.start) || minutes >= toMin(hours.end);
}
