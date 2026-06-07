// ─────────────────────────────────────────────────────────────────────────────
// aiClient.ts — Cliente del Asistente de IA de mantenimiento (FRONTEND).
//
// SEGURIDAD: este archivo NO contiene ni referencia GEMINI_API_KEY. El frontend
// SÓLO hace POST del snapshot SCADA a un endpoint backend (SCADA_AI_ENDPOINT);
// es el backend quien tiene la key (env var) y llama a Gemini. Si el backend no
// existe o falla, se cae a un MOCK local (heurístico, sin red, sin key) para
// poder probar la UI. El resultado siempre indica `source: 'GEMINI' | 'MOCK'`.
// ─────────────────────────────────────────────────────────────────────────────

import { SCADA_AI_ENDPOINT } from './scadaConfig';
import type { AiDiagnosis, ScadaSnapshot, Severity } from './scadaTypes';

// Construye el payload mínimo que la IA necesita (CAMBIO 10/13). No manda toda la
// escena: sólo señales relevantes para diagnóstico.
export function buildAiContext(s: ScadaSnapshot): Record<string, unknown> {
  return {
    plantState: s.overview.plantState,
    stage: s.overview.stage,
    activeFaults: s.overview.activeFaults,
    alarms: s.alarms.filter((a) => a.active).map((a) => ({ code: a.code, severity: a.severity, station: a.station, message: a.message, durationS: Math.round(a.durationS) })),
    conveyor: { dutyCycle5minPct: s.conveyor.dutyCycle5minPct, runningTimeCurrentCycleS: s.conveyor.runningTimeCurrentCycleS, motorTempC: s.conveyor.motorTempC, motorTempSource: s.conveyor.motorTempSource },
    turntable: { indexCount: s.turntable.indexCount, homeHitCount: s.turntable.homeHitCount, workHitCount: s.turntable.workHitCount, lastMoveDurationS: s.turntable.lastMoveDurationS, nominalMoveDurationS: s.turntable.nominalMoveDurationS, cyclesSinceMaintenance: s.turntable.cyclesSinceMaintenance },
    gripper: { airPressureBar: s.gripper.airPressureBar, pressureSource: s.gripper.pressureSource, faultCount: s.gripper.faultCount, cycleCount: s.gripper.cycleCount },
    sensors: s.sensors.map((x) => ({ name: x.name, blockedTimeS: x.blockedTimeS })),
    camera: { avgInspectionTimeMs: s.camera.avgInspectionTimeMs, failRatePct: s.quality.rejectRatePct, commStatus: s.camera.commStatus },
    cobot: { controllerTempC: s.cobot.controllerTempC, joints: s.cobot.joints.map((j) => ({ i: j.index, tempC: j.tempC, currentA: j.currentA })), tcpPositionErrorMm: s.cobot.tcp.positionErrorMm, ftForceN: [s.cobot.ft.fxN, s.cobot.ft.fyN, s.cobot.ft.fzN] },
  };
}

export async function requestAiDiagnosis(s: ScadaSnapshot): Promise<AiDiagnosis> {
  const context = buildAiContext(s);
  try {
    const res = await fetch(SCADA_AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
      // corta rápido si no hay backend (no colgar la UI)
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(6000) : undefined,
    });
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const data = (await res.json()) as Partial<AiDiagnosis>;
    return { ...emptyDiag(), ...data, source: 'GEMINI' } as AiDiagnosis;
  } catch {
    // Sin backend / sin key / sin red → mock heurístico local seguro.
    return localMockDiagnosis(s);
  }
}

function emptyDiag(): AiDiagnosis {
  return { source: 'MOCK', probableFault: '', severity: 'INFO', suspectComponent: '', recommendedAction: '', maintenanceMessage: '', checklist: [], canKeepOperating: true, evidence: [] };
}

// Heurística local (no IA): escoge la alarma más severa y arma un diagnóstico
// coherente. Sirve de fallback y para probar la UI sin backend.
export function localMockDiagnosis(s: ScadaSnapshot): AiDiagnosis {
  const active = s.alarms.filter((a) => a.active);
  const top = active.sort((a, b) => rank(b.severity) - rank(a.severity))[0];
  const evidence: string[] = active.slice(0, 5).map((a) => `${a.severity} · ${a.station}: ${a.message}`);

  if (!top) {
    return {
      source: 'MOCK',
      probableFault: 'Sin fallas activas. Operación nominal.',
      severity: 'INFO',
      suspectComponent: '—',
      recommendedAction: 'Continuar operación. Monitoreo rutinario.',
      maintenanceMessage: msg('INFO', 'Celda', 'Operación nominal', ['Sin alarmas activas'], 'Sin acción requerida'),
      checklist: ['Verificar tendencias de duty cycle', 'Confirmar temperaturas de joints estables'],
      canKeepOperating: true,
      evidence: ['Sin alarmas activas', `Duty conveyor 5min ${s.conveyor.dutyCycle5minPct}%`, `Joint max temp ${Math.max(...s.cobot.joints.map((j) => j.tempC))}°C`],
    };
  }

  let suspect = top.station;
  let action = 'Revisar el componente indicado y reconocer la alarma tras corregir.';
  let checklist = ['Inspección visual del componente', 'Verificar conexiones/sensores', 'Reconocer alarma tras corregir'];

  if (top.code.startsWith('CNV')) {
    suspect = 'Motor / banda del conveyor';
    action = 'Reducir uso continuo. Detener 10–15 min para enfriar y verificar fricción de la banda.';
    checklist = ['Medir/observar temperatura del motor', 'Revisar tensión y fricción de la banda', 'Verificar rodamientos', 'Confirmar que no hay CAFI atorado'];
  } else if (top.code.startsWith('TT_')) {
    suspect = 'Mesa rotatoria NEMA / limit switches';
    action = 'Verificar limit switches y apriete de la base. Revisar tiempo de giro.';
    checklist = ['Probar limit switch HOME y WORK', 'Revisar apriete de base y tornillería', 'Comparar tiempo de giro vs nominal', `Ciclos desde mant.: ${s.turntable.cyclesSinceMaintenance}`];
  } else if (top.code.startsWith('GRP') || top.code.includes('PRESS')) {
    suspect = 'Gripper neumático / suministro de aire';
    action = 'Verificar presión de aire (6 bar nominal) y el pistón. Revisar fugas.';
    checklist = ['Confirmar presión de línea ≥ 5.5 bar', 'Revisar fugas en mangueras/racores', 'Verificar pistón y carrera (2.5 cm)', 'Revisar válvula de control'];
  } else if (top.code.startsWith('CAM')) {
    suspect = 'Cámara Datalogic / comunicación';
    action = 'Verificar comunicación de la cámara y tiempos de inspección.';
    checklist = ['Ping/heartbeat de la cámara', 'Revisar iluminación y enfoque', 'Comparar tiempo de inspección vs promedio', 'Revisar almacenamiento de imágenes'];
  } else if (top.code.startsWith('J') && top.code.includes('TEMP')) {
    suspect = 'Articulación del cobot (sobre-temperatura)';
    action = top.severity === 'CRITICAL' ? 'DETENER el cobot: temperatura crítica de articulación.' : 'Reducir velocidad/carga y vigilar la temperatura de la articulación.';
    checklist = ['Verificar ventilación del controlador', 'Reducir speed magnification', 'Revisar carga/fricción de la articulación', 'Dejar enfriar si supera 60°C'];
  } else if (top.code.startsWith('EE_FORCE') || top.code.startsWith('TCP')) {
    suspect = 'TCP / fuerza end-effector';
    action = 'Revisar colisión/obstrucción y recalibrar TCP si el error persiste.';
    checklist = ['Buscar obstrucción en la trayectoria', 'Verificar montaje del gripper', 'Revisar error de posición TCP', 'Recalibrar si > umbral'];
  }

  const canKeep = top.severity !== 'CRITICAL' && top.code !== 'GRP_CLOSE_NOPRESS';
  const symptoms = active.slice(0, 4).map((a) => a.message);

  return {
    source: 'MOCK',
    probableFault: top.message,
    severity: top.severity,
    suspectComponent: suspect,
    recommendedAction: action,
    maintenanceMessage: msg(top.severity, top.station, top.message, symptoms, action),
    checklist,
    canKeepOperating: canKeep,
    evidence,
  };
}

export function msg(sev: Severity, component: string, symptom: string, symptoms: string[], recommendation: string): string {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `[${stamp}] Alerta ${sev}: ${component}`,
    `Síntoma: ${symptom}`,
    symptoms.length > 1 ? `Otros: ${symptoms.slice(1).join(' · ')}` : '',
    `Recomendación: ${recommendation}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function rank(s: Severity): number { return s === 'CRITICAL' ? 3 : s === 'ALARM' ? 2 : s === 'WARNING' ? 1 : 0; }
