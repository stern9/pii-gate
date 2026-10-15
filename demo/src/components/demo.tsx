"use client";

import { useMemo, useState } from "react";
import { PiiBlockedError, mask, type Policy, type PolicyAction } from "pii-gate/core";
import { ArrowRight, Ban, Lock, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ACTIONS, runGate, type Block, type GateRun } from "@/lib/gate";
import { FAKE_DATA_SOURCES, SAMPLES } from "@/lib/samples";
import { simulatedModel } from "@/lib/simulated-model";
import { cn } from "@/lib/utils";
import { TokenText, actionFor, categoryStyle } from "./highlight";

type Mode = "simulated" | "live";
const CUSTOM = "custom";
const MAX_LENGTH = 4000;

type Preview =
  | { kind: "masked"; text: string; counts: Record<string, number> }
  | { kind: "blocked"; categories: string[]; counts: Record<string, number> };

/** Live preview of the masking step, run in the browser on every keystroke. */
function preview(text: string, policy: Policy): Preview {
  const all = mask(text);
  const counts: Record<string, number> = {};
  for (const f of all.findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  try {
    return { kind: "masked", text: mask(text, { policy }).masked, counts };
  } catch (err) {
    if (err instanceof PiiBlockedError) return { kind: "blocked", categories: err.categories, counts };
    throw err;
  }
}

export function Demo({ liveAvailable, liveModel }: { liveAvailable: boolean; liveModel: string }) {
  const [sampleId, setSampleId] = useState<string>(SAMPLES[0]?.id ?? CUSTOM);
  const [text, setText] = useState(SAMPLES[0]?.text ?? "");
  const [policy, setPolicy] = useState<Policy>({});
  const [mode, setMode] = useState<Mode>("simulated");
  const [mangle, setMangle] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<GateRun | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const sample = SAMPLES.find((s) => s.id === sampleId);
  const isCustom = !sample;
  const liveAllowed = liveAvailable && !isCustom;
  const effectiveMode: Mode = liveAllowed ? mode : "simulated";
  const view = useMemo(() => preview(text, policy), [text, policy]);

  function reset() {
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

  async function ask(useMode: Mode = effectiveMode) {
    setRunning(true);
    reset();
    try {
      if (useMode === "simulated") {
        setRun(await runGate(text, policy, "simulated", simulatedModel({ mangle })));
        return;
      }
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sampleId, policy }),
      });
      const body: unknown = await res.json();
      if (res.ok) setRun(body as GateRun);
      else setRequestError((body as { message?: string }).message ?? `Request failed (${res.status}).`);
    } catch {
      setRequestError("Couldn't reach the demo server.");
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
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden /> pii-gate
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">See what an LLM sees when personal data is masked</h1>
        <p className="max-w-3xl text-muted-foreground">
          Type or pick a note, and see what pii-gate sends to the model instead. Ask the model, and the reply comes
          back with the real values restored.
        </p>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">All samples are fictional. Why this data is fake</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {FAKE_DATA_SOURCES.map((s) => (
              <li key={s.kind}>
                <span className="font-medium text-foreground">{s.kind}:</span> {s.why}
              </li>
            ))}
          </ul>
        </details>
      </header>

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
              onChange={(e) => edit(e.target.value)}
              className="min-h-72 flex-1 font-mono text-sm leading-7"
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

        <Card>
          <CardHeader>
            <CardTitle>What the model sees</CardTitle>
            <CardDescription>Updates as you type. Choose what happens to each kind of detail.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            {view.kind === "masked" ? (
              <div className="min-h-40 flex-1 rounded-lg border bg-muted/30 p-3">
                <TokenText text={view.text} />
              </div>
            ) : (
              <Alert variant="destructive" className="flex-1">
                <Ban aria-hidden />
                <AlertTitle>Nothing would be sent</AlertTitle>
                <AlertDescription>
                  The policy blocks {view.categories.join(", ")}, so the whole request stops before the model is called.
                </AlertDescription>
              </Alert>
            )}

            {detected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No personal details detected.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detected.map(([category, count]) => (
                  <li key={category} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm">
                      <span className={cn("rounded px-1.5 py-0.5 font-mono text-xs", categoryStyle(category))}>{category}</span>
                      <span className="text-muted-foreground">×{count}</span>
                    </span>
                    <ActionPicker category={category} value={actionFor(category, policy)} onChange={setAction} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Send the masked note to a model</CardTitle>
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
            <Send aria-hidden /> {running ? "Asking…" : "Ask the model"}
          </Button>
        </CardContent>
      </Card>

      {requestError && <LiveUnavailable reason={requestError} onSimulate={useSimulated} />}

      {run && <Results run={run} onSimulate={useSimulated} />}
    </main>
  );
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

function Results({ run, onSimulate }: { run: GateRun; onSimulate: () => void }) {
  if (!run.ok && run.error.upstream) {
    return (
      <section className="flex flex-col gap-4">
        <LiveUnavailable
          reason="Claude couldn't be reached. The note was masked before it was sent, so no personal details left the server."
          onSimulate={onSimulate}
        />
        {run.audit && <Audit audit={run.audit} />}
      </section>
    );
  }
  if (!run.ok) {
    return (
      <section className="flex flex-col gap-4">
        <Alert variant="destructive">
          <Ban aria-hidden />
          <AlertTitle>
            {run.error.name === "PiiBlockedError" ? "Blocked before the model was called" : `Rejected: ${run.error.name}`}
          </AlertTitle>
          <AlertDescription>
            {run.error.blockedCategories
              ? `Nothing was sent. The error and the audit row name the blocked category (${run.error.blockedCategories.join(", ")}), never the value.`
              : "Nothing was sent to the model."}
          </AlertDescription>
        </Alert>
        {run.audit && <Audit audit={run.audit} />}
      </section>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
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
          <TabsList>
            <TabsTrigger value="reply">Model&apos;s reply</TabsTrigger>
            <TabsTrigger value="restored">What your app gets</TabsTrigger>
            <TabsTrigger value="audit">Audit row</TabsTrigger>
          </TabsList>
          <TabsContent value="reply" className="pt-3">
            <p className="mb-3 text-sm text-muted-foreground">Exactly what came back from the model: placeholders only.</p>
            <Blocks blocks={run.raw} />
          </TabsContent>
          <TabsContent value="restored" className="pt-3">
            <p className="mb-3 text-sm text-muted-foreground">
              Placeholders swapped back for the real values, in the text and in the tool call the model made.
            </p>
            <Blocks blocks={run.restored} />
          </TabsContent>
          <TabsContent value="audit" className="pt-3">
            <Audit audit={run.audit} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <TokenText key={i} text={String(b.text ?? "")} />
        ) : (
          <ToolCall key={i} block={b} />
        ),
      )}
    </div>
  );
}

function ToolCall({ block }: { block: Block }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const { summary, ...rest } = input;
  return (
    <div className="flex flex-col gap-3">
      {typeof summary === "string" && <TokenText text={summary} />}
      <div className="rounded-lg border bg-muted/30 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Tool call: {String(block.name)}</div>
        <TokenText text={JSON.stringify(typeof summary === "string" ? rest : input, null, 2)} className="text-xs leading-6" />
      </div>
    </div>
  );
}

function Audit({ audit }: { audit: object }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">One row per request. Counts and totals only, never the values.</p>
      <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-6">
        {JSON.stringify(audit, null, 2)}
      </pre>
    </div>
  );
}
