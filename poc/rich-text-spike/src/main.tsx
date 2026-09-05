/**
 * The shell a real form would be: React, a textarea, and a button that
 * lazy-imports the editor. Built once per variant so the editor's chunk is
 * measured on its own, against a baseline with no editor at all.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

function Form() {
  const [text, setText] = useState('');
  const [mounted, setMounted] = useState(false);
  return (
    <div>
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
      <button
        type="button"
        onClick={() => {
          void import('./variant').then(async (module) => {
            await module.mount(document.getElementById('editor')!, text);
            setMounted(true);
          });
        }}
      >
        {mounted ? 'mounted' : 'load the editor'}
      </button>
      <div id="editor" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Form />
  </StrictMode>,
);
