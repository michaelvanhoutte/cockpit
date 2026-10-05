/** The year Cockpit was first published, where the copyright range starts. */
const FIRST_YEAR = 2026;

/** The copyright years: the first year alone, or a range running to this one. */
export function copyrightYears(now: Date = new Date()): string {
  const year = now.getFullYear();
  return year > FIRST_YEAR ? `${FIRST_YEAR}–${year}` : `${FIRST_YEAR}`;
}

/** Who made Cockpit, as the sign-in page and the profile menu credit it. */
export function creditLine(now?: Date): string {
  return `© ${copyrightYears(now)} Conselit · conselit.be`;
}
