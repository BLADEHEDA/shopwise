"use client";
import { BizProvider } from "@/components/biz";
import { AppShell } from "@/components/app-shell";
import { Spinner } from "@/components/ui";
import { BrandMark } from "@/lib/brand";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <BizProvider fallback={<div className="grid min-h-dvh place-items-center"><div className="text-center"><BrandMark size={40} /><Spinner label="Opening your shop…" /></div></div>}>
      <AppShell>{children}</AppShell>
    </BizProvider>
  );
}
