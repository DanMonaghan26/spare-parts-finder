"use client";

import type Anthropic from "@anthropic-ai/sdk";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { RepairCase } from "@/lib/case";
import { CasePanel } from "./CasePanel";
import { Markdown } from "./Markdown";

type ApiMessage = Anthropic.Beta.BetaMessageParam;
type Photo = { dataUrl: string; mediaType: "image/jpeg"; base64: string };
type Bubble = { role: "user" | "assistant"; text: string; photos?: string[]; error?: boolean };

type ServerEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "case"; case: RepairCase }
  | { type: "done"; messages: ApiMessage[] }
  | { type: "error"; message: string };

const STARTERS = [
  "My washing machine won't drain and there's water left in the drum",
  "The fan in my oven is making a loud grinding noise",
  "Water is pooling under my fridge",
  "My dishwasher isn't drying the dishes properly",
];

const MAX_PHOTO_EDGE = 1568;

async function resizePhoto(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { dataUrl, mediaType: "image/jpeg", base64: dataUrl.split(",")[1] };
}

function isEsparesUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)espares\.co\.uk$/.test(url.hostname);
  } catch {
    return false;
  }
}

// Claude sends only the fields that changed; links must point at eSpares.
function mergeCase(prev: RepairCase, update: RepairCase): RepairCase {
  const next = { ...prev, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) };
  if (next.modelPageUrl && !isEsparesUrl(next.modelPageUrl)) delete next.modelPageUrl;
  if (next.recommendedParts) next.recommendedParts = next.recommendedParts.filter((p) => isEsparesUrl(p.url));
  return next;
}

export function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [repair, setRepair] = useState<RepairCase>({});
  const [input, setInput] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, status]);

  async function send(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && photos.length === 0) || busy) return;

    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...photos.map((p) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: p.mediaType, data: p.base64 },
      })),
      { type: "text", text: trimmed || "Here's a photo of the rating plate." },
    ];
    const outgoing: ApiMessage[] = [...history, { role: "user", content }];

    setBubbles((b) => [
      ...b,
      { role: "user", text: trimmed, photos: photos.map((p) => p.dataUrl) },
      { role: "assistant", text: "" },
    ]);
    setInput("");
    setPhotos([]);
    setBusy(true);
    setStatus("Thinking…");

    const appendToReply = (update: (bubble: Bubble) => Bubble) =>
      setBubbles((b) => [...b.slice(0, -1), update(b[b.length - 1])]);

    let finished = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: outgoing }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ServerEvent;
          switch (event.type) {
            case "text":
              setStatus(null);
              appendToReply((m) => ({ ...m, text: m.text + event.text }));
              break;
            case "status":
              setStatus(event.text);
              break;
            case "case":
              setRepair((prev) => mergeCase(prev, event.case));
              break;
            case "done":
              setHistory(event.messages);
              finished = true;
              break;
            case "error":
              throw new Error(event.message);
          }
        }
      }
      if (!finished) throw new Error("The connection dropped before the reply finished.");
    } catch (err) {
      appendToReply((m) => ({
        ...m,
        text: (m.text.trim() ? m.text.trim() + "\n\n" : "") + (err as Error).message,
        error: true,
      }));
      // Keep what the person asked so they can retry, but don't commit the failed turn.
      setInput(trimmed);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  async function onPickPhotos(files: FileList | null) {
    if (!files) return;
    const picked = await Promise.all([...files].slice(0, 3).map(resizePhoto));
    setPhotos((p) => [...p, ...picked].slice(0, 3));
    if (fileRef.current) fileRef.current.value = "";
  }

  function reset() {
    setBubbles([]);
    setHistory([]);
    setRepair({});
    setInput("");
    setPhotos([]);
  }

  const summary = [repair.brand, repair.applianceType, repair.modelNumber].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto flex h-dvh w-full max-w-6xl flex-col lg:flex-row lg:gap-6 lg:p-6">
      <main className="flex min-h-0 flex-1 flex-col bg-white lg:rounded-2xl lg:border lg:border-zinc-200 lg:shadow-sm dark:bg-zinc-950 lg:dark:border-zinc-800">
        <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-lg text-white">🔧</span>
            <div>
              <h1 className="text-base font-semibold leading-tight">Spare Parts Finder</h1>
              <p className="hidden text-xs text-zinc-500 sm:block">Find the right part for your appliance</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPanel((s) => !s)}
              className="whitespace-nowrap rounded-lg border border-zinc-200 px-3 py-1.5 text-sm lg:hidden dark:border-zinc-700"
            >
              {showPanel ? "Hide" : "Summary"}
            </button>
            {bubbles.length > 0 && (
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                New search
              </button>
            )}
          </div>
        </header>

        {showPanel && (
          <div className="max-h-[50dvh] overflow-y-auto border-b border-zinc-200 p-4 lg:hidden dark:border-zinc-800">
            <CasePanel repair={repair} />
          </div>
        )}
        {!showPanel && summary && (
          <button
            type="button"
            onClick={() => setShowPanel(true)}
            className="border-b border-zinc-200 bg-teal-50 px-4 py-2 text-left text-sm text-teal-900 lg:hidden dark:border-zinc-800 dark:bg-teal-950/40 dark:text-teal-200"
          >
            {summary}
            {repair.modelConfirmed ? " ✓" : ""}
          </button>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-6">
          {bubbles.length === 0 ? (
            <div className="mx-auto max-w-xl pt-6 text-center">
              <h2 className="text-2xl font-semibold">What&apos;s wrong with your appliance?</h2>
              <p className="mt-2 text-zinc-500">
                Describe the problem in your own words. We&apos;ll work out the likely fault, find your exact model, and
                point you to the right part on eSpares.
              </p>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-xl border border-zinc-200 px-4 py-3 text-left text-sm hover:border-teal-500 hover:bg-teal-50 dark:border-zinc-800 dark:hover:bg-teal-950/30"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-4">
              {bubbles.map((b, i) =>
                b.role === "user" ? (
                  <div key={i} className="flex flex-col items-end gap-2">
                    {b.photos && b.photos.length > 0 && (
                      <div className="flex gap-2">
                        {b.photos.map((src, j) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={j} src={src} alt="Uploaded photo" className="h-24 w-24 rounded-xl object-cover" />
                        ))}
                      </div>
                    )}
                    {b.text && (
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-teal-600 px-4 py-2.5 text-white">
                        {b.text}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`max-w-[92%] rounded-2xl rounded-bl-sm px-4 py-3 ${
                      b.error
                        ? "bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                        : "bg-zinc-100 dark:bg-zinc-900"
                    } ${!b.text.trim() ? "hidden" : ""}`}
                  >
                    <Markdown text={b.text.trim()} />
                  </div>
                ),
              )}
              {status && (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-teal-500" />
                  {status}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <form onSubmit={onSubmit} className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          {photos.length > 0 && (
            <div className="mb-2 flex gap-2">
              {photos.map((p, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.dataUrl} alt="Photo to send" className="h-16 w-16 rounded-lg object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-xs text-white"
                    aria-label="Remove photo"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onPickPhotos(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Add a photo of the rating plate"
              aria-label="Add a photo"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-lg hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              📷
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={bubbles.length ? "Reply, or add a photo of the rating plate…" : "e.g. My Bosch washing machine is leaking from the door"}
              className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-zinc-200 bg-transparent px-3 py-2.5 outline-none focus:border-teal-500 dark:border-zinc-700"
            />
            <button
              type="submit"
              disabled={busy || (!input.trim() && photos.length === 0)}
              className="h-11 shrink-0 rounded-xl bg-teal-600 px-4 font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </main>

      <aside className="hidden w-80 shrink-0 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm lg:block dark:border-zinc-800 dark:bg-zinc-950">
        <CasePanel repair={repair} />
      </aside>
    </div>
  );
}
