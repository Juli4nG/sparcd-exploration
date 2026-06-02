import { create } from 'zustand';
import type { S3Config } from '@sparcd/types';
import type { ScannedFile } from './lib/scanFiles';

export type Section = 'new' | 'history' | 'settings';
export type WizardStep = 'drop' | 'inspect' | 'assign' | 'upload';
export type Theme = 'light' | 'dark';

type UploaderState = {
  s3Config: S3Config | null;
  section: Section;
  theme: Theme;
  step: WizardStep;
  files: ScannedFile[];
  scanning: boolean;

  connect: (config: S3Config) => void;
  disconnect: () => void;
  setSection: (section: Section) => void;
  toggleTheme: () => void;
  setStep: (step: WizardStep) => void;
  setScanning: (scanning: boolean) => void;
  setFiles: (files: ScannedFile[]) => void;
  removeFile: (id: string) => void;
  resetBatch: () => void;
};

export const useStore = create<UploaderState>((set) => ({
  s3Config: null,
  section: 'new',
  theme: 'light',
  step: 'drop',
  files: [],
  scanning: false,

  connect: (config) => set({ s3Config: config }),
  disconnect: () => set({ s3Config: null, section: 'new', step: 'drop', files: [] }),
  setSection: (section) => set({ section }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
  setStep: (step) => set({ step }),
  setScanning: (scanning) => set({ scanning }),
  // De-dupe by relPath; a re-scan replaces the batch wholesale.
  setFiles: (files) => {
    const seen = new Set<string>();
    const deduped = files.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
    set({ files: deduped, step: deduped.length > 0 ? 'inspect' : 'drop' });
  },
  removeFile: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  resetBatch: () => set({ files: [], step: 'drop' }),
}));
