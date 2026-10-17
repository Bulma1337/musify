import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

export const LYRICS_PATH = "/lyrics";

/** Open/close state of the full-screen lyrics view, which lives on its own route. */
export function useLyricsRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const open = location.pathname === LYRICS_PATH;
  // "default" = first entry of the session: there is nothing to go back to.
  const hasHistory = location.key !== "default";

  const close = useCallback(() => {
    if (hasHistory) void navigate(-1);
    else void navigate("/");
  }, [hasHistory, navigate]);

  const toggle = useCallback(() => {
    if (open) close();
    else void navigate(LYRICS_PATH);
  }, [open, close, navigate]);

  return { open, close, toggle };
}
