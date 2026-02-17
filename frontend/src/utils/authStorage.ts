/**
 * Toda la sesión (token, usuario, flota elegida) se guarda en una sola clave "user".
 */

const STORAGE_KEY = 'user';

export interface StoredSession {
  token: string;
  user: Record<string, unknown>;
  selectedParkId?: string;
  selectedExternalDriverId?: string;
  /** UUID de module_rapidin_drivers; enviar como driver_id en las peticiones (va enlazado con park_id en BD) */
  selectedRapidinDriverId?: string;
  selectedFlotaName?: string;
}

export function getStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredSession(session: StoredSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function updateStoredFlota(
  selectedParkId: string,
  selectedExternalDriverId: string,
  selectedFlotaName?: string
): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({
    ...session,
    selectedParkId: selectedParkId || undefined,
    selectedExternalDriverId: selectedExternalDriverId || undefined,
    selectedRapidinDriverId: session.selectedRapidinDriverId ?? undefined,
    selectedFlotaName: selectedFlotaName || undefined,
  });
}

export function getStoredFlotaName(): string | null {
  return getStoredSession()?.selectedFlotaName ?? null;
}

/** Guarda solo el nombre de la flota en sesión (ej. después de obtenerlo por API de partners). */
export function setStoredFlotaName(name: string | null | undefined): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({
    ...session,
    selectedFlotaName: name || undefined,
  });
}

export function getStoredToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function getStoredSelectedParkId(): string | null {
  return getStoredSession()?.selectedParkId ?? null;
}

export function getStoredSelectedExternalDriverId(): string | null {
  return getStoredSession()?.selectedExternalDriverId ?? null;
}

export function getStoredRapidinDriverId(): string | null {
  return getStoredSession()?.selectedRapidinDriverId ?? null;
}

export function setStoredRapidinDriverId(driverId: string | null | undefined): void {
  const session = getStoredSession();
  if (!session) return;
  setStoredSession({ ...session, selectedRapidinDriverId: driverId || undefined });
}
