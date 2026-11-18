// Links a composer's `+` menu row to the Snippets page and back.
//
// The `+` row's `run` gets a composer handle but no navigation, and the page
// is a separate route where that composer is not on screen. So the row records
// the composer as the target, and a bare composer banner (`ComposerBridge`,
// mounted inside every composer) does the two things that need hooks there:
// it opens the picker page for the composer that asked, and it appends a
// snippet the page queued for it once that composer is back on screen.
import { useEffect, useSyncExternalStore } from "react";
import { useBbNavigate, useComposer, type PluginComposerApi, type PluginComposerScope } from "@get-bb/plugin-sdk/app";
import { appendParagraph } from "../compose.js";

export interface ComposerTarget {
  /** `PluginComposerApi.key`: stable for a thread's or the new-thread composer across remounts. */
  key: string;
  scope: PluginComposerScope;
}

interface BridgeState {
  /** The composer the picker writes into. */
  target: ComposerTarget | null;
  /** A `+` row click waiting for that composer's bridge to open the page. */
  openRequest: string | null;
  /** Text waiting for the target composer to be on screen again. */
  pending: { key: string; text: string } | null;
}

let state: BridgeState = { target: null, openRequest: null, pending: null };
const listeners = new Set<() => void>();

function set(next: Partial<BridgeState>): void {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export const bridge = {
  get: (): BridgeState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** From the `+` row: remember this composer and ask its bridge to open the picker. */
  requestPicker(composer: Pick<PluginComposerApi, "key" | "scope">): void {
    set({ target: { key: composer.key, scope: composer.scope }, openRequest: composer.key });
  },
  setTarget(target: ComposerTarget | null): void {
    set({ target });
  },
  queueInsert(key: string, text: string): void {
    set({ pending: { key, text } });
  },
  /** Test hook. */
  reset(): void {
    set({ target: null, openRequest: null, pending: null });
  },
};

export function useBridge(): BridgeState {
  return useSyncExternalStore(bridge.subscribe, bridge.get, bridge.get);
}

// Host v152 (plugin SDK 0.6.51) gives the composer handle `setText` and
// `updateText` and no `insert`: the live spike on 2026-11-13 got
// "e.insert is not a function", while `updateText` appended text. The 0.6.49
// types in this repo list `insert` and omit `updateText`, so cast here.
type LegacyComposerWrites = { updateText(updater: (current: string) => string): void };

/** Append `text` as its own paragraph at the end of the draft. Never submits. */
export function appendToComposer(composer: PluginComposerApi, text: string): void {
  (composer as unknown as LegacyComposerWrites).updateText((current) => appendParagraph(current, text));
  composer.focus();
}

/** A bare composer banner that renders nothing. */
export function ComposerBridge(): null {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const { openRequest, pending } = useBridge();
  const key = composer.key;

  useEffect(() => {
    if (openRequest !== key) return;
    set({ openRequest: null });
    navigate.toPluginPanel("snippets", { subPath: "pick" });
  }, [openRequest, key, navigate]);

  useEffect(() => {
    if (!pending || pending.key !== key) return;
    set({ pending: null });
    appendToComposer(composer, pending.text);
  }, [pending, key, composer]);

  return null;
}
