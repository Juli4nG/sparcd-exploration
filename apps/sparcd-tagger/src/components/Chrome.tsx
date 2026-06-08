import type { ReactNode } from 'react';
import { useStore, type Section } from '../store';
import { useDraftStore, dirtyCount } from '../lib/drafts';
import { StatePill } from './StatePill';

// Reuses the uploader's section-tab chrome treatment so the tools read as
// family; the tabs drive this tool's own internal navigation (no cross-app nav).
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'browse', label: 'Browse' },
  { id: 'tag', label: 'Tag' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export function Chrome({ children }: { children: ReactNode }) {
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const syncState = useStore((s) => s.syncState);
  const hasUpload = useStore((s) => !!s.selectedUploadPrefix);
  // Local-only in P1: surface unsaved edits so the pill is honest before the P4
  // write path exists. `syncState` stays the source of truth once sync ships.
  const hasDirty = useDraftStore((s) => dirtyCount(s.drafts) > 0);
  const displayState = syncState === 'local-only' && hasDirty ? 'unsynced' : syncState;

  return (
    <div className="h-screen flex flex-col bg-paper">
      <header className="h-14 shrink-0 bg-panel border-b border-rule flex items-stretch px-4">
        <div className="flex items-center gap-2.5 pr-6">
          <img src={`${import.meta.env.BASE_URL}sparcd.png`} alt="SPARC'd" className="h-7 w-auto" />
          <span className="font-display text-[22px] font-[600] text-ink leading-none whitespace-nowrap">
            SPARC'd <span className="text-inkMute">·</span> Tagger
          </span>
        </div>

        <nav className="flex items-stretch" aria-label="Sections">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            // Tag is only reachable once an upload is chosen in Browse.
            const disabled = s.id === 'tag' && !hasUpload;
            return (
              <button
                key={s.id}
                onClick={() => !disabled && setSection(s.id)}
                disabled={disabled}
                aria-current={active ? 'page' : undefined}
                className={`relative px-4 text-[14px] font-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent -outline-offset-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                  active ? 'text-ink font-[600]' : 'text-inkSoft hover:text-ink'
                }`}
              >
                {s.label}
                {active && <span className="absolute left-3 right-3 -bottom-px h-0.5 bg-ink" />}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <StatePill state={displayState} />
          <button
            onClick={toggleTheme}
            className="w-8 h-8 grid place-items-center border border-rule text-inkSoft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
            title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          >
            <span aria-hidden>{theme === 'light' ? '☾' : '☀'}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
    </div>
  );
}
