import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The sidebar's page-specific area, as a portal slot. Layout owns the sidebar shell (position,
 * colour, API health) and renders a `SidebarSlotTarget`; each page renders its own content into
 * it with `SidebarPortal`. Why per page: the detail page's sidebar content (title, progress,
 * versions) is driven by the same queries and state as the main panel, so rendering it from the
 * page keeps that data in one place and fetches nothing twice. No library: the target element
 * is held in context state, so portals render once it has mounted.
 */
const SlotContext = createContext<{
  target: HTMLElement | null;
  setTarget: (el: HTMLElement | null) => void;
} | null>(null);

/** Provides the slot; wrap the sidebar and the routed page in it (Layout does). */
export function SidebarSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={{ target, setTarget }}>{children}</SlotContext.Provider>;
}

/** The element pages render into. The callback ref stores it in state so portals re-render. */
export function SidebarSlotTarget() {
  const slot = useContext(SlotContext);
  return <div ref={slot?.setTarget} className="app-sidebar-slot" />;
}

/** Renders its children inside the sidebar slot (nothing until the slot has mounted). */
export function SidebarPortal({ children }: { children: ReactNode }) {
  const target = useContext(SlotContext)?.target;
  return target ? createPortal(children, target) : null;
}
