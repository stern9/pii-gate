"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Policy, PolicyAction } from "pii-gate/core";
import { ArrowRight, Ban, Lock, Send, ShieldCheck, TriangleAlert, Wrench } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ACTIONS, runGate, type Block, type GateRun } from "@/lib/gate";
import { preview } from "@/lib/preview";
import { FAKE_DATA_SOURCES, SAMPLES } from "@/lib/samples";
import { simulatedModel } from "@/lib/simulated-model";
import { cn } from "@/lib/utils";
import { PreviewText, TokenText, actionFor, categoryStyle, type RestoredValue } from "./highlight";

type Mode = "simulated" | "live";
const CUSTOM = "custom";
const MAX_LENGTH = 4000;
const CUSTOM_PLACEHOLDER = `Use made-up details only, for example:
Insured: Alex Sample called from (312) 555-0199 about claim CLM-1001.
Email alex.sample@example.com, DOB 01/02/1980.`;

export function Demo({ liveAvailable, liveModel }: { liveAvailable: boolean; liveModel: string }) {
  const [sampleId, setSampleId] = useState<string>(SAMPLES[0]?.id ?? CUSTOM);
  const [text, setText] = useState(SAMPLES[0]?.text ?? "");
  const [policy, setPolicy] = useState<Policy>({});
  const [mode, setMode] = useState<Mode>("simulated");
  const [mangle, setMangle] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<GateRun | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollNext = useRef(false); // scroll only after a run the visitor started
  const epoch = useRef(0); // bumped on every change, so a stale run can't land
  const [lit, setLit] = useState<number>(STEPS.length); // chips shown at their run state; later ones wait (reveal)
  const timers = useRef(new Set<number>());

  const sample = SAMPLES.find((s) => s.id === sampleId);
  const isCustom = !sample;
  const liveAllowed = liveAvailable && !isCustom;
  const effectiveMode: Mode = liveAllowed ? mode : "simulated";
  const view = useMemo(() => preview(text, policy), [text, policy]);

  // Bring the answer into view after Ask; jump instead of glide for reduced motion.
  useEffect(() => {
    if ((!run && !requestError) || !scrollNext.current) return;
    scrollNext.current = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [run, requestError]);

  // Guided first run: the simulated model answers the default note, so every step is lit without a click.
  useEffect(() => {
    void ask("simulated", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the initial note
  }, []);

  // Drop pending reveal timers on unmount.
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  /** Automatic first run only: light steps 3–5 at 900/1200/1500 ms, once the headline has been read. */
  function reveal() {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setLit(STEPS.length);
    setLit(2);
    for (let n = 3; n <= STEPS.length; n++) {
      const id = window.setTimeout(() => {
        timers.current.delete(id);
        setLit(n);
      }, 900 + (n - 3) * 300);
      timers.current.add(id);
    }
  }

  function reset() {
    epoch.current++;
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    setLit(STEPS.length);
    setRun(null);
    setRequestError(null);
  }

  function choose(id: string) {
    setSampleId(id);
    setText(SAMPLES.find((s) => s.id === id)?.text ?? "");
    reset();
  }

  function edit(value: string) {
    // An edited sample is the visitor's own text from now on: it stays in the browser.
    setSampleId(CUSTOM);
    setText(value);
    reset();
  }

  function setAction(category: string, action: PolicyAction) {
    setPolicy((p) => ({ ...p, [category]: action }));
    reset();
  }

  async function ask(useMode: Mode = effectiveMode, scroll = true) {
    setRunning(true);
    reset();
    const at = epoch.current;
    const land = (fn: () => void) => {
      if (at !== epoch.current) return;
      scrollNext.current = scroll;
      fn();
      if (!scroll) reveal(); // user runs light at once: the scroll takes the strip off-screen anyway
    };
    try {
      if (useMode === "simulated") {
        const result = await runGate(text, policy, "simulated", simulatedModel({ mangle }));
        land(() => setRun(result));
        return;
      }
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sampleId, policy }),
      });
      const body: unknown = await res.json();
      if (res.ok) land(() => setRun(body as GateRun));
      else land(() => setRequestError((body as { message?: string }).message ?? `Request failed (${res.status}).`));
    } catch {
      land(() => setRequestError("Couldn't reach the demo server."));
    } finally {
      setRunning(false);
    }
  }

  function useSimulated() {
    setMode("simulated");
    void ask("simulated");
  }

  const detected = Object.entries(view.counts);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:gap-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden /> pii-gate
        </div>
        <h1 className="text-2xl font-semibold sm:text-3xl tracking-tight text-balance">
          Use an LLM on claim notes without sending it the SSNs.
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          pii-gate swaps names, SSNs, VINs and card numbers for placeholders before the prompt leaves your process, then
          puts the real values back in the reply. Most LLM tasks on this text (summarise, draft, route) don&apos;t need
          the real values.
        </p>
        <Pipeline run={run} lit={lit} />
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a note">
          {SAMPLES.map((s) => (
            <Button key={s.id} size="sm" variant={s.id === sampleId ? "default" : "outline"} onClick={() => choose(s.id)}>
              {s.title}
            </Button>
          ))}
          <Button size="sm" variant={isCustom ? "default" : "outline"} onClick={() => edit(isCustom ? text : "")}>
            Write your own
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          All samples are fictional.{" "}
          <a href="#fake-data" className="underline underline-offset-2 hover:text-foreground">
            Why this data is fake
          </a>
        </p>
      </div>

      <section className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Your note</CardTitle>
            <CardDescription>{sample?.note ?? "Edit freely. Use made-up details."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            <Textarea
              aria-label="Note"
              value={text}
              maxLength={MAX_LENGTH}
              placeholder={CUSTOM_PLACEHOLDER}
              onChange={(e) => edit(e.target.value)}
              // Phones: about six lines, room to grow while editing.
              className="flex-1 font-mono text-sm leading-7 transition-[max-height] max-sm:max-h-48 max-sm:focus:max-h-[32rem] sm:min-h-72"
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {isCustom ? "Your own text never leaves this browser tab." : "Fictional sample. Edit it to make it your own."}
            </p>
            <p className="text-xs text-muted-foreground">
              Names are found after a label such as <code>Name:</code>, <code>Insured:</code> or <code>Claimant:</code>,
              or a title such as <code>Mr.</code> or <code>Dr.</code> An unlabelled name needs an NER model.
            </p>
          </CardContent>
        </Card>

        <ArrowRight className="hidden size-6 self-center text-muted-foreground lg:block" aria-hidden />

        {/* First on phones: the masked result is the point of the page. */}
        <Card className="max-sm:order-first">
          <CardHeader>
            <CardTitle>What the model sees (steps 1–2)</CardTitle>
            <CardDescription>Updates as you type. Choose what happens to each kind of detail.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            {view.kind === "blocked" && (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <Ban className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  Your policy blocks {view.blocked.join(", ")}, so this request would not be sent. Use Mask to send a
                  placeholder instead.
                </span>
              </p>
            )}
            {sample?.shape === "tool_result" && sample.toolCall && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Wrench className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  Sent as a tool result: the user asked &ldquo;{sample.toolCall.ask}&rdquo;, the model called{" "}
                  <code>{sample.toolCall.name}</code>, and this record came back.
                </span>
              </p>
            )}
            <div
              className={cn("min-h-40 flex-1 rounded-lg border bg-muted/30 p-3", view.kind === "blocked" && "opacity-40")}
              aria-label={view.kind === "blocked" ? "Masked text that would have been sent (blocked)" : undefined}
            >
              <PreviewText segments={view.segments} />
            </div>

            {detected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No personal details detected.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detected.map(([category, count]) => (
                  <li key={category} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm">
                      <span className={cn("rounded px-1.5 py-0.5 font-mono text-xs", categoryStyle(category))}>{category}</span>
                      <span className="text-muted-foreground">{countLabel(category, count, view.distinct[category])}</span>
                    </span>
                    <ActionPicker category={category} value={actionFor(category, policy)} onChange={setAction} />
                  </li>
                ))}
              </ul>
            )}
            {view.allowed.map((category) => (
              <p key={category} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  <code>{category}</code> will be sent in clear text and counted in the audit row.
                </span>
              </p>
            ))}
            {detected.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Mask</span> sends a placeholder ·{" "}
                <span className="font-medium text-foreground">Block</span> stops the whole request ·{" "}
                <span className="font-medium text-foreground">Allow</span> sends the real value, counted in the audit row
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Policy, claim and account numbers are left alone on purpose, even when they look like a phone number or
              SSN.
              {view.hasKept && (
                <>
                  {" "}
                  <span className="underline decoration-dotted decoration-2 underline-offset-4">Dotted underline</span>{" "}
                  marks one in this note.
                </>
              )}
            </p>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Send to a model (step 3)</CardTitle>
          <CardDescription>
            The model gets the right-hand text, replies with placeholders, and pii-gate puts the real values back.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Which model">
            <ModelOption
              selected={effectiveMode === "simulated"}
              onSelect={() => setMode("simulated")}
              title="Simulated model"
              body="A stand-in that runs in your browser. Free and instant. Nothing leaves this tab."
            >
              <div className="flex items-start gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                <Switch id="mangle" checked={mangle} onCheckedChange={(v) => setMangle(v)} />
                <Label htmlFor="mangle" className="text-xs font-normal leading-5 text-muted-foreground">
                  Test a mistake: the model mistypes one placeholder, and pii-gate flags it instead of guessing.
                </Label>
              </div>
            </ModelOption>
            <ModelOption
              selected={effectiveMode === "live"}
              disabled={!liveAllowed}
              onSelect={() => setMode("live")}
              title={`Claude (${liveModel})`}
              body={
                !liveAvailable
                  ? "Not configured on this deployment."
                  : isCustom
                    ? "Built-in samples only, so your own text never leaves the browser."
                    : "A real API call. The server looks up the fictional sample itself and sends the masked version."
              }
            />
          </div>
          <Button className="self-start" size="lg" onClick={() => ask()} disabled={running || text.trim() === ""}>
            <Send aria-hidden />{" "}
            {running
              ? "Asking…"
              : `${run || requestError ? "Run again" : "Ask the model"}${view.kind === "blocked" ? " (will be blocked)" : ""}`}
          </Button>
        </CardContent>
      </Card>

      {/* One line for screen readers; the card itself isn't live, so its tabs and JSON aren't read out. */}
      <p className="sr-only" role="status">
        {requestError ? "Live Claude didn't answer." : run ? runStatus(run) : ""}
      </p>
      <div ref={resultsRef} className="flex scroll-mt-4 flex-col gap-4">
        {requestError && <LiveUnavailable reason={requestError} onSimulate={useSimulated} />}
        {run && (
          // Fades in with step 4; already in the layout, so nothing shifts.
          <div className={cn("transition-opacity duration-300 motion-reduce:transition-none", lit < 4 && "opacity-0")}>
            <Results run={run} onSimulate={useSimulated} />
          </div>
        )}
      </div>

      <footer id="fake-data" className="mt-6 scroll-mt-4 border-t pt-6 text-sm text-muted-foreground">
        <h2 className="mb-2 font-medium text-foreground">Why this data is fake</h2>
        <ul className="grid gap-1 sm:grid-cols-2">
          {FAKE_DATA_SOURCES.map((s) => (
            <li key={s.kind}>
              <span className="font-medium text-foreground">{s.kind}:</span> {s.why}
            </li>
          ))}
        </ul>
      </footer>
    </main>
  );
}

/** The live-region line for a finished run. */
function runStatus(run: GateRun): string {
  if (!run.ok) {
    if (run.error.upstream) return "Claude couldn't be reached. Nothing unmasked left the server.";
    return run.error.blockedCategories ? "Blocked: nothing reached the model." : `Rejected: ${run.error.name}.`;
  }
  if (run.stopReason === "refusal") return "The model declined this request.";
  const n = run.restoredValues?.length ?? 0, w = run.warnings.length;
  const flagged = w ? ` ${w} mistyped ${w === 1 ? "placeholder" : "placeholders"} flagged, not guessed.` : "";
  return `Reply received: ${n} ${n === 1 ? "placeholder" : "placeholders"} restored.${flagged}`;
}

type StepState = "on" | "off" | "skipped";

const STEPS = [
  { name: "Detect", body: "regex detectors + your hints" },
  { name: "Mask", body: "{{PERSON_1}} goes out, the name stays in a per-request vault" },
  { name: "Model", body: "sees placeholders only" },
  { name: "Restore", body: "real values back in text and tool-call args" },
  { name: "Audit", body: "counts, never values" },
] as const;

/** Which steps a run reached: a block (or a failed model call) skips 3–4 but still writes the audit row. */
function stepStates(run: GateRun | null): StepState[] {
  if (!run) return ["on", "on", "off", "off", "off"];
  if (run.ok) return ["on", "on", "on", "on", "on"];
  return ["on", "on", "skipped", "skipped", run.audit ? "on" : "skipped"];
}

/** Phones: a compact list. Wider: five equal-height chips joined by arrows. */
/** `lit`: chips past it still look idle while the reveal plays; screen readers get the final state. */
function Pipeline({ run, lit }: { run: GateRun | null; lit: number }) {
  const final = stepStates(run);
  return (
    <ol className="grid gap-1.5 pt-1 sm:grid-cols-5 sm:gap-5" aria-label="How pii-gate handles a request">
      {STEPS.map((step, i) => {
        const state: StepState = i < lit ? (final[i] as StepState) : "off";
        return (
          <li
            key={step.name}
            className={cn(
              "relative flex items-start gap-2 transition-[color,background-color,border-color,opacity] duration-300 motion-reduce:transition-none sm:rounded-lg sm:border sm:px-2.5 sm:py-1.5",
              state === "on" ? "sm:border-primary/40 sm:bg-primary/5" : "text-muted-foreground sm:border-dashed",
              state === "skipped" && "opacity-50",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold sm:mt-0.5",
                state === "on" ? "bg-primary text-primary-foreground" : "border",
              )}
              aria-hidden
            >
              {i + 1}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-2 max-sm:pt-px sm:flex-col">
              <span className={cn("text-sm font-medium", state === "skipped" && "line-through")}>
                {step.name}
                <span className="sr-only">
                  {final[i] === "on" ? " (done)" : final[i] === "skipped" ? " (skipped)" : " (after you ask)"}
                </span>
              </span>
              <span className="text-xs leading-4 text-muted-foreground">{step.body}</span>
            </span>
            {i < STEPS.length - 1 && (
              <ArrowRight
                className="absolute top-1/2 -right-[1.125rem] hidden size-4 -translate-y-1/2 text-muted-foreground sm:block"
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Short label on phones, long one from 640px. */
function Short({ short, long }: { short: string; long: string }) {
  return (
    <>
      <span className="sm:hidden" aria-hidden>
        {short}
      </span>
      <span className="max-sm:sr-only">{long}</span>
    </>
  );
}

const NOUNS: Record<string, [string, string]> = {
  PERSON: ["person", "people"],
  SSN: ["SSN", "SSNs"],
  PHONE: ["phone number", "phone numbers"],
  EMAIL: ["email address", "email addresses"],
  VIN: ["VIN", "VINs"],
  CREDIT_CARD: ["card number", "card numbers"],
  DOB: ["date of birth", "dates of birth"],
  DRIVERS_LICENSE: ["license", "licenses"],
  ADDRESS: ["address", "addresses"],
};

/** "3 mentions · 1 person": mentions vs distinct values (placeholders). Allowed values have no placeholder. */
function countLabel(category: string, mentions: number, distinct?: number): string {
  const [one, many] = NOUNS[category] ?? ["value", "values"];
  const noun = (n: number) => `${n} ${n === 1 ? one : many}`;
  const said = `${mentions} ${mentions === 1 ? "mention" : "mentions"}`;
  // Allowed values get no placeholder, so count them as values: "1 SSN", "3 mentions" for repeats.
  if (distinct === undefined) return mentions === 1 ? noun(1) : said;
  return distinct === mentions ? noun(distinct) : `${said} · ${noun(distinct)}`;
}

function ModelOption({
  selected,
  disabled,
  onSelect,
  title,
  body,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary ring-1 ring-primary" : "hover:bg-muted/50",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span
          className={cn("size-3.5 rounded-full border", selected ? "border-4 border-primary" : "border-muted-foreground")}
          aria-hidden
        />
        {title}
      </span>
      <span className="text-sm text-muted-foreground">{body}</span>
      {selected && children}
    </div>
  );
}

const ACTION_HELP: Record<PolicyAction, string> = {
  mask: "Replace with a placeholder",
  block: "Refuse to send the request",
  allow: "Send as-is, but count it",
};

function ActionPicker({
  category,
  value,
  onChange,
}: {
  category: string;
  value: PolicyAction;
  onChange: (category: string, action: PolicyAction) => void;
}) {
  return (
    <span className="inline-flex rounded-lg border p-0.5" role="radiogroup" aria-label={`${category}: what to do`}>
      {ACTIONS.map((action) => (
        <button
          key={action}
          type="button"
          role="radio"
          title={ACTION_HELP[action]}
          aria-checked={value === action}
          onClick={() => onChange(category, action)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs capitalize transition-colors",
            value === action
              ? action === "block"
                ? "bg-destructive text-white"
                : "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {action}
        </button>
      ))}
    </span>
  );
}

function LiveUnavailable({ reason, onSimulate }: { reason: string; onSimulate: () => void }) {
  return (
    <Alert>
      <TriangleAlert aria-hidden />
      <AlertTitle>Live Claude didn&apos;t answer</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>{reason}</p>
        <Button size="sm" variant="outline" onClick={onSimulate}>
          Run it with the simulated model instead
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** `model` labels a reply's source; omitted when nothing reached a model. */
function ResultCard({ model, description, children }: { model?: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2">
          What came back (steps 4–5)
          {model && (
            <span className="text-xs font-normal text-muted-foreground">
              from {model === "simulated" ? "the simulated model" : model}
            </span>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Results({ run, onSimulate }: { run: GateRun; onSimulate: () => void }) {
  if (!run.ok && run.error.upstream) {
    return (
      <ResultCard description="The model call failed after masking.">
        <LiveUnavailable
          reason="Claude couldn't be reached. The note was masked before it was sent, so no personal details left the server."
          onSimulate={onSimulate}
        />
        {run.audit && <Audit audit={run.audit} />}
      </ResultCard>
    );
  }
  if (!run.ok) {
    const blocked = run.error.blockedCategories;
    return (
      <ResultCard description="The request stopped inside your process. Your app gets an error and an audit row.">
        <Alert variant="destructive">
          <Ban aria-hidden />
          <AlertTitle>{blocked ? "Blocked: nothing reached the model" : `Rejected: ${run.error.name}`}</AlertTitle>
          <AlertDescription>
            {blocked
              ? `Your policy blocks ${blocked.join(", ")}, so pii-gate threw ${run.error.name} before calling the model. The error names the category, never the value.`
              : "Nothing was sent to the model."}
          </AlertDescription>
        </Alert>
        {run.audit && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Audit row</h3>
            <Audit audit={run.audit} intro="A block still writes an audit row, so you can see what was stopped and why. Counts only, never the values." />
          </section>
        )}
      </ResultCard>
    );
  }

  return (
    <ResultCard model={run.audit.model} description="The model's reply, the same reply with real values restored, and the audit row.">
      {run.stopReason === "refusal" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>The model declined this request</AlertTitle>
          <AlertDescription>Try another sample or the simulated model.</AlertDescription>
        </Alert>
      )}
      {run.warnings.length > 0 && (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>A mistyped placeholder was left as written</AlertTitle>
          <AlertDescription>
            {run.warnings.map((w) => (
              <p key={`${w.path ?? ""}${w.index}`}>
                The model wrote <code>{w.found}</code>, which looks like <code>{w.suggestion ?? "an unknown token"}</code>.
                pii-gate flags it instead of guessing, because a wrong guess could put one customer&apos;s data in a
                sentence about another.
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="restored">
        <TabsList className="max-w-full flex-wrap group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="reply">
            <Short short="Reply" long="Model's reply (placeholders)" />
          </TabsTrigger>
          <TabsTrigger value="restored">
            <Short short="Restored" long="Restored (what your app gets)" />
          </TabsTrigger>
          <TabsTrigger value="audit">
            <Short short="Audit" long="Audit row" />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="reply" className="pt-3">
          <p className="mb-3 text-sm text-muted-foreground">Exactly what came back from the model: placeholders only.</p>
          <Blocks blocks={run.raw} />
        </TabsContent>
        <TabsContent value="restored" className="pt-3">
          <p className="mb-3 text-sm text-muted-foreground">
            Placeholders swapped back for the real values, in the text and in the tool call&apos;s arguments. Each
            coloured value was restored; hover it to see the placeholder it replaced.
          </p>
          <Blocks blocks={run.restored} values={run.restoredValues ?? []} />
        </TabsContent>
        <TabsContent value="audit" className="pt-3">
          <Audit audit={run.audit} />
        </TabsContent>
      </Tabs>
    </ResultCard>
  );
}

function Blocks({ blocks, values }: { blocks: readonly Block[]; values?: readonly RestoredValue[] }) {
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <TokenText key={i} text={String(b.text ?? "")} values={values} />
        ) : (
          <ToolCall key={i} block={b} values={values} />
        ),
      )}
    </div>
  );
}

function ToolCall({ block, values }: { block: Block; values?: readonly RestoredValue[] }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const { summary, ...rest } = input;
  const hasSummary = typeof summary === "string";
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Tool call: {String(block.name)}</div>
      {hasSummary && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Tool input: summary</div>
          <TokenText text={summary} values={values} />
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {hasSummary ? "Other tool inputs" : "Tool input"}
        </div>
        <TokenText text={JSON.stringify(hasSummary ? rest : input, null, 2)} values={values} className="text-xs leading-6" />
      </div>
    </div>
  );
}

function Audit({
  audit,
  intro = "One row per request. Counts and totals only, never the values.",
}: {
  audit: object;
  intro?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{intro}</p>
      <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6">
        {JSON.stringify(audit, null, 2)}
      </pre>
    </div>
  );
}
