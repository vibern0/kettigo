// Fixed overlays must follow the visual viewport when a mobile keyboard resizes
// or pans it independently of the layout viewport.
export function fitOverlayToViewport(element: HTMLElement, viewport: VisualViewport | null) {
  if (!viewport) return () => {};

  const update = () => {
    element.style.top = `${viewport.offsetTop}px`;
    element.style.height = `${viewport.height}px`;
    element.style.bottom = "auto";
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}
