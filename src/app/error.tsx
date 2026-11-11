"use client";
import { CrashScreen } from "@/components/crash-screen";
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) { return <CrashScreen {...props} />; }
