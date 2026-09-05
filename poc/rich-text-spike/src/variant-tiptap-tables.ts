import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';

export async function mount(element: HTMLElement, markdown: string) {
  new Editor({ element, extensions: [StarterKit, Markdown, TableKit, Image], content: markdown, contentType: 'markdown' });
}
