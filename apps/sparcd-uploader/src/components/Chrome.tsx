import type { ReactNode } from 'react';
import { BrandSwitcher, ConnectionChip } from '@sparcd/auth-ui';
import { useStore, type Section } from '../store';
import { StatePill, type UploadState } from './StatePill';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'new', label: 'New upload' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export function Chrome({ uploadState, children }: { uploadState: UploadState; children: ReactNode }) {
  const section = useStore((s) => s.section);
  const setSection = useStore((s) => s.setSection);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const disconnect = useStore((s) => s.disconnect);

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      <header className="h-14 shrink-0 bg-panel border-b border-rule flex items-stretch px-4">
        <div className="flex items-center pr-6">
          <BrandSwitcher toolName="Uploader" />
        </div>

        <nav className="flex items-stretch" aria-label="Sections">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                aria-current={active ? 'page' : undefined}
                className={`relative px-4 text-[14px] font-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent -outline-offset-2 ${
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
          <StatePill state={uploadState} />
          <ConnectionChip identity={uploaderUser || undefined} onDisconnect={disconnect} />
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

      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}
