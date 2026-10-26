// Just enough of React to run one hook outside a browser, for tests that
// drive the real session managers (useSessionManager, desktop and phone).
// One "component" per mount: state slots, refs, memos and effects, with
// state updates applied in order and a re-render scheduled after them, the
// way React batches them. Not a renderer: there's no DOM.

type Effect = { deps?: any[]; cleanup?: void | (() => void); fn?: () => void | (() => void); pending: boolean };

interface Instance {
  slots: any[];
  effects: Effect[];
  idx: number;
  eidx: number;
  render: () => void;
  scheduled: boolean;
  dead: boolean;
}

let current: Instance | null = null;

const same = (a?: any[], b?: any[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

function slot<T>(init: () => T): { i: number; inst: Instance } {
  const inst = current!;
  const i = inst.idx++;
  if (!(i in inst.slots)) inst.slots[i] = init();
  return { i, inst };
}

export function useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] {
  const { i, inst } = slot(() => ({ v: typeof init === "function" ? (init as any)() : init }));
  const box = inst.slots[i];
  const set = (box.set ||= (v: any) => {
    if (inst.dead) return;
    box.v = typeof v === "function" ? v(box.v) : v;
    schedule(inst);
  });
  return [box.v, set];
}

export function useRef<T>(v: T): { current: T } {
  const { i, inst } = slot(() => ({ current: v }));
  return inst.slots[i];
}

export function useMemo<T>(fn: () => T, deps: any[]): T {
  const { i, inst } = slot(() => ({ deps: undefined as any, v: undefined as any }));
  const box = inst.slots[i];
  if (!same(box.deps, deps)) {
    box.v = fn();
    box.deps = deps;
  }
  return box.v;
}

export function useCallback<T>(fn: T, deps: any[]): T {
  return useMemo(() => fn, deps);
}

export function useEffect(fn: () => void | (() => void), deps?: any[]): void {
  const inst = current!;
  const e = inst.eidx++;
  const have = inst.effects[e];
  if (!have) inst.effects[e] = { deps, fn, pending: true };
  else if (!deps || !same(have.deps, deps)) Object.assign(have, { deps, fn, pending: true });
}

export const useLayoutEffect = useEffect;

function schedule(inst: Instance): void {
  if (inst.scheduled || inst.dead) return;
  inst.scheduled = true;
  queueMicrotask(() => {
    inst.scheduled = false;
    if (!inst.dead) inst.render();
  });
}

/** Mount a hook. `result()` is what it returned on its latest render. */
export function mountHook<P, R>(hook: (props: P) => R, props: P): { result: () => R; unmount: () => void; flush: () => Promise<void> } {
  let last: R;
  const inst: Instance = {
    slots: [],
    effects: [],
    idx: 0,
    eidx: 0,
    scheduled: false,
    dead: false,
    render: () => {
      inst.idx = 0;
      inst.eidx = 0;
      current = inst;
      try {
        last = hook(props);
      } finally {
        current = null;
      }
      for (const e of inst.effects) {
        if (!e.pending) continue;
        e.pending = false;
        if (typeof e.cleanup === "function") e.cleanup();
        e.cleanup = e.fn!();
      }
    },
  };
  inst.render();
  return {
    result: () => last,
    unmount: () => {
      inst.dead = true;
      for (const e of inst.effects) if (typeof e.cleanup === "function") e.cleanup();
    },
    flush: async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 0));
        if (!inst.scheduled) return;
      }
    },
  };
}

export default { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect };
