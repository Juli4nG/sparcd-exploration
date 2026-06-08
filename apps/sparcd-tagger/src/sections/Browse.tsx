import { useStore } from '../store';
import { useCollections, useUploads, useSpecies } from '../lib/queries';

const kicker = 'font-body text-[11px] font-[600] tracking-[0.16em] uppercase text-inkSoft';

// Browse is the entry point: pick a collection in the rail, then pick one of
// its uploads in the main panel — choosing an upload opens the Tag workspace.
export function Browse() {
  const cfg = useStore((s) => s.s3Config);
  const connectionId = useStore((s) => s.connectionId);
  const collectionKey = useStore((s) => s.selectedCollectionKey);
  const selectCollection = useStore((s) => s.selectCollection);
  const selectUpload = useStore((s) => s.selectUpload);

  const collections = useCollections(cfg, connectionId);
  const uploads = useUploads(cfg, connectionId, collectionKey);
  const species = useSpecies(cfg, connectionId); // loaded once; surfaced as a status line

  const collection = collections.data?.find((c) => c.key === collectionKey);

  return (
    <div className="h-full grid grid-cols-[280px_1fr] min-h-0">
      {/* Collection rail */}
      <aside className="border-r border-rule bg-panel overflow-y-auto p-4 space-y-6">
        <section>
          <h2 className={kicker}>Collections</h2>
          <Status q={collections} empty="No collections visible to these credentials." />
          <ul className="mt-2 space-y-1">
            {collections.data?.map((c) => (
              <li key={c.key}>
                <button
                  onClick={() => selectCollection(c.key)}
                  aria-current={c.key === collectionKey ? 'true' : undefined}
                  className={`w-full text-left px-2.5 py-1.5 text-[14px] border border-transparent hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    c.key === collectionKey ? 'bg-mark border-rule' : ''
                  }`}
                >
                  <div className="text-ink">{c.name ?? c.bucket}</div>
                  {c.organization && (
                    <div className="text-[12px] text-inkMute font-mono">{c.organization}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <p className="text-[12px] text-inkMute font-body border-t border-ruleSoft pt-3">
          {species.isLoading && 'Loading species vocabulary…'}
          {species.isError && `Species vocabulary unavailable: ${(species.error as Error).message}`}
          {species.data &&
            `${species.data.species.length} species loaded from ${species.data.settingsBucket}` +
              (species.data.skipped.length ? ` (${species.data.skipped.length} skipped)` : '')}
        </p>
      </aside>

      {/* Uploads for the chosen collection */}
      <div className="overflow-y-auto p-5">
        {!collectionKey && (
          <CollectionPrompt
            collectionCount={collections.data?.length}
            speciesCount={species.data?.species.length}
            loading={collections.isLoading}
          />
        )}
        {collectionKey && (
          <>
            <h1 className="font-display text-[20px] text-ink mb-4">
              {collection?.name ?? collection?.bucket ?? 'Uploads'}
            </h1>
            <Status q={uploads} empty="No uploads in this collection." />
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
              {uploads.data?.map((u) => (
                <li key={u.prefix}>
                  <button
                    onClick={() => selectUpload(u.prefix)}
                    className="w-full text-left px-3 py-2.5 text-[13px] font-mono text-inkSoft border border-rule hover:bg-panelHover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {u.stamp}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function Status({ q, empty }: { q: { isLoading: boolean; isError: boolean; error?: unknown; data?: unknown[] }; empty: string }) {
  if (q.isLoading) return <p className="text-[13px] text-inkMute mt-2">Loading…</p>;
  if (q.isError) return <p className="text-[13px] text-warn mt-2">{(q.error as Error).message}</p>;
  if (Array.isArray(q.data) && q.data.length === 0)
    return <p className="text-[13px] text-inkMute mt-2">{empty}</p>;
  return null;
}

// The first-run canvas. Instead of an empty void, a field-journal frontispiece:
// a stamped track (camera traps fire on what walks past — here, a wildcat's paw)
// ringed by idle motion-detection pulses, with a cue pointing back to the rail.
function CollectionPrompt({
  collectionCount,
  speciesCount,
  loading,
}: {
  collectionCount?: number;
  speciesCount?: number;
  loading: boolean;
}) {
  return (
    <div className="relative h-full grid place-items-center px-6">
      {/* Anchored to the panel edge, nudging the eye toward the collection rail. */}
      <div
        className="fn-rise absolute left-1 top-1/2 -translate-y-1/2 hidden lg:flex items-center gap-2 text-inkMute"
        style={{ animationDelay: '0.5s' }}
      >
        <span className="fn-nudge text-accent" aria-hidden>
          <svg width="34" height="14" viewBox="0 0 34 14" fill="none">
            <path
              d="M33 7H2M2 7l5-5M2 7l5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] [writing-mode:vertical-rl] rotate-180">
          Start here
        </span>
      </div>

      <div className="max-w-[420px] text-center">
        <div className="fn-rise mx-auto mb-7 grid place-items-center" style={{ animationDelay: '0.05s' }}>
          <PawStamp />
        </div>

        <p className={`fn-rise ${kicker} block`} style={{ animationDelay: '0.15s' }}>
          Field Notebook · Tagger
        </p>

        <h1
          className="fn-rise font-display text-[27px] leading-tight text-ink mt-2 text-balance"
          style={{ animationDelay: '0.25s' }}
        >
          Pick up a collection to begin
        </h1>

        <p
          className="fn-rise font-body text-[14px] leading-relaxed text-inkSoft mt-3 mx-auto max-w-[34ch] text-pretty"
          style={{ animationDelay: '0.35s' }}
        >
          Choose one from the rail on the left to see its uploads — then open an
          upload to start tagging what the cameras caught.
        </p>

        <div
          className="fn-rise mt-7 inline-flex items-center gap-3 border-t border-ruleSoft pt-3 font-mono text-[12px] text-inkMute"
          style={{ animationDelay: '0.45s' }}
        >
          {loading ? (
            'Loading collections…'
          ) : (
            <>
              <span className="text-inkSoft">{collectionCount ?? 0}</span> collections in view
              {speciesCount != null && (
                <>
                  <span className="text-ruleSoft" aria-hidden>
                    ·
                  </span>
                  <span className="text-inkSoft">{speciesCount}</span> species ready
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// A pressed wildcat track ringed by idle motion-sensor pulses.
function PawStamp() {
  return (
    <svg width="108" height="108" viewBox="0 0 108 108" fill="none" aria-hidden role="img">
      {[0, 1.05, 2.1].map((delay, i) => (
        <circle
          key={i}
          className="fn-scan"
          cx="54"
          cy="54"
          r="30"
          stroke="var(--accent)"
          strokeWidth="1"
          fill="none"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
      <g fill="var(--ink)" opacity="0.9">
        {/* metacarpal pad */}
        <path d="M54 86c-12 0-19-7-19-15 0-7 8-11 19-11s19 4 19 11c0 8-7 15-19 15Z" />
        {/* toe pads */}
        <ellipse cx="33" cy="49" rx="6" ry="8" transform="rotate(-18 33 49)" />
        <ellipse cx="46" cy="38" rx="6" ry="9" transform="rotate(-6 46 38)" />
        <ellipse cx="62" cy="38" rx="6" ry="9" transform="rotate(6 62 38)" />
        <ellipse cx="75" cy="49" rx="6" ry="8" transform="rotate(18 75 49)" />
      </g>
    </svg>
  );
}
