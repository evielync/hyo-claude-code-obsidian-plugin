import { useEffect, useRef, useState } from "react";
import { readState } from "../read-state";

let nextView = 1;

/** The unread conversation ids on this Mac (empty where there's no tracker: mobile). */
export function useUnread(cwd: string): ReadonlySet<string> {
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set(readState(cwd)?.list() || []));
  useEffect(() => {
    const rs = readState(cwd);
    if (!rs) return;
    setUnread(new Set(rs.list()));
    return rs.subscribe((u) => setUnread(u));
  }, [cwd]);
  return unread;
}

/**
 * Tell the tracker which conversation this view has on screen (null: none,
 * or the view itself isn't showing). Whatever it shows is read.
 */
export function useReportViewing(cwd: string, sessionId: string | null): void {
  const viewId = useRef(`view-${nextView++}`).current;
  useEffect(() => {
    readState(cwd)?.setViewing(viewId, sessionId);
  }, [cwd, viewId, sessionId]);
  useEffect(() => () => readState(cwd)?.forget(viewId), [cwd, viewId]);
}

/**
 * Whether a panel can be seen, kept up to date as the layout changes (a
 * sidebar collapses, another view takes the tab) and as the window hides.
 */
export function usePanelShown(app: { workspace: any }, isShown?: () => boolean): boolean {
  const [shown, setShown] = useState(() => (isShown ? isShown() : true));
  useEffect(() => {
    if (!isShown) return;
    const check = () => setShown(isShown());
    const refs = [app.workspace.on("layout-change", check), app.workspace.on("active-leaf-change", check)];
    document.addEventListener("visibilitychange", check);
    // Some changes fire no event (dragging a sidebar shut); check now and then too.
    const timer = window.setInterval(check, 1500);
    check();
    return () => {
      for (const r of refs) app.workspace.offref(r);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [app, isShown]);
  return shown;
}
