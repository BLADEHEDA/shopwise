export type Role = "owner" | "section_owner" | "manager" | "staff" | "accountant";

export interface Brand {
  product_name: string;
  tagline: string;
  logo_url: string | null;
  icon_url: string | null;
  primary_color: string;
  support_email: string | null;
  support_phone: string | null;
}

export interface Business {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  logo_url: string | null;
  accent_color: string | null;
  phone: string | null;
  address: string | null;
  receipt_footer: string | null;
  require_shift: boolean;
  is_demo?: boolean;
}

export interface Section { id: string; business_id: string; name: string; active: boolean }

export interface Membership {
  id: string;
  business_id: string;
  user_id: string;
  role: Role;
  all_sections: boolean;
  can_view_costs: boolean;
  active: boolean;
  businesses?: Business;
  section_ids?: string[];
}

export interface Profile { user_id: string; email: string | null; full_name: string | null; phone: string | null }

export interface Product {
  id: string;
  business_id: string;
  section_id: string;
  category_id: string | null;
  parent_id: string | null;
  variant_label: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  specs: Record<string, string>;
  image_url: string | null;
  target_price: number | null; // null = "Needs price" (imported with cost only)
  min_price: number | null;
  stock_qty: number;
  low_stock_threshold: number;
  active: boolean;
  categories?: { name: string } | null;
}

export interface PaymentMethod { id: string; business_id: string; name: string; kind: string; active: boolean; sort: number }

export interface Shift { id: string; business_id: string; user_id: string; started_at: string; ended_at: string | null; note: string | null }

export interface Sale {
  id: string;
  business_id: string;
  receipt_no: number;
  client_tx_id: string;
  staff_user_id: string;
  shift_id: string | null;
  no_shift: boolean;
  customer_name: string | null;
  customer_phone: string | null;
  total: number;
  amount_paid: number;
  balance_due: number;
  payment_status: "unpaid" | "partial" | "paid" | "voided" | "refunded";
  status: "completed" | "pending_review" | "voided" | "rejected";
  conflicts: string[];
  offline: boolean;
  note: string | null;
  sold_at: string;
  decision_reason: string | null;
  profiles?: { full_name: string | null; email: string | null } | null;
}

export interface SaleLine {
  id: string;
  sale_id: string;
  section_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  target_price: number;
  min_price: number;
  unit_price: number;
  line_total: number;
  override_id: string | null;
}

export interface Payment { id: string; sale_id: string; method_name: string; amount: number; reference: string | null; created_at: string }

export interface Report {
  scope: "own" | "business";
  costs_visible: boolean;
  currency: string;
  gross_revenue: number;
  sales_count: number;
  units: number;
  collected: number;
  outstanding: number;
  cogs: number | null;
  gross_profit: number | null;
  approved_expenses: number | null;
  pending_expenses: number | null;
  net_result: number | null;
  by_day: { day: string; revenue: number; sales: number; profit: number | null }[];
  by_product: { product_id: string; name: string; units: number; revenue: number; profit: number | null }[];
  by_staff: { user_id: string; name: string; sales: number; revenue: number }[];
  by_shift: { id: string; name: string; started_at: string; ended_at: string | null; sales: number; revenue: number }[];
  by_method: { method: string; amount: number }[];
  by_section: { section_id: string; name: string; revenue: number; profit: number | null }[];
}
