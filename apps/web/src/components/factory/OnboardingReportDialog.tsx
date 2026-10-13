import type { FactoryOnboardingReport } from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function OnboardingReportDialog({
  report,
  onClose,
}: {
  readonly report: FactoryOnboardingReport;
  readonly onClose: () => void;
}) {
  const sections = [
    { title: "Project instructions", findings: report.instructions },
    { title: "Required checks", findings: report.checks },
    { title: "Issue workflow", findings: [report.tracker] },
    { title: "Verification tools", findings: report.verificationTools },
    { title: "Protected controls", findings: report.protectedControls },
    { title: "Decisions for you", findings: report.unresolvedDecisions },
  ];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Project onboarding report</DialogTitle>
          <DialogDescription>{report.summary}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {sections.map((section) => (
            <section key={section.title} className="space-y-2">
              <h3 className="text-sm font-medium">{section.title}</h3>
              {section.findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="space-y-3">
                  {section.findings.map((finding) => (
                    <li key={finding.description} className="space-y-1 text-sm">
                      <p>{finding.description}</p>
                      {finding.evidence.map((evidence) => (
                        <p
                          key={`${evidence.location}:${evidence.label}`}
                          className="break-words text-xs text-muted-foreground"
                        >
                          {evidence.label} · {evidence.location}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
