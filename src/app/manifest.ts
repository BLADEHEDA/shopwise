import type { MetadataRoute } from "next";
import { getBrandServer } from "@/lib/brand-server";

export const revalidate = 300;

// PWA manifest — name, colour and icons follow the central brand config,
// so a rebrand (Shopwise → Vendora / StorePilot) updates the installed app.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = await getBrandServer();
  return {
    id: "/app",
    name: brand.product_name,
    short_name: brand.product_name,
    description: brand.tagline,
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: brand.primary_color,
    icons: [
      { src: "/api/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/api/icon/512?maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [{ name: "New sale", url: "/app/pos", icons: [{ src: "/api/icon/192", sizes: "192x192" }] }],
  };
}
