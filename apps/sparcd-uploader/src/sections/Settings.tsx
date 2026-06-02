import { useStore } from '../store';
import { sanitizeUploaderUser } from '../lib/normalize';

export function Settings() {
  const s3Config = useStore((s) => s.s3Config);
  const disconnect = useStore((s) => s.disconnect);
  const uploaderUser = useStore((s) => s.uploaderUser);
  const setUploaderUser = useStore((s) => s.setUploaderUser);
  const slug = sanitizeUploaderUser(uploaderUser);

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
        <div className="border border-ruleSoft bg-panel p-5 space-y-4">
          <label className="block">
            <span className="block font-body text-[13px] text-inkSoft mb-1.5">Uploader identity</span>
            <input
              value={uploaderUser}
              onChange={(e) => setUploaderUser(e.target.value)}
              placeholder="e.g. Sara Malusa"
              className="w-full border border-rule bg-paper px-3 py-2 font-body text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
            />
            <span className="block font-body text-[12px] text-inkMute mt-1.5">
              Used in upload prefixes and object keys as{' '}
              {slug ? (
                <span className="font-mono text-inkSoft">{slug}</span>
              ) : (
                <span className="italic">a key-safe slug</span>
              )}
              . Assignment (P2) prefills this per batch.
            </span>
          </label>
          <p className="font-body text-[13px] text-inkMute">
            Upload concurrency and the dry-run default join here in P4.
          </p>
        </div>
      </section>
    </div>
  );
}
