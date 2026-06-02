export function History() {
  return (
    <div className="px-6 py-6">
      <div className="max-w-2xl mx-auto border border-ruleSoft bg-panel px-6 py-12 text-center">
        <p className="font-display text-[18px] text-ink mb-1">No uploads yet</p>
        <p className="font-body text-[14px] text-inkSoft">
          Past uploads from this connection — date, collection, deployment, file count, and status —
          appear here once uploads ship (P4) and resume state is tracked (P5).
        </p>
      </div>
    </div>
  );
}
