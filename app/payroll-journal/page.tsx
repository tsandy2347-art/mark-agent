// /payroll-journal — Mark's upload front door for the deterministic MYOB →
// Craig-pattern payroll journal. Preview-only here; posting the DRAFT to Xero
// (which needs the SC/CQ keys Mark deliberately doesn't hold) is a separate step.

import { PayrollJournalClient } from "./PayrollJournalClient";

export const dynamic = "force-dynamic";

export default function PayrollJournalPage() {
  return <PayrollJournalClient />;
}
