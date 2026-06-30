import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Species } from '../lib/species';

// A read-only loupe: the enlarged species reference image, so a volunteer can
// confirm an ID without leaving the panel. The image is the upstream external
// `iconUrl` (Settings/species.json), rendered directly into <img> exactly like
// the panel thumbnail — no presign, no S3, no canvas, no writeback.
export function SpeciesLoupe({ species, onClose }: { species: Species; onClose: () => void }) {
  const [failed, setFailed] = useState(false);

  // Escape closes; stopPropagation keeps it from reaching the tagger's global
  // keydown handler (which would clear selection / fire other UI).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${species.commonName} reference image`}
    >
      <div
        className="w-full max-w-[720px] bg-panel border border-rule shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-4 py-3 border-b border-rule">
          <div className="min-w-0">
            <div className="text-[15px] text-ink truncate">{species.commonName}</div>
            <div className="text-[12px] text-inkMute font-mono italic truncate">
              {species.scientificName}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto w-11 h-11 md:w-8 md:h-8 grid place-items-center text-[18px] leading-none text-inkSoft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-4 grid place-items-center">
          {species.iconUrl && !failed ? (
            <img
              src={species.iconUrl}
              alt={species.commonName}
              onError={() => setFailed(true)}
              className="max-w-full max-h-[70svh] object-contain bg-paperHover border border-rule"
            />
          ) : (
            <div className="w-full h-48 grid place-items-center font-mono text-[13px] text-inkMute bg-paperHover border border-rule">
              No reference image
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
