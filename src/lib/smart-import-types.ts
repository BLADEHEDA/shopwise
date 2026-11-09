export interface SmartProduct {
  name: string; category: string | null; variant: string | null; brand: string | null;
  cost_price: number | null; quantity: number | null; line_total: number | null;
  selling_price: number | null; min_price: number | null; uncertain: string | null;
}
export interface SmartResult { products: SmartProduct[]; skipped: string[]; currency: string | null; notes: string | null; truncated: boolean }
