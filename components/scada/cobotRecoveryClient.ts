// ─────────────────────────────────────────────────────────────────────────────
// cobotRecoveryClient.ts — Acción de RECUPERACIÓN del cobot desde el SCADA.
//
// Único punto del SCADA que ENVÍA comandos (el resto es read-only). Llama a los dos
// endpoints de recuperación que el gateway YA expone (verificado en backend.py):
//   POST /api/cobot/collision_recover   → recupera de colisión
//   POST /api/cobot/clear_error         → limpia el código de error de movimiento
// Reusa el mismo host del WS de telemetría (gatewayHttpBase) + header anti-ngrok que
// usa Cobot en Vivo. Nunca lanza: devuelve un resultado estructurado para la UI.
// NO mueve el robot; solo limpia estado de falla. La UI exige confirmación.
// ─────────────────────────────────────────────────────────────────────────────

function gatewayHttpBase(connUrl: string): string {
  try {
    const u = new URL(connUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${proto}//${u.host}`;
  } catch { return ''; }
}

const HDRS = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' };

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? (AbortSignal as unknown as { timeout: (n: number) => AbortSignal }).timeout(ms)
    : undefined;
}

interface OneResult { label: string; ok: boolean; detail: string }

async function postOne(base: string, path: string, label: string): Promise<OneResult> {
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: HDRS, body: '{}', signal: timeoutSignal(7000) });
    if (res.status === 404 || res.status === 501) return { label, ok: false, detail: `no soportado (HTTP ${res.status})` };
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; errorCode?: string };
    if (!res.ok) return { label, ok: false, detail: `HTTP ${res.status}` };
    if (j.ok === false || (typeof j.error === 'string' && j.error)) return { label, ok: false, detail: String(j.error || j.errorCode || 'rechazado') };
    return { label, ok: true, detail: 'OK' };
  } catch (e) {
    return { label, ok: false, detail: `sin respuesta (${String(e)})` };
  }
}

export interface RecoverResult { ok: boolean; message: string }

// Ejecuta collision_recover + clear_error en secuencia. ok = ambos OK.
export async function recoverCollisionsAndErrors(connUrl: string): Promise<RecoverResult> {
  const base = gatewayHttpBase(connUrl);
  if (!base) return { ok: false, message: 'Sin gateway (URL de telemetría inválida).' };
  const collision = await postOne(base, '/api/cobot/collision_recover', 'Colisión');
  const error = await postOne(base, '/api/cobot/clear_error', 'Error');
  const ok = collision.ok && error.ok;
  const message = `${collision.label}: ${collision.detail} · ${error.label}: ${error.detail}`;
  return { ok, message };
}
