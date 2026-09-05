/** The baseline: the form with no editor behind it. */
export async function mount(root: HTMLElement, markdown: string) {
  root.textContent = markdown;
}
