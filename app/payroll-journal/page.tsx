// /payroll-journal — Mark's upload front door for the deterministic MYOB →
// Craig-pattern payroll journal. Preview-only here; posting the DRAFT to Xero
// (which needs the SC/CQ keys Mark deliberately doesn't hold) is a separate step.

import { PayrollJournalClient } from "./PayrollJournalClient";
import { currentUsername, isViewOnly } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function PayrollJournalPage() {
  const me = await currentUsername();
  if (isViewOnly(me)) {
    return (
      <main className="container">
        <h1>Payroll journal</h1>
        <p className="muted">
          You&apos;re on a view-only login. The payroll-journal upload posts DRAFT
          journals into Xero and is restricted to Tony. Need a pay run uploaded?
          Hand the three MYOB files to Tony and he&apos;ll process them.
        </p>
      </main>
    );
  }
  return <PayrollJournalClient />;
}
