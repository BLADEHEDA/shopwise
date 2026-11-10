"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleHelp, TriangleAlert } from "lucide-react";
import { cx } from "@/lib/format";

/** App-styled replacements for the browser's confirm() and prompt(). */
type Tone = "default" | "danger" | "warning";
type ConfirmOpts = { title: string; message?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: Tone };
type PromptOpts = ConfirmOpts & { label?: string; placeholder?: string; required?: boolean; initial?: string };
type Req = (PromptOpts & { kind: "confirm" | "prompt"; resolve: (v: string | boolean | null) => void });

const Ctx = createContext<{ confirm: (o: ConfirmOpts) => Promise<boolean>; prompt: (o: PromptOpts) => Promise<string | null> }>({
  confirm: async () => false, prompt: async () => null,
});

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<Req | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ ...o, kind: "confirm", resolve: (v) => resolve(v === true) })), []);
  const prompt = useCallback((o: PromptOpts) => new Promise<string | null>((resolve) => setReq({ ...o, kind: "prompt", resolve: (v) => resolve(typeof v === "string" ? v : null) })), []);
  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      {req && <DialogBox req={req} onDone={(v) => { req.resolve(v); setReq(null); }} />}
    </Ctx.Provider>
  );
}

function DialogBox({ req, onDone }: { req: Req; onDone: (v: string | boolean | null) => void }) {
  const [text, setText] = useState(req.initial || "");
  const ok = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const cancel = useCallback(() => onDone(req.kind === "confirm" ? false : null), [onDone, req.kind]);
  useEffect(() => {
    (req.kind === "prompt" ? input.current : ok.current)?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [req.kind, cancel]);
  const tone = req.tone || "default";
  const Icon = tone === "danger" ? CircleAlert : tone === "warning" ? TriangleAlert : CircleHelp;
  const blocked = req.kind === "prompt" && req.required && !text.trim();
  const submit = () => { if (!blocked) onDone(req.kind === "confirm" ? true : text.trim()); };
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4" role="alertdialog" aria-modal="true" aria-label={req.title}>
      <button type="button" tabIndex={-1} className="absolute inset-0 bg-slate-900/50" aria-label="Close dialog" onClick={cancel} />
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="relative w-full rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-sm sm:rounded-3xl">
        <div className="flex gap-3">
          <span className={cx("grid size-10 shrink-0 place-items-center rounded-full",
            tone === "danger" ? "bg-red-100 text-red-600" : tone === "warning" ? "bg-amber-100 text-amber-700" : "bg-brand-50 text-brand")}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 pt-1">
            <h2 className="text-lg font-semibold leading-snug">{req.title}</h2>
            {req.message && <div className="mt-1 text-sm text-slate-600">{req.message}</div>}
          </div>
        </div>
        {req.kind === "prompt" && (
          <label className="mt-4 block text-sm font-medium text-slate-700">
            {req.label}
            <textarea ref={input} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.placeholder}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
          </label>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={cancel} className="h-12 rounded-xl border border-slate-300 bg-white font-semibold text-slate-700 hover:bg-slate-50">{req.cancelLabel || "Cancel"}</button>
          <button ref={ok} type="submit" disabled={blocked}
            className={cx("h-12 rounded-xl font-semibold text-white disabled:opacity-50",
              tone === "danger" ? "bg-red-600 hover:bg-red-700" : tone === "warning" ? "bg-amber-600 hover:bg-amber-700" : "bg-brand hover:bg-brand-700")}>
            {req.confirmLabel || "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function useDialog() { return useContext(Ctx); }
