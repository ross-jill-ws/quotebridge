// Small display formatters shared by the dashboard views.

/** A rough elapsed time: "42 s", "3 min", "5 h", "2 d" (rounded down). */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Seconds read as UTC fields (a display clock's), to the minute: "2027-01-15 10:00". */
export function minuteStamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** A whole number with thousands separators: "1,250". */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}
