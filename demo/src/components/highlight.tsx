import type { Policy, PolicyAction } from "pii-gate/core";
import type { Segment } from "@/lib/preview";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<string, string> = {
  PERSON: "bg-sky-100 text-sky-950 dark:bg-sky-900/50 dark:text-sky-50",
  SSN: "bg-rose-100 text-rose-950 dark:bg-rose-900/50 dark:text-rose-50",
  PHONE: "bg-emerald-100 text-emerald-950 dark:bg-emerald-900/50 dark:text-emerald-50",
  EMAIL: "bg-teal-100 text-teal-950 dark:bg-teal-900/50 dark:text-teal-50",
  VIN: "bg-amber-100 text-amber-950 dark:bg-amber-900/50 dark:text-amber-50",
  CREDIT_CARD: "bg-fuchsia-100 text-fuchsia-950 dark:bg-fuchsia-900/50 dark:text-fuchsia-50",
  DOB: "bg-violet-100 text-violet-950 dark:bg-violet-900/50 dark:text-violet-50",
  DRIVERS_LICENSE: "bg-orange-100 text-orange-950 dark:bg-orange-900/50 dark:text-orange-50",
  ADDRESS: "bg-lime-100 text-lime-950 dark:bg-lime-900/50 dark:text-lime-50",
};

export function categoryStyle(category: string): string {
  return CATEGORY_STYLE[category] ?? "bg-muted text-foreground";
}

export function actionFor(category: string, policy: Policy): PolicyAction {
  return policy[category] ?? "mask";
}

const TOKEN = /(\{\{[A-Z][A-Z0-9_]*_\d+\}\})/g;

export interface RestoredValue {
  token: string;
  category: string;
  value: string;
}

/** A value in its category colour: a placeholder, or a real value pii-gate put back. */
export function Chip({ category, title, children }: { category: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn("rounded px-1 font-semibold", categoryStyle(category))}>
      {children}
    </span>
  );
}

/** Splits plain text on restored values (longest first) and chips each occurrence. */
function withValues(text: string, values: readonly RestoredValue[], key: string): React.ReactNode[] {
  const sorted = values.filter((v) => v.value.length > 1).sort((a, b) => b.value.length - a.value.length);
  if (sorted.length === 0) return [text];
  const re = new RegExp(`(${sorted.map((v) => v.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return text.split(re).map((part, i) => {
    const v = i % 2 === 1 ? sorted.find((x) => x.value === part) : undefined;
    return v ? (
      <Chip key={`${key}-${i}`} category={v.category} title={`Restored from ${v.token}`}>
        {part}
      </Chip>
    ) : (
      part
    );
  });
}

/**
 * Text with `{{CATEGORY_n}}` placeholders shown as coloured chips. With
 * `values`, the restored originals get the same chips, so placeholder-in /
 * value-out lines up visually.
 */
export function TokenText({
  text,
  values = [],
  className,
}: {
  text: string;
  values?: readonly RestoredValue[];
  className?: string;
}) {
  return (
    <pre className={cn("whitespace-pre-wrap break-words font-mono text-sm leading-7", className)}>
      {text.split(TOKEN).flatMap<React.ReactNode>((part, i) => {
        const m = /^\{\{([A-Z][A-Z0-9_]*)_\d+\}\}$/.exec(part);
        if (!m) return withValues(part, values, String(i));
        return [
          <Chip key={i} category={m[1] as string}>
            {part}
          </Chip>,
        ];
      })}
    </pre>
  );
}

/** The masked preview: placeholders, values sent as-is (Allow), and identifiers kept on purpose. */
export function PreviewText({ segments }: { segments: readonly Segment[] }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7">
      {segments.map((s, i) => {
        if (s.kind === "text") return s.text;
        if (s.kind === "token") return <Chip key={i} category={s.category}>{s.text}</Chip>;
        if (s.kind === "allow")
          return (
            <span
              key={i}
              title={`${s.category}: sent as-is`}
              className="rounded border border-dashed border-amber-600 px-1 text-amber-900 dark:border-amber-400 dark:text-amber-200"
            >
              {s.text}
              <span className="ml-1 rounded-sm bg-amber-100 px-1 font-sans text-[0.65rem] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
                sent as-is
              </span>
            </span>
          );
        return (
          <span
            key={i}
            title="Kept: labelled identifier"
            className="underline decoration-muted-foreground decoration-dotted decoration-2 underline-offset-4"
          >
            {s.text}
            <span className="sr-only"> (kept: labelled identifier)</span>
          </span>
        );
      })}
    </pre>
  );
}
