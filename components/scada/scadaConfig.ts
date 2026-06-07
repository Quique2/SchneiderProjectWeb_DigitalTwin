// ─────────────────────────────────────────────────────────────────────────────
// scadaConfig.ts — Umbrales y constantes centrales del módulo SCADA.
//
// TODO el tuning de alarmas vive aquí (CAMBIO 14). Cambiar un número aquí ajusta
// el comportamiento de las alarmas en todo el dashboard, la IA y los mensajes.
// NO contiene secretos: la API key de Gemini vive SÓLO en el backend (env var).
// ─────────────────────────────────────────────────────────────────────────────

export const SCADA_THRESHOLDS = {
  // Conveyor (motor se calienta con uso continuo)
  conveyorMaxOnTimeWarningS: 30,
  conveyorMaxOnTimeAlarmS: 60,
  conveyorDutyWarningPct: 60,
  conveyorDutyAlarmPct: 80,
  conveyorSensorBlockedAlarmS: 8,   // sensor de banda bloqueado demasiado tiempo
  conveyorCafiStuckAlarmS: 20,      // CAFI atorado en la banda

  // Mesa rotatoria / NEMA
  turntableMoveTimeoutS: 8,
  turntableTimeDriftWarningPct: 20, // tiempo de giro sube >20%
  turntableHitsWarningCount: 20000, // demasiados golpes acumulados (warning)
  turntableCycleMaintenance: 5000,  // revisar base
  turntableTorqueMaintenance: 10000,// revisar apriete
  limitSwitchMaintenance: 25000,    // revisar limit switches

  // Gripper neumático (6 bar, doble carrera, 2.5 cm)
  pressureMinWarningBar: 5.5,
  pressureMinAlarmBar: 5.0,
  pressureMaxWarningBar: 6.5,
  pressureNominalBar: 6.0,          // presión CONFIGURADA (no medida) por defecto
  gripperOpenTimeoutMs: 1200,
  gripperCloseTimeoutMs: 1200,

  // Sensores fotoeléctricos
  sensorBlockedAlarmS: 8,
  sensorDebounceMinMs: 50,
  sensorDebounceMaxMs: 150,

  // Cámara Datalogic
  cameraInspectionTimeoutS: 3,
  cameraFailRateWarningPct: 20,
  cameraTimeDriftWarningPct: 20,
  cameraStorageWarningMb: 4096,     // almacenamiento alto si se guardan imágenes

  // Cobot
  jointTempWarningC: 50,
  jointTempAlarmC: 60,
  jointTempCriticalC: 70,
  speedMagTestWarningPct: 30,
  tcpPositionWarningMm: 10,
  tcpPositionAlarmMm: 25,
  tcpOrientationWarningDeg: 5,
  eeForceWarningN: 20,
  eeForceAlarmN: 40,

  // Fixtures
  fixtureDebounceMinMs: 50,
  fixtureDebounceMaxMs: 150,
} as const;

export type ScadaThresholds = typeof SCADA_THRESHOLDS;

// Endpoint del asistente de IA (backend con GEMINI_API_KEY). El frontend NUNCA
// ve la key: sólo hace POST aquí. Si el backend no existe, aiClient cae a un
// mock local seguro (sin red, sin key). Override con EXPO_PUBLIC_SCADA_AI_URL.
export const SCADA_AI_ENDPOINT =
  (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_SCADA_AI_URL)
    ? String(process.env.EXPO_PUBLIC_SCADA_AI_URL)
    : '/api/scada/ai-diagnose';
