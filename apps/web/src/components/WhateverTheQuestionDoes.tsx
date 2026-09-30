import { Component, type ReactNode } from 'react';

/**
 * What happens when a dialog's chunk does not arrive - the Filter or Sort
 * question, or the picker Move to… opens. The
 * same boundary `PanelText.tsx`'s `WhateverTheChunkDoes` and
 * `DescriptionBox.tsx`'s `WhateverTheEditorDoes` already draw, and for the same
 * reason: without it the whole board goes down with the one dialog that failed
 * to fetch.
 */
export class WhateverTheQuestionDoes extends Component<
  { children: ReactNode; onFailure: () => void },
  { broken: boolean }
> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    // Null for the render that catches; the failure is reported up, and the
    // next render closes the dialog instead.
    return this.state.broken ? null : this.props.children;
  }
}
