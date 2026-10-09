import type { EffortLevel } from '../core/contracts';

export interface DisplayPreferences {
  pdfEvidenceAgent?: boolean;
  autoScroll: boolean;
  deferMath: boolean;
  model?: string;
  effort?: EffortLevel | '';
  provider?: 'claude' | 'codex';
  codexModel?: string;
  codexEffort?: Exclude<EffortLevel, 'max'> | '';
}
export const defaultDisplayPreferences: DisplayPreferences = { autoScroll: true, deferMath: true, model: '', effort: '' };
