/**
 * Opens Claude's desktop app at a `claude://` address. Its own module so a
 * test can watch what was opened without a browser that would try to launch it.
 */
export function openClaude(link: string): void {
  window.location.assign(link);
}
