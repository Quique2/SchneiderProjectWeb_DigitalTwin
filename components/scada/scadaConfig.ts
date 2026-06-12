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

// ── SCADA 4.0 / AI (5 pilares) — config ADITIVA (no toca SCADA_THRESHOLDS) ──
// Todo se deriva de señales reales que el SCADA ya recibe/guarda. Tuning aquí.
export const SCADA_AI_CONFIG = {
  // Predictivo (Pilar 2) — vida nominal del actuador de remachado (ciclos).
  rivetActuatorLifeCycles: 50000,
  rulWarnPct: 25,           // RUL < 25% → WARNING
  rulCriticalPct: 8,        // RUL < 8%  → NO_PASS
  vibrationWarn: 0.6,       // proxy (σ de corrientes de joints, A) > umbral → WARNING
  vibrationCritical: 1.2,
  cycleCvWarn: 0.18,        // coef. de variación de cycleTimes > umbral → DEGRADING

  // Optimización (Pilar 3) — setpoints nominales del proceso.
  targetCobotSpeedPct: 85,
  rivetingDelayS: 30,       // remachado fijo del proceso (NO cambiar la FSM)
  inspectionTimingS: 5,

  // Anomalía (Pilar 1) — detección por baseline (z-score).
  anomalyZWarn: 2.0,        // |z| > 2 → anomalía WARNING
  anomalyZCritical: 3.0,    // |z| > 3 → anomalía fuerte
  baselineMinSamples: 5,    // mínimo de muestras para fijar baseline
} as const;

export type ScadaAiConfig = typeof SCADA_AI_CONFIG;

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
