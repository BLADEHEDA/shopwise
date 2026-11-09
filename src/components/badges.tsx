import { Badge } from "./ui";
import type { Sale } from "@/lib/types";

export function PaymentBadge({ sale }: { sale: Pick<Sale, "status" | "payment_status"> }) {
  if (sale.status === "pending_review") return <Badge tone="warning">Needs review</Badge>;
  if (sale.status === "voided") return <Badge tone="neutral">Voided</Badge>;
  if (sale.status === "rejected") return <Badge tone="neutral">Rejected</Badge>;
  if (sale.payment_status === "paid") return <Badge tone="success">Paid</Badge>;
  if (sale.payment_status === "partial") return <Badge tone="warning">Part paid</Badge>;
  return <Badge tone="danger">Unpaid</Badge>;
}
