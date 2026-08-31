type RectLike = Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width" | "height">;

export type PortalRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

const PROBE_SIZE = 100;

/**
 * Convert viewport coordinates into the CSS coordinate space used by a portal
 * mounted directly under <body>.
 *
 * CSS `zoom` scales fixed descendants, and WebKit can also shift their fixed
 * origin while the document is scrolled. A fixed probe captures both effects,
 * so the conversion remains browser-independent.
 */
export function rectInPortalSpace(anchor: RectLike, probe: RectLike): PortalRect {
  const scaleX = probe.width > 0 ? probe.width / PROBE_SIZE : 1;
  const scaleY = probe.height > 0 ? probe.height / PROBE_SIZE : 1;

  return {
    top: (anchor.top - probe.top) / scaleY,
    bottom: (anchor.bottom - probe.top) / scaleY,
    left: (anchor.left - probe.left) / scaleX,
    right: (anchor.right - probe.left) / scaleX,
    width: anchor.width / scaleX,
    height: anchor.height / scaleY,
  };
}

export function portalAnchorRect(el: Element): PortalRect {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    `width:${PROBE_SIZE}px`,
    `height:${PROBE_SIZE}px`,
    "margin:0",
    "padding:0",
    "border:0",
    "visibility:hidden",
    "pointer-events:none",
    "contain:strict",
  ].join(";");

  document.body.appendChild(probe);
  const probeRect = probe.getBoundingClientRect();
  const anchorRect = el.getBoundingClientRect();
  probe.remove();

  return rectInPortalSpace(anchorRect, probeRect);
}
