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
export type OpenCaptureOn = (panel: FiledOn) => void;

export const CaptureOpenerContext = createContext<OpenCaptureOn | null>(null);

export const useOpenCaptureOn = () => useContext(CaptureOpenerContext);
