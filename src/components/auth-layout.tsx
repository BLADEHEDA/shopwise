"use client";
import { BrandMark, useBrand } from "@/lib/brand";
import { isConfigured } from "@/lib/supabase";
import { Alert } from "./ui";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  const { brand } = useBrand();
  return (
    <div className="flex min-h-dvh flex-col bg-white lg:flex-row">
      <div className="hidden flex-1 flex-col justify-between bg-brand p-10 text-white lg:flex">
        <span className="text-xl font-bold">{brand.product_name}</span>
        <div>
          <p className="max-w-md text-4xl font-bold leading-tight">{brand.tagline}</p>
          <p className="mt-4 max-w-md text-brand-100">Record every sale, keep stock right automatically, and see your real profit, even when you are away from the shop.</p>
        </div>
        <p className="text-sm text-brand-100">{brand.support_email || brand.support_phone ? `Support: ${[brand.support_email, brand.support_phone].filter(Boolean).join(" · ")}` : " "}</p>
      </div>
      <div className="flex flex-1 items-start justify-center px-5 py-10 sm:items-center">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><BrandMark size={36} /></div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          {!isConfigured && (
            <Alert tone="warning" className="mt-4" title="Database not connected">
              Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your hosting environment variables.
            </Alert>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
