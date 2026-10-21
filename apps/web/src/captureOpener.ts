import { createContext, useContext } from 'react';
import type { FiledOn } from './components/FileOnLine';

/**
 * Opens Capture with *File on* already holding one Panel ("Add an Item to a
 * Panel from a + on its header, through Capture", issue 1105): the window at a
 * desk and the page on a phone, which the shell (pages/Layout.tsx) chooses
 * between.
 *
 * A context rather than a prop, since the Panel's header is drawn several
 * layers below the shell. Null where nothing provides it, and a Panel then
 * offers no way in.
 */
export type OpenCaptureOn = (panel: PanelOpening) => void;

/**
 * The Panel a + opened Capture for, and the Dashboard it is on. Capture opened
 * this way closes once one note is kept, and the page on a phone returns to
 * that Dashboard rather than to wherever history says.
 */
export interface PanelOpening extends FiledOn {
  dashboardId: string;
}

export const CaptureOpenerContext = createContext<OpenCaptureOn | null>(null);

export const useOpenCaptureOn = () => useContext(CaptureOpenerContext);
