"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Spinner } from "@/components/ui";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    supabase().auth.getSession().then(({ data }) => router.replace(data.session ? "/app" : "/login"));
  }, [router]);
  return <Spinner />;
}
