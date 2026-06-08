// ─────────────────────────────────────────────────────────────────────────────
// scadaConfig.ts — Umbrales y endpoints del módulo SCADA.
//
// Todo el tuning de alarmas REALES vive aquí. NO contiene secretos: la API key de
// OpenAI vive SÓLO en el backend (env var Scada_Api_Schneider). El SCADA opera en
// modo REAL-ONLY: estos umbrales sólo se evalúan sobre datos reales (o DEMO,
// claramente marcados). Se eliminaron los umbrales de datos simulados que no
// existen en tiempo real (duty cycle, temp estimada, drift de mesa, etc.).
// ─────────────────────────────────────────────────────────────────────────────

export const SCADA_THRESHOLDS = {
  // Frescura del dato: si una fuente no actualiza en este tiempo → STALE.
  staleAfterS: 3,

  // Conveyor — advertencia por TIEMPO ENCENDIDO (sin temperatura estimada).
  // >60s = WARNING (posible sobrecalentamiento), >120s = ALARM (detener y revisar).
  conveyorOnTimeWarningS: 60,
  conveyorOnTimeAlarmS: 120,

  // Cobot — temperatura de articulación (medición real del controlador).
  jointTempWarningC: 50,
  jointTempAlarmC: 60,
  jointTempCriticalC: 70,

  // Cobot — fuerza en el end-effector (real).
  eeForceWarningN: 20,
  eeForceAlarmN: 40,

  // Gripper — presión de aire (sólo si llega un sensor real, si no CONFIGURED).
  pressureMinWarningBar: 5.5,
  pressureMinAlarmBar: 5.0,
  pressureNominalBar: 6.0,
} as const;

export type ScadaThresholds = typeof SCADA_THRESHOLDS;

// Endpoint del asistente de IA (backend con la OpenAI key). El frontend NUNCA ve
// la key: sólo hace POST aquí. Sin backend → aiClient cae a un mock local seguro.
export const SCADA_AI_ENDPOINT =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_SCADA_AI_URL)
    ? String(process.env.EXPO_PUBLIC_SCADA_AI_URL)
    : '/api/scada/ai-diagnose';

// Healthcheck del backend IA → { ok, model, keyConfigured }. Permite mostrar el
// estado "CONFIGURED" del backend de OpenAI sin exponer nada sensible.
export const SCADA_HEALTH_ENDPOINT =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_SCADA_HEALTH_URL)
    ? String(process.env.EXPO_PUBLIC_SCADA_HEALTH_URL)
    : '/api/scada/health';
