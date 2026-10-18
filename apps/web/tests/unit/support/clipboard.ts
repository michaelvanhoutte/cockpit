import { vi } from 'vitest';

/** What a write to the clipboard held, by type, as text. */
export type Clipped = Record<string, string>;

function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * Stands in for the browser's clipboard, which jsdom lacks, and hands back what
 * was written. `refuses` is a browser that will not let the page write;
 * `withClipboardItem: false` is one with no `ClipboardItem`, which can only
 * write plain text. Undone by `vi.unstubAllGlobals()`.
 */
export function aClipboard({
  refuses = false,
  withClipboardItem = true,
}: { refuses?: boolean; withClipboardItem?: boolean } = {}) {
  const written: Clipped[] = [];
  const plain: string[] = [];
  class FakeClipboardItem {
    constructor(readonly parts: Record<string, Blob>) {}
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: vi.fn(async (items: FakeClipboardItem[]) => {
        if (refuses) throw new DOMException('denied', 'NotAllowedError');
        for (const item of items) {
          const clipped: Clipped = {};
          for (const [type, blob] of Object.entries(item.parts)) clipped[type] = await textOf(blob);
          written.push(clipped);
        }
      }),
      writeText: vi.fn(async (text: string) => {
        if (refuses) throw new DOMException('denied', 'NotAllowedError');
        plain.push(text);
      }),
    },
  });
  if (withClipboardItem) vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  else vi.stubGlobal('ClipboardItem', undefined);
  return { written, plain };
}
