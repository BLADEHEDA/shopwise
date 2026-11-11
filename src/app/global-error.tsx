"use client";
import "./globals.css";
import { CrashScreen } from "@/components/crash-screen";
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><CrashScreen {...props} /></body></html>;
}
