import { useCallback, type FocusEvent } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { displayDate, formatAlertDate } from './helpers';

export function DateText({ value }: { value?: string | null }) {
  const iso = displayDate(value);
  return iso ? (
    <time dateTime={iso}>{formatAlertDate(iso)}</time>
  ) : (
    <span className="muted">Never</span>
  );
}

/**
 * Browsers leave a focused control alone while any of it is inside the scroll area, even when
 * the sticky Actions column covers it, so scroll it and its focus ring clear of that column.
 */
export function revealBesideStickyColumn(event: FocusEvent<HTMLElement>) {
  const scroller = event.currentTarget;
  const cell = event.target.closest('th, td');
  const sticky = scroller.querySelector('thead th:last-child');
  if (!cell || !sticky || getComputedStyle(sticky).position !== 'sticky') return;
  if (getComputedStyle(cell).position === 'sticky') return;
  const ring = 5; // focus outline width plus offset
  const box = event.target.getBoundingClientRect();
  const covered = box.right + ring - sticky.getBoundingClientRect().left;
  const clipped = scroller.getBoundingClientRect().left - (box.left - ring);
  if (covered > 0) scroller.scrollLeft += covered;
  else if (clipped > 0) scroller.scrollLeft -= clipped;
}
export function useAlertAccess() {
  const { client, identity, mode } = useApp();
  const sources = useAsync(
    useCallback(
      async (signal) =>
        mode === 'demo' || !identity ? undefined : client.userRoleSources(identity.id, signal),
      [client, identity?.id, mode],
    ),
  );
  const privileges =
    sources.data &&
    [
      ...Object.values(sources.data.roles),
      ...Object.values(sources.data.groupRoles).flatMap(Object.values),
    ].flatMap((source) => source.actions);
  // Identity is a display hint. When role inspection is unavailable, the server authorizes each action.
  return privileges
    ? privileges.some((item) =>
        ['superadmin', 'admin', 'editor', 'writer'].includes(item.privilege),
      )
    : true;
}
