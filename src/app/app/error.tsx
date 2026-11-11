"use client";
import { CrashScreen } from "@/components/crash-screen";
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) { return <CrashScreen {...props} />; }
