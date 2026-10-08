import type { ReactNode } from "react";

/**
 * One group on the Settings screen: a small uppercase heading above a
 * rounded card whose rows are separated by hairlines.
 */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="px-1 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
        {title}
      </h3>
      <div className="rounded-xl bg-gray-900 divide-y divide-gray-800 overflow-hidden">
        {children}
      </div>
    </section>
  );
}
