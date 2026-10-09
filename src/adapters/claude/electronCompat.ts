import { transferableAbortController } from 'node:util';

// Obtain Node's constructor without replacing Electron's browser globals.
export const NodeAbortController = transferableAbortController().constructor as typeof AbortController;
