import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FactoryOnboardingProposal,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryManagers,
} from "./factoryState";
import {
  initialOnboardingForm,
  onboardingApproveBlocker,
  onboardingResultFromForm,
  OTHER_ANSWER,
  sameColumn,
  toggleColumn,
  type OnboardingForm,
} from "./factoryOnboardingCard.logic";

/**
 * Stands in for a `factory_propose_onboarding` call in a manager's thread. It reads the live
 * proposal from the managers feed, not the call's arguments, and only the newest call acts.
 */
export function FactoryOnboardingCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly latest: boolean;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const manager = useFactoryManagers(props.environmentId)?.find(
    (entry) => props.threadId !== null && entry.threadId === props.threadId,
  );
  if (!props.latest) return <CollapsedLine>Replaced by a later proposal</CollapsedLine>;
  // The managers feed may still be loading; the call must not vanish from the timeline meanwhile.
  if (manager === undefined) return <CollapsedLine>Onboarding proposal</CollapsedLine>;
  if (manager.onboardingResult !== null) return <CollapsedLine>Onboarding approved</CollapsedLine>;
  // Paused or retired before approving: nothing here can act until it resumes onboarding.
  if (manager.state === "retired") return <CollapsedLine>Manager retired</CollapsedLine>;
  if (manager.state !== "onboarding") return <CollapsedLine>Onboarding paused</CollapsedLine>;
  if (manager.onboardingProposal === null) return null;
  return (
    <OnboardingProposalForm
      // A new proposal starts a fresh review.
      key={manager.onboardingProposal.proposedAt}
      environmentId={props.environmentId}
      managerId={manager.id}
      projectId={manager.projectId}
      proposal={manager.onboardingProposal}
      onSendMessage={props.onSendMessage}
    />
  );
}

function CollapsedLine(props: { readonly children: ReactNode }) {
  return <p className="px-1 text-xs text-muted-foreground">{props.children}</p>;
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function OnboardingProposalForm(props: {
  readonly environmentId: EnvironmentId;
  readonly managerId: string;
  readonly projectId: ProjectId;
  readonly proposal: FactoryOnboardingProposal;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { environmentId, proposal } = props;
  const canApprove = useAtomValue(
    factoryEnvironment.approveOnboarding.permissionAtom(environmentId),
  );
  const approveCommand = useAtomCommand(factoryEnvironment.approveOnboarding, {
    reportFailure: false,
  });
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const [form, setForm] = useState<OnboardingForm>(() => initialOnboardingForm(proposal));
  // Approve waits for the real cap rather than sending a guess.
  const [config, setConfig] = useState<{ readonly cap: number } | "loading" | "failed">("loading");
  const [newPath, setNewPath] = useState("");
  const [note, setNote] = useState("");
  const [asked, setAsked] = useState<ReadonlySet<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void getConfig({
      environmentId,
      input: { projectId: props.projectId },
    }).then((result) => {
      if (!current) return;
      setConfig(
        result._tag === "Success" ? { cap: result.value.effective.concurrencyCap } : "failed",
      );
    });
    return () => {
      current = false;
    };
  }, [environmentId, props.projectId, getConfig]);

  // Only the review controls need the approve permission; sending into the thread does not.
  const readOnly = !canApprove || busy;
  const send = props.onSendMessage;
  const blocker =
    config === "loading"
      ? "Loading the factory settings…"
      : config === "failed"
        ? "Could not read the factory settings"
        : onboardingApproveBlocker(proposal, form);
  const boards = proposal.detected.boards.filter((board) => board.readyColumns.length > 0);
  const pickupUnavailable =
    proposal.detected.boards.length === 0
      ? "Connect a board in Issues to turn on pickup"
      : boards.length === 0
        ? "No board has a Ready column; map one in Issues"
        : null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    let failure: unknown = null;
    await action().catch((cause: unknown) => {
      failure = cause;
    });
    setBusy(false);
    if (failure !== null) setError(factoryErrorMessage(failure));
    return failure === null;
  };
  const approve = () => {
    if (typeof config !== "object") return;
    void run(async () => {
      unwrapFactoryResult(
        await approveCommand({
          environmentId,
          input: {
            requestId: randomUUID(),
            managerId: props.managerId,
            result: onboardingResultFromForm(proposal, form, config.cap),
          },
        }),
      );
    });
  };
  const draftTicket = (index: number, finding: string) => {
    if (!send) return;
    void run(() =>
      send(`Draft a ticket for this onboarding finding with factory_draft_ticket: ${finding}`),
    ).then((sent) => {
      if (sent) setAsked((current) => new Set(current).add(index));
    });
  };
  const sendBack = () => {
    const text = note.trim();
    if (!send || text === "") return;
    void run(() => send(text)).then((sent) => {
      if (sent) setNote("");
    });
  };
  const addPath = () => {
    const path = newPath.trim();
    if (path === "" || form.controlPaths.some((entry) => entry.path === path)) return;
    setForm({ ...form, controlPaths: [...form.controlPaths, { path, reason: "", kept: true }] });
    setNewPath("");
  };

  return (
    <div className="mx-1 space-y-4 rounded-lg border bg-card p-3 text-sm">
      <div className="space-y-1">
        <h2 className="text-xs font-medium text-muted-foreground">Onboarding proposal</h2>
        {proposal.summary === "" ? null : <p className="whitespace-pre-wrap">{proposal.summary}</p>}
      </div>

      <Section title="Purpose">
        <Textarea
          aria-label="Purpose"
          size="sm"
          rows={2}
          disabled={readOnly}
          value={form.purpose}
          onChange={(event) => setForm({ ...form, purpose: event.target.value })}
        />
      </Section>

      <Section title="Pickup">
        <Label>
          <Switch
            size="sm"
            checked={form.pickupEnabled}
            disabled={readOnly || pickupUnavailable !== null}
            onCheckedChange={(checked) => setForm({ ...form, pickupEnabled: checked })}
          />
          Pick up tickets on its own
        </Label>
        {pickupUnavailable !== null ? (
          <p className="text-xs text-muted-foreground">{pickupUnavailable}</p>
        ) : proposal.pickup.enabled && !form.pickupEnabled ? (
          <p className="text-xs text-muted-foreground">The manager suggests turning pickup on.</p>
        ) : null}
        {form.pickupEnabled ? (
          <>
            {boards.map((board) => (
              <fieldset key={board.boardId} className="space-y-1.5">
                <legend className="text-xs">Ready columns on {board.title}</legend>
                {board.readyColumns.map((column) => {
                  const ref = { boardId: board.boardId, columnId: column.id };
                  return (
                    <Label key={column.id}>
                      <Checkbox
                        checked={form.columns.some((entry) => sameColumn(entry, ref))}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          setForm(toggleColumn(form, ref, checked === true))
                        }
                      />
                      {column.title}
                    </Label>
                  );
                })}
              </fieldset>
            ))}
            <Textarea
              aria-label="Pickup guidance"
              size="sm"
              rows={2}
              disabled={readOnly}
              value={form.guidance}
              onChange={(event) => setForm({ ...form, guidance: event.target.value })}
            />
          </>
        ) : null}
      </Section>

      {proposal.rules.length === 0 ? null : (
        <Section title="Questions">
          {proposal.rules.map((rule) => {
            const answer = form.answers[rule.id] ?? { choice: OTHER_ANSWER, other: "" };
            const setAnswer = (next: typeof answer) =>
              setForm({ ...form, answers: { ...form.answers, [rule.id]: next } });
            const labelId = `factory-onboarding-${rule.id}`;
            return (
              <div key={rule.id} className="space-y-1.5">
                <p id={labelId}>{rule.question}</p>
                {rule.reason === "" ? null : (
                  <p className="text-xs text-muted-foreground">{rule.reason}</p>
                )}
                <RadioGroup
                  aria-labelledby={labelId}
                  disabled={readOnly}
                  value={String(answer.choice)}
                  onValueChange={(value) =>
                    setAnswer({
                      ...answer,
                      choice: value === OTHER_ANSWER ? OTHER_ANSWER : Number(value),
                    })
                  }
                >
                  {rule.options.map((option, index) => (
                    <Label key={`${index}:${option}`}>
                      <Radio value={String(index)} />
                      {index === rule.recommended ? `${option} (recommended)` : option}
                    </Label>
                  ))}
                  <Label>
                    <Radio value={OTHER_ANSWER} />
                    Other
                  </Label>
                </RadioGroup>
                {answer.choice === OTHER_ANSWER ? (
                  <Input
                    aria-label={`Other answer: ${rule.question}`}
                    size="sm"
                    disabled={readOnly}
                    value={answer.other}
                    onChange={(event) => setAnswer({ ...answer, other: event.target.value })}
                  />
                ) : null}
              </div>
            );
          })}
        </Section>
      )}

      <Section title="Protected paths">
        {form.controlPaths.map((entry, index) => (
          <div key={`${index}:${entry.path}`} className="space-y-0.5">
            <Label>
              <Checkbox
                checked={entry.kept}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  setForm({
                    ...form,
                    controlPaths: form.controlPaths.map((current, at) =>
                      at === index ? { ...current, kept: checked === true } : current,
                    ),
                  })
                }
              />
              <code className="break-all">{entry.path}</code>
            </Label>
            {entry.reason === "" ? null : (
              <p className="ps-6 text-xs text-muted-foreground">{entry.reason}</p>
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            aria-label="Add a protected path"
            size="sm"
            placeholder="Add a path, such as docs/**"
            disabled={readOnly}
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addPath();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || newPath.trim() === ""}
            onClick={addPath}
          >
            Add
          </Button>
        </div>
      </Section>

      {proposal.findings.length === 0 ? null : (
        <Section title="Findings">
          <ul className="space-y-1.5">
            {proposal.findings.map((finding, index) => (
              <li key={`${index}:${finding}`} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">{finding}</span>
                {send ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || asked.has(index)}
                    onClick={() => draftTicket(index, finding)}
                  >
                    {asked.has(index) ? "Asked" : "Draft ticket"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {send ? (
        <Section title="Send back">
          <Textarea
            aria-label="Send back to the manager"
            size="sm"
            rows={2}
            placeholder="What should the manager change?"
            disabled={busy}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || note.trim() === ""}
            onClick={sendBack}
          >
            Send back
          </Button>
        </Section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={readOnly || blocker !== null} onClick={approve}>
          Approve
        </Button>
        {canApprove ? null : (
          <p className="text-xs text-muted-foreground">You can't approve onboarding here.</p>
        )}
        {canApprove && blocker !== null ? (
          <p className="text-xs text-muted-foreground">{blocker}</p>
        ) : null}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
