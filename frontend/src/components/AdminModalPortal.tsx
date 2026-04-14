import { createPortal } from 'react-dom';

/** Debe existir un `<div id="admin-modal-root" />` en App.tsx (hermano posterior al router). */
export const ADMIN_MODAL_ROOT_ID = 'admin-modal-root';

type Props = { children: React.ReactNode };

export function AdminModalPortal({ children }: Props) {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById(ADMIN_MODAL_ROOT_ID) ?? document.body;
  return createPortal(children, root);
}
