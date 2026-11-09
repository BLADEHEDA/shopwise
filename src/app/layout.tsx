import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BrandProvider } from "@/lib/brand";
import { ToastProvider } from "@/components/toast";
import { ServiceWorker } from "@/components/service-worker";
import { getBrandServer } from "@/lib/brand-server";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrandServer();
  return {
    title: brand.product_name,
    description: brand.tagline,
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: brand.product_name, statusBarStyle: "default" },
    icons: {
      icon: [{ url: "/api/icon/32", sizes: "32x32", type: "image/png" }, { url: "/api/icon/192", sizes: "192x192", type: "image/png" }],
      shortcut: "/api/icon/32",
      apple: "/api/icon/180",
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const brand = await getBrandServer();
  return { themeColor: brand.primary_color, width: "device-width", initialScale: 1, viewportFit: "cover" };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <BrandProvider>
          <ToastProvider>{children}</ToastProvider>
        </BrandProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
