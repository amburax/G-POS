"use client";

import { useActionState } from "react";
import { CheckCircle2 } from "lucide-react";
import { markAllSyncedAction, type RetryState } from "./actions";

const IDLE: RetryState = { status: "idle" };

export function MarkAllSyncedButton({ count }: { count: number }) {
  const [state, action, pending] = useActionState(markAllSyncedAction, IDLE);

  if (state.status === "success") {
    return (
      <span role="status" className="amb-pop-in text-xs font-semibold text-emerald-700">
        {state.message}
      </span>
    );
  }

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <button
        type="submit"
        disabled={pending || count === 0}
        aria-busy={pending}
        className="amb-focus amb-press inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-100 disabled:opacity-50"
      >
        <CheckCircle2
          aria-hidden="true"
          className={`h-3.5 w-3.5 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
        {pending ? "Marking as synced..." : `Mark all as synced (${count.toLocaleString("en-IN")})`}
      </button>
      {state.status === "error" && (
        <span role="alert" className="text-xs text-rose-700">
          {state.message}
        </span>
      )}
    </form>
  );
}
