import type { Brand } from "./types";

// The ONLY place the default product name appears in source code.
// At runtime the name, logo, icon and colour come from brand_config,
// which a platform administrator edits in Settings → Product branding.
export const DEFAULT_BRAND: Brand = {
  product_name: "Shopwise",
  tagline: "Sell smarter. Know your numbers.",
  logo_url: null,
  icon_url: null,
  primary_color: "#3158C9",
  support_email: null,
  support_phone: null,
};
