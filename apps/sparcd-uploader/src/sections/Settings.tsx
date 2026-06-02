import { useStore } from '../store';

export function Settings() {
  const s3Config = useStore((s) => s.s3Config);
  const disconnect = useStore((s) => s.disconnect);

  return (
    <div className="px-6 py-6 max-w-2xl mx-auto space-y-8">
      <section>
        <h2 className="font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-3">
          Connection
        </h2>
        <div className="border border-rule bg-panel p-5 space-y-3">
          <p className="font-body text-[14px] text-inkSoft">
            Connected to{' '}
            <span className="font-mono text-ink">{s3Config?.endpoint}</span>{' '}
            (region <span className="font-mono text-ink">{s3Config?.region}</span>).
          </p>
          <button
            onClick={disconnect}
            className="border border-ink text-ink px-3.5 py-1.5 text-[14px] font-body hover:bg-paperHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          >
            Disconnect / edit
          </button>
        </div>
      </section>

      <section>
        <h2 className="font-[600] text-[11px] tracking-[0.16em] uppercase text-inkSoft mb-3">
          Defaults
        </h2>
        <div className="border border-ruleSoft bg-panel p-5">
          <p className="font-body text-[14px] text-inkSoft">
            Uploader identity, upload concurrency, and the dry-run default live here. Wired in P1
            (identity / normalization) and P4 (concurrency / dry-run).
          </p>
        </div>
      </section>
    </div>
  );
}
