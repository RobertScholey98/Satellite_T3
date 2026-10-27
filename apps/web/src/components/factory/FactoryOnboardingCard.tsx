import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FactoryManager,
  FactoryOnboardingProposal,
  FactoryOnboardingResult,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  HistoryIcon,
  type LucideIcon,
  PauseIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn, randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { SatelliteLoader } from "../SatelliteLoader";
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
  useFactoryEnvironmentCap,
  useFactoryManagers,
} from "./factoryState";
import { pinFactoryManagerThread, unpinFactoryThread } from "./factoryWorkspaceState";
import {
  initialOnboardingForm,
  onboardingApproveBlocker,
  onboardingResultFromForm,
  OTHER_ANSWER,
  sameColumn,
  toggleColumn,
  type OnboardingForm,
} from "./factoryOnboardingCard.logic";

/** The loader stays at least this long once it appears, so the swap never flickers past. */
const SWAP_MINIMUM_MS = 3000;

// Timeline rows unmount when they scroll away or the feed changes; answers survive until approval.
const formDrafts = new Map<
  string,
  { readonly proposedAt: string; readonly form: OnboardingForm }
>();

/**
 * Slides the transcript holding `anchor` up and off once, on the compositor. Returns the running
 * animation so it can be cancelled, or null when motion is reduced or the list isn't found.
 */
function slideTranscriptAway(viewport: HTMLElement | null, anchor: HTMLElement | null) {
  if (viewport === null || anchor === null) return null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const transcript = Array.from(viewport.children).find((child) => child.contains(anchor));
  return (
    transcript?.animate([{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }], {
      duration: 450,
      easing: "ease-in",
      fill: "forwards",
    }) ?? null
  );
}

/**
 * Stands in for a `factory_propose_onboarding` call in a manager's thread. It reads the live
 * proposal from the managers feed, not the call's arguments, and only the newest call acts.
 * Approving swaps the thread for the manager's new primed thread.
 */
export function FactoryOnboardingCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly latest: boolean;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { environmentId } = props;
  // After approval this thread is the manager's onboarding thread, no longer its current one.
  const manager = useFactoryManagers(environmentId)?.find(
    (entry) =>
      props.threadId !== null &&
      (entry.threadId === props.threadId || entry.onboardingThreadId === props.threadId),
  );
  const approveCommand = useAtomCommand(factoryEnvironment.approveOnboarding, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const router = useRouter();
  const anchor = useRef<HTMLDivElement>(null);
  const slide = useRef<Animation | null>(null);
  // Undefined until Approve; then where the loader covers the transcript, or null for in place.
  const [swapHost, setSwapHost] = useState<HTMLElement | null | undefined>(undefined);
  const [approveError, setApproveError] = useState<string | null>(null);
  // A list reused by the next thread must not keep this thread's transform.
  // oxlint-disable-next-line t3code/react-effect-budget -- Cancel the transcript slide animation on unmount so a reused list does not keep its transform.
  useEffect(() => () => slide.current?.cancel(), []);

  const undoSwap = () => {
    slide.current?.cancel();
    slide.current = null;
    setSwapHost(undefined);
  };
  const approve = async (managerId: string, result: FactoryOnboardingResult) => {
    const from = router.state.location.href;
    setApproveError(null);
    const viewport =
      anchor.current?.closest<HTMLElement>("[data-assistant-citation-viewport]") ?? null;
    setSwapHost(viewport);
    slide.current = slideTranscriptAway(viewport, anchor.current);
    const minimum = new Promise<void>((resolve) => setTimeout(resolve, SWAP_MINIMUM_MS));
    const approved = await approveCommand({
      environmentId,
      input: { requestId: randomUUID(), managerId, result },
    })
      .then(unwrapFactoryResult)
      .catch((failure: unknown) => {
        undoSwap();
        setApproveError(factoryErrorMessage(failure));
        return null;
      });
    if (approved === null) return;
    const primedThreadId = approved.threadId;
    if (primedThreadId === null) return undoSwap();
    formDrafts.delete(managerId);
    // The manager's thread stays pinned across the swap, as it was when it was created.
    void pinFactoryManagerThread(environmentId, primedThreadId);
    const onboardingThreadId = approved.onboardingThreadId ?? props.threadId;
    if (onboardingThreadId !== null) void unpinFactoryThread(environmentId, onboardingThreadId);
    await minimum;
    if (router.state.location.href !== from) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: primedThreadId },
      replace: true,
    });
  };

  const loader = (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
      <SatelliteLoader loading size={48} />
      <p className="text-sm">Cooking...</p>
    </div>
  );
  return (
    <div ref={anchor} className="relative">
      <OnboardingCardBody
        environmentId={environmentId}
        threadId={props.threadId}
        latest={props.latest}
        manager={manager}
        approveError={approveError}
        onApprove={approve}
        onSendMessage={props.onSendMessage}
      />
      {swapHost === undefined ? null : swapHost === null ? loader : createPortal(loader, swapHost)}
    </div>
  );
}

function OnboardingCardBody(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly latest: boolean;
  readonly manager: FactoryManager | undefined;
  readonly approveError: string | null;
  readonly onApprove: (managerId: string, result: FactoryOnboardingResult) => Promise<void>;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { manager } = props;
  if (!props.latest) {
    return <CollapsedLine icon={HistoryIcon}>Replaced by a later proposal below</CollapsedLine>;
  }
  // The managers feed may still be loading; the call must not vanish from the timeline meanwhile.
  if (manager === undefined) {
    return <CollapsedLine icon={ClipboardListIcon}>Onboarding proposal</CollapsedLine>;
  }
  if (manager.onboardingResult !== null) {
    return (
      <CollapsedLine icon={CircleCheckIcon} tone="success">
        Onboarding approved
        {manager.threadId === null || manager.threadId === props.threadId ? null : (
          <>
            {" · "}
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: props.environmentId, threadId: manager.threadId }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Open {manager.name}'s thread
            </Link>
          </>
        )}
      </CollapsedLine>
    );
  }
  // Paused or retired before approving: nothing here can act until it resumes onboarding.
  if (manager.state === "retired") {
    return <CollapsedLine icon={ArchiveIcon}>Manager retired</CollapsedLine>;
  }
  if (manager.state !== "onboarding") {
    return <CollapsedLine icon={PauseIcon}>Onboarding paused</CollapsedLine>;
  }
  if (manager.onboardingProposal === null) return null;
  return (
    <OnboardingProposalForm
      // A new proposal starts a fresh review.
      key={manager.onboardingProposal.proposedAt}
      environmentId={props.environmentId}
      managerId={manager.id}
      proposal={manager.onboardingProposal}
      onApprove={(result) => props.onApprove(manager.id, result)}
      approveError={props.approveError}
      onSendMessage={props.onSendMessage}
    />
  );
}

function CollapsedLine(props: {
  readonly icon: LucideIcon;
  readonly tone?: "success";
  readonly children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <p className="flex items-center gap-1.5 px-1 py-2 text-sm text-muted-foreground">
      <Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", props.tone === "success" && "text-success-foreground")}
      />
      <span className="min-w-0">{props.children}</span>
    </p>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function OnboardingProposalForm(props: {
  readonly environmentId: EnvironmentId;
  readonly managerId: string;
  readonly proposal: FactoryOnboardingProposal;
  readonly onApprove: (result: FactoryOnboardingResult) => Promise<void>;
  readonly approveError: string | null;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { environmentId, proposal } = props;
  const canApprove = useAtomValue(
    factoryEnvironment.approveOnboarding.permissionAtom(environmentId),
  );
  const [form, setForm] = useState<OnboardingForm>(() => {
    const saved = formDrafts.get(props.managerId);
    return saved?.proposedAt === proposal.proposedAt ? saved.form : initialOnboardingForm(proposal);
  });
  const updateForm = (next: OnboardingForm) => {
    formDrafts.set(props.managerId, { proposedAt: proposal.proposedAt, form: next });
    setForm(next);
  };
  // Approve waits for the real cap rather than sending a guess.
  const environmentCap = useFactoryEnvironmentCap(environmentId);
  const [newPath, setNewPath] = useState("");
  const [note, setNote] = useState("");
  const [asked, setAsked] = useState<ReadonlySet<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the review controls need the approve permission; sending into the thread does not.
  const readOnly = !canApprove || busy;
  const send = props.onSendMessage;
  const blocker =
    environmentCap === undefined
      ? "Loading the factory settings…"
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
  const approve = async () => {
    if (environmentCap === undefined) return;
    // The card above shows the outcome; a failure lands in `approveError`.
    setBusy(true);
    await props.onApprove(onboardingResultFromForm(proposal, form, environmentCap));
    setBusy(false);
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
    updateForm({ ...form, controlPaths: [...form.controlPaths, { path, reason: "", kept: true }] });
    setNewPath("");
  };

  return (
    <div className="mx-1 space-y-4 rounded-lg border bg-card p-4 text-sm">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Onboarding proposal</h2>
        {proposal.summary === "" ? null : (
          <p className="whitespace-pre-wrap text-xs/5 text-muted-foreground">{proposal.summary}</p>
        )}
      </div>

      <Section title="Purpose">
        <Textarea
          aria-label="Purpose"
          size="sm"
          rows={2}
          disabled={readOnly}
          value={form.purpose}
          onChange={(event) => updateForm({ ...form, purpose: event.target.value })}
        />
      </Section>

      <Section title="Pickup">
        <label className="flex items-start justify-between gap-4">
          <span className="flex flex-col">
            <span>Pick up tickets on its own</span>
            {pickupUnavailable !== null ? (
              <span className="text-xs text-muted-foreground">{pickupUnavailable}</span>
            ) : proposal.pickup.enabled && !form.pickupEnabled ? (
              <span className="text-xs text-muted-foreground">
                The manager suggests turning pickup on.
              </span>
            ) : null}
          </span>
          <Switch
            size="sm"
            checked={form.pickupEnabled}
            disabled={readOnly || pickupUnavailable !== null}
            onCheckedChange={(checked) => updateForm({ ...form, pickupEnabled: checked })}
          />
        </label>
        {form.pickupEnabled ? (
          <>
            {boards.map((board) => (
              <fieldset key={board.boardId} className="space-y-1.5">
                <legend className="text-xs">Ready columns on {board.title}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {board.readyColumns.map((column) => {
                    const ref = { boardId: board.boardId, columnId: column.id };
                    return (
                      <Label key={column.id}>
                        <Checkbox
                          checked={form.columns.some((entry) => sameColumn(entry, ref))}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            updateForm(toggleColumn(form, ref, checked === true))
                          }
                        />
                        {column.title}
                      </Label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <Textarea
              aria-label="Pickup guidance"
              size="sm"
              rows={2}
              disabled={readOnly}
              value={form.guidance}
              onChange={(event) => updateForm({ ...form, guidance: event.target.value })}
            />
          </>
        ) : null}
      </Section>

      {proposal.rules.length === 0 ? null : (
        <Section title="Questions">
          <div className="divide-y rounded-lg border">
            {proposal.rules.map((rule) => {
              const answer = form.answers[rule.id] ?? { choice: OTHER_ANSWER, other: "" };
              const setAnswer = (next: typeof answer) =>
                updateForm({ ...form, answers: { ...form.answers, [rule.id]: next } });
              const labelId = `factory-onboarding-${rule.id}`;
              return (
                <div key={rule.id} className="space-y-2 p-3">
                  <p id={labelId} className="font-medium">
                    {rule.question}
                  </p>
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
                      // oxlint-disable-next-line react/no-array-index-key -- An option's index is its radio value, and options never reorder.
                      <label key={index} className="flex items-center gap-2">
                        <Radio value={String(index)} />
                        {index === rule.recommended ? `${option} (recommended)` : option}
                      </label>
                    ))}
                    <label className="flex items-center gap-2">
                      <Radio value={OTHER_ANSWER} />
                      Other
                    </label>
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
          </div>
        </Section>
      )}

      <Section title="Protected paths">
        {form.controlPaths.map((entry, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- A proposal may repeat a path, and paths only append or toggle in place.
          <div key={index} className="space-y-0.5">
            <Label>
              <Checkbox
                checked={entry.kept}
                disabled={readOnly}
                onCheckedChange={(checked) =>
                  updateForm({
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
          <ul className="divide-y rounded-lg border">
            {proposal.findings.map((finding, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Findings are a read-only list that may repeat a line and never reorders.
              <li key={index} className="flex items-center gap-3 py-2 ps-3 pe-2">
                <span className="min-w-0 flex-1 font-normal">{finding}</span>
                {send ? (
                  <Button
                    size="sm"
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
        <Section title="Changes for the manager">
          <Textarea
            aria-label="Send back to the manager"
            size="sm"
            rows={2}
            placeholder="What should the manager change?"
            disabled={busy}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Section>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {canApprove ? blocker : "You can't approve onboarding here."}
        </p>
        {send ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || note.trim() === ""}
            onClick={sendBack}
          >
            Send back
          </Button>
        ) : null}
        <Button size="sm" disabled={readOnly || blocker !== null} onClick={() => void approve()}>
          Approve
        </Button>
      </div>
      {(error ?? props.approveError) === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error ?? props.approveError}
        </p>
      )}
    </div>
  );
}
