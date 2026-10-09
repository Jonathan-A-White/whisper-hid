import { CREDITS, KIND_LABELS, NEWTON_QUOTE, WHY_WE_CREDIT } from "../lib/credits";
import type { CreditKind } from "../lib/credits";

interface AboutViewProps {
  onClose: () => void;
}

const KIND_ORDER: CreditKind[] = ["idea", "pwa", "app", "server", "model", "tool", "service"];

const LINK = "text-sky-400 underline underline-offset-2";

export function AboutView({ onClose }: AboutViewProps) {
  return (
    <div className="p-4 space-y-5 pb-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">About</h2>
        <button
          onClick={onClose}
          className="min-h-[44px] px-4 rounded-lg bg-gray-800 text-sky-400 text-sm font-medium"
        >
          Close
        </button>
      </div>

      <figure className="rounded-xl bg-gray-900 px-4 py-4 space-y-2">
        <blockquote className="text-base italic text-gray-100 leading-relaxed">
          “{NEWTON_QUOTE.text}”
        </blockquote>
        <figcaption className="text-xs text-gray-500">{NEWTON_QUOTE.by}</figcaption>
        <p className="pt-2 text-sm text-gray-300 leading-relaxed">{WHY_WE_CREDIT}</p>
      </figure>

      {KIND_ORDER.map((kind) => (
        <section key={kind}>
          <h3 className="px-1 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            {KIND_LABELS[kind]}
          </h3>
          <ul className="rounded-xl bg-gray-900 divide-y divide-gray-800 overflow-hidden">
            {CREDITS.filter((c) => c.kind === kind).map((c) => (
              <li key={c.name} className="px-4 py-3 space-y-1 break-words">
                <a href={c.url} target="_blank" rel="noopener noreferrer" className={`${LINK} text-sm font-medium`}>
                  {c.name}
                </a>
                <p className="text-sm text-gray-300">{c.use}</p>
                <p className="text-xs text-gray-500">
                  Licence:{" "}
                  <a href={c.licenseUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {c.license}
                  </a>
                </p>
                <p className="text-xs text-gray-500">Changes: {c.changes}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
