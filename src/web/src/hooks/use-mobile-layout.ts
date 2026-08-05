import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Mobile OCD is a separate interaction surface, not a squeezed desktop view.
 * Keep the media query in one place so components can render purpose-built
 * phone markup while CSS remains responsible for visual polish only.
 */
export function useMobileLayout() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}
