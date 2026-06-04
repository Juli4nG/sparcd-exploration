import { useStore } from '../store';

const kicker = 'font-body text-[11px] font-[600] tracking-[0.16em] uppercase text-inkSoft mb-1.5';
const input =
  'w-full bg-paper border border-rule px-3 py-2 text-[14px] font-mono text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2';

// Per the simplified-login design: identity and the dry-run default live in
// Settings, not on the connection gate.
export function Settings() {
  const taggerUser = useStore((s) => s.taggerUser);
  const setTaggerUser = useStore((s) => s.setTaggerUser);
  const dryRun = useStore((s) => s.dryRun);
  const setDryRun = useStore((s) => s.setDryRun);
  const burst = useStore((s) => s.burstThresholdSec);
  const setBurst = useStore((s) => s.setBurstThreshold);
  const cfg = useStore((s) => s.s3Config);
  const disconnect = useStore((s) => s.disconnect);

  return (
    <div className="max-w-[560px] mx-auto p-8 space-y-8">
      <section>
        <label htmlFor="user" className={kicker}>
          Tagger identity
        </label>
        <input
          id="user"
          className={input}
          placeholder="e.g. jgonzalez"
          value={taggerUser}
          onChange={(e) => setTaggerUser(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[13px] text-inkMute font-body">
          Stamps the audit-snapshot path and the mandatory edit comment on every sync. Required
          before a live sync can run.
        </p>
      </section>

      <section>
        <span className={kicker}>Sync default</span>
        <label className="flex items-center gap-2.5 font-body text-[14px] text-ink">
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          Dry-run (log writes, change nothing)
        </label>
        <p className="mt-1.5 text-[13px] text-inkMute font-body">
          On by default. While on, Sync previews the canonical writes and a snapshot but changes
          nothing. Turn it off to perform the conditional in-place replacement.
        </p>
      </section>

      <section>
        <label htmlFor="burst" className={kicker}>
          Burst grouping threshold — {burst}s
        </label>
        <input
          id="burst"
          type="range"
          min={5}
          max={600}
          step={5}
          value={burst}
          onChange={(e) => setBurst(Number(e.target.value))}
          className="w-full accent-accent"
        />
        <p className="mt-1.5 text-[13px] text-inkMute font-body">
          Images within this window on one camera group into a burst.
        </p>
      </section>

      <section className="border-t border-ruleSoft pt-6">
        <span className={kicker}>Connection</span>
        <p className="text-[13px] font-mono text-inkSoft break-all">{cfg?.endpoint}</p>
        <button
          onClick={disconnect}
          className="mt-3 text-[14px] border border-ink px-3 py-1.5 text-ink hover:bg-panelHover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Disconnect
        </button>
      </section>
    </div>
  );
}
