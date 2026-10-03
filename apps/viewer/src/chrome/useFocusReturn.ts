import { useEffect, useState } from "react";

/**
 * Focus returns to whatever had it when the component first rendered, once it
 * unmounts. The opener is read while rendering: by the time any effect runs, a
 * child's `autoFocus` has already moved focus into the dialog.
 */
export function useFocusReturn(): void {
  const [opener] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    [opener],
  );
}
