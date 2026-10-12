import { useCallback, useEffect, useState, type RefObject } from 'react';
import './presentation.css';

/** Keep the dashboard mounted so chart selections, query results and drafts survive. */
export function useDashboardPresentation(page: RefObject<HTMLElement | null>) {
  const [presenting, setPresenting] = useState(false);
  const enter = useCallback(() => setPresenting(true), []);
  const exit = useCallback(() => setPresenting(false), []);
  useEffect(() => {
    const element = page.current;
    if (!presenting || !element) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const siblings: Array<{ element: HTMLElement; inert: boolean }> = [];
    // Inert each branch outside the dashboard, including the app navigation.
    for (let branch: HTMLElement = element; branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
    }
    document.body.style.overflow = 'hidden';
    element.querySelector<HTMLButtonElement>('[data-presentation-exit]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (event.target instanceof Element && event.target.closest('select')) return;
        // A popup owns Escape until it has closed, even if its listener runs later.
        if (
          [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].some(
            (popup) => popup.getClientRects().length > 0,
          )
        )
          return;
        event.preventDefault();
        exit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      siblings.forEach(({ element: sibling, inert }) => {
        sibling.inert = inert;
      });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [presenting, page, exit]);
  return { presenting, enter, exit };
}
