import type { Policy, PolicyAction } from "pii-gate/core";
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

/** Text with `{{CATEGORY_n}}` placeholders shown as coloured chips. */
export function TokenText({ text, className }: { text: string; className?: string }) {
  return (
    <pre className={cn("whitespace-pre-wrap break-words font-mono text-sm leading-7", className)}>
      {text.split(TOKEN).map((part, i) => {
        const m = /^\{\{([A-Z][A-Z0-9_]*)_\d+\}\}$/.exec(part);
        if (!m) return part;
        return (
          <span key={i} className={cn("rounded px-1 font-semibold", categoryStyle(m[1] as string))}>
            {part}
          </span>
        );
      })}
    </pre>
  );
}
