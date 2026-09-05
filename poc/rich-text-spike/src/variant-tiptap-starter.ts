import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

export async function mount(element: HTMLElement, markdown: string) {
  new Editor({ element, extensions: [StarterKit, Markdown], content: markdown, contentType: 'markdown' });
}
