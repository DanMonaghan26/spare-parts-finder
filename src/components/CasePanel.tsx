import type { RepairCase } from "@/lib/case";

const LIKELIHOOD_STYLES = {
  high: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
} as const;

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={`text-right font-medium ${value ? "" : "text-zinc-400 dark:text-zinc-600"}`}>
        {value || "—"}
      </dd>
    </div>
  );
}

function Step({ n, label, done }: { n: number; label: string; done: boolean }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          done
            ? "bg-teal-600 text-white"
            : "border border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={done ? "font-medium" : "text-zinc-500 dark:text-zinc-400"}>{label}</span>
    </li>
  );
}

export function CasePanel({ repair }: { repair: RepairCase }) {
  const faultKnown = Boolean(repair.symptoms || repair.likelyFaults?.length);
  const parts = repair.recommendedParts ?? [];

  return (
    <div className="space-y-5">
      <ol className="space-y-2">
        <Step n={1} label="Describe the fault" done={faultKnown} />
        <Step n={2} label="Confirm the model number" done={Boolean(repair.modelConfirmed)} />
        <Step n={3} label="Find the right part" done={parts.length > 0} />
      </ol>

      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Appliance</h2>
        <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
          <Row label="Type" value={repair.applianceType} />
          <Row label="Brand" value={repair.brand} />
          <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Model</dt>
            <dd className="flex items-center gap-2 text-right">
              {repair.modelNumber ? (
                <>
                  <span className="font-mono font-medium">{repair.modelNumber}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      repair.modelConfirmed
                        ? "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300"
                        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {repair.modelConfirmed ? "Confirmed" : "Unconfirmed"}
                  </span>
                </>
              ) : (
                <span className="text-zinc-400 dark:text-zinc-600">—</span>
              )}
            </dd>
          </div>
        </dl>
        {repair.modelPageUrl && (
          <a
            href={repair.modelPageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-medium text-teal-700 underline underline-offset-2 dark:text-teal-400"
          >
            All parts for this model on eSpares →
          </a>
        )}
      </section>

      {faultKnown && (
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Fault</h2>
          {repair.symptoms && <p className="text-sm">{repair.symptoms}</p>}
          {repair.likelyFaults && repair.likelyFaults.length > 0 && (
            <ul className="mt-2 space-y-2">
              {repair.likelyFaults.map((f, i) => (
                <li key={i} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{f.part}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${LIKELIHOOD_STYLES[f.likelihood]}`}>
                      {f.likelihood}
                    </span>
                  </div>
                  <p className="text-zinc-500 dark:text-zinc-400">{f.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {parts.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Suggested parts</h2>
          <ul className="space-y-2">
            {parts.map((p, i) => (
              <li key={i}>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-xl border border-zinc-200 p-3 transition hover:border-teal-500 hover:shadow-sm dark:border-zinc-800 dark:hover:border-teal-500"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.price && <span className="shrink-0 text-sm font-semibold text-teal-700 dark:text-teal-400">{p.price}</span>}
                  </div>
                  {p.partNumber && <p className="mt-0.5 font-mono text-xs text-zinc-500">Part no. {p.partNumber}</p>}
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{p.why}</p>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
