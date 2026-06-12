// ─────────────────────────────────────────────────────────────────────────────
// aiClient.ts — Cliente del "Maintenance Copilot" (FRONTEND).
//
// SEGURIDAD: este archivo NO contiene ni referencia ninguna API key. El frontend
// SÓLO hace POST del contexto SCADA a SCADA_AI_ENDPOINT; el backend tiene la key
// (env var Scada_Api_Schneider) y llama a OpenAI. Sin backend → MOCK local.
//
// CAMBIO 10: el contexto enviado a la IA contiene SÓLO datos reales + una lista
// explícita de campos NO disponibles + la fuente/frescura de cada uno + si el
// snapshot proviene del modo DEMO (datos sintéticos, NO reales). La IA debe marcar
// lo faltante y NO inventar.
// ─────────────────────────────────────────────────────────────────────────────

import { SCADA_AI_ENDPOINT } from './scadaConfig';
import type { AiDiagnosis, ScadaSnapshot, Severity } from './scadaTypes';
import { derivePillars } from './ai/pillars';

export function buildAiContext(s: ScadaSnapshot): Record<string, unknown> {
  const available: Record<string, unknown> = {};
  const unavailable: string[] = [];

  // I/O: separa lo disponible de lo no conectado.
  s.io.forEach((sig) => {
    if (sig.source === 'NOT_CONNECTED' || sig.value === null) unavailable.push(`${sig.group}.${sig.key}`);
    else available[`${sig.group}.${sig.key}`] = { value: sig.value, source: sig.source, ageS: sig.ageS };
  });

  // Cobot Health: sólo si está disponible.
  let cobot: Record<string, unknown> | string = 'NOT_CONNECTED';
  if (s.cobot.available) {
    cobot = {
      source: s.cobot.source,
      controllerTempC: s.cobot.controllerTempC,
      speedMagnificationPct: s.cobot.speedMagnificationPct,
      maxJointTempC: s.cobot.maxJointTempC,
      joints: s.cobot.joints.map((j) => ({ i: j.index, tempC: j.tempC, currentA: j.currentA })),
      flags: s.cobot.flags,
      ftForceN: s.cobot.ft ? [s.cobot.ft.fxN, s.cobot.ft.fyN, s.cobot.ft.fzN] : null,
    };
  } else { unavailable.push('cobot.telemetry'); }

  const conveyor = s.conveyor.signalAvailable
    ? { motorOn: s.conveyor.motorOn, onTimeS: s.conveyor.onTimeS, warning: s.conveyor.warning, source: s.conveyor.source }
    : 'signal_not_connected';
  if (!s.conveyor.signalAvailable) unavailable.push('conveyor.conveyor_motor_on');

  // SCADA 4.0 — pilares derivados (PASS/NO PASS + predictivo + optimización + anomalía + SOP).
  // Le dan a la IA contexto "por pilar" SIN inventar: todo sale de las señales reales.
  const p = derivePillars(s);
  const scada40 = {
    passNoPass: { verdict: p.status.verdict, reasons: p.status.reasons, checks: p.status.checks },
    predictive: { status: p.predictive.status, rulPct: p.predictive.rulPct, rivetCycleCount: p.predictive.rivetCycleCount, vibrationProxy: p.predictive.vibrationProxy, cycleStability: p.predictive.cycleStability, forecast: p.predictive.forecastMsg },
    optimization: { throughputPerHr: p.optimization.throughputPerHr, idleTimePct: p.optimization.idleTimePct, energyPerCycleWh: p.optimization.energyPerCycleWh, setpoints: p.optimization.setpoints, rationale: p.optimization.rationale },
    anomaly: { status: p.anomaly.status, summary: p.anomaly.summary, anomalies: p.anomaly.anomalies, security: p.anomaly.security },
    sop: { stage: p.sop.stage, decision: p.sop.decision },
  };

  return {
    meta: {
      mode: s.mode,
      isDemoData: s.mode === 'DEMO',
      note: s.mode === 'DEMO'
        ? 'DATOS DEMO/SINTÉTICOS — NO son mediciones reales. No los uses como evidencia de una falla física.'
        : 'Datos de telemetría real. Si un campo está en "unavailable", el sensor NO está conectado: dilo, no lo inventes.',
      tsInternalS: Math.round(s.ts),
      cobotLink: s.cobotLink,
      plcLink: s.plcLink,
    },
    activeAlarms: s.alarms.filter((a) => a.active).map((a) => ({ code: a.code, severity: a.severity, station: a.station, message: a.message, durationS: Math.round(a.durationS), demo: !!a.demo })),
    available,
    unavailable,
    cobot,
    conveyor,
    scada40,
  };
}

export async function requestAiDiagnosis(s: ScadaSnapshot): Promise<AiDiagnosis> {
  const context = buildAiContext(s);
  try {
    const res = await fetch(SCADA_AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(8000) : undefined,
    });
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const data = (await res.json()) as Partial<AiDiagnosis>;
    return { ...emptyDiag(), ...data, source: 'AI' } as AiDiagnosis;
  } catch {
    return localMockDiagnosis(s);
  }
}

function emptyDiag(): AiDiagnosis {
  return { source: 'MOCK', probableFault: '', severity: 'INFO', suspectComponent: '', recommendedAction: '', maintenanceMessage: '', checklist: [], canKeepOperating: true, evidence: [] };
}

// Heurística local (sin red, sin key). Fallback y prueba de la UI sin backend.
// Respeta la regla "no inventar": sólo razona sobre alarmas/datos presentes.
export function localMockDiagnosis(s: ScadaSnapshot): AiDiagnosis {
  const isDemo = s.mode === 'DEMO';
  const active = s.alarms.filter((a) => a.active);
  const top = active.sort((a, b) => rank(b.severity) - rank(a.severity))[0];
  const evidence: string[] = active.slice(0, 5).map((a) => `${a.severity} · ${a.station}: ${a.message}${a.demo ? ' (DEMO)' : ''}`);
  const demoNote = isDemo ? ' [SNAPSHOT EN MODO DEMO — datos sintéticos, no reales]' : '';

  if (!top) {
    const ok: string[] = [];
    if (s.cobot.available && s.cobot.maxJointTempC !== null) ok.push(`Joint máx temp ${s.cobot.maxJointTempC}°C`);
    if (s.conveyor.signalAvailable) ok.push(`Conveyor on-time ${s.conveyor.onTimeS}s`);
    if (!s.overview.plcConnected) ok.push('PLC I/O no conectado (esperando telemetry.io)');
    return {
      source: 'MOCK',
      probableFault: `Sin alarmas activas.${demoNote}`,
      severity: 'INFO',
      suspectComponent: '—',
      recommendedAction: s.cobot.available ? 'Operación nominal. Monitoreo rutinario.' : 'Cobot no conectado: verificar enlace WebSocket del gateway antes de operar.',
      maintenanceMessage: msg('INFO', 'Celda', 'Sin alarmas activas', ok, 'Sin acción requerida'),
      checklist: s.maintenance.checklist.filter((c) => !c.done).map((c) => c.label),
      canKeepOperating: true,
      evidence: ok.length ? ok : ['Sin datos suficientes para evaluar (revisar conexiones)'],
    };
  }

  let suspect = top.station;
  let action = 'Revisar el componente indicado y reconocer la alarma tras corregir.';
  let checklist = ['Inspección visual del componente', 'Verificar conexiones/sensores', 'Reconocer alarma tras corregir'];

  if (top.code.startsWith('CNV')) {
    suspect = 'Motor / banda del conveyor';
    action = `Detener el conveyor para enfriar y revisar fricción de la banda (encendido ${s.conveyor.onTimeS}s continuos).`;
    checklist = ['Detener motor y dejar enfriar', 'Revisar tensión y fricción de la banda', 'Verificar rodamientos', 'Confirmar que no hay CAFI atorado'];
  } else if (top.code.startsWith('J') && top.code.includes('TEMP')) {
    suspect = 'Articulación del cobot (sobre-temperatura)';
    action = top.severity === 'CRITICAL' ? 'DETENER el cobot: temperatura crítica de articulación.' : 'Reducir velocidad/carga y vigilar la temperatura de la articulación.';
    checklist = ['Verificar ventilación del controlador', 'Reducir speed magnification', 'Revisar carga/fricción de la articulación', 'Dejar enfriar si supera 60°C'];
  } else if (top.code.startsWith('EE_FORCE')) {
    suspect = 'TCP / fuerza end-effector';
    action = 'Revisar colisión/obstrucción en la trayectoria y el montaje del gripper.';
    checklist = ['Buscar obstrucción en la trayectoria', 'Verificar montaje del gripper', 'Revisar fuerza en el end-effector'];
  } else if (top.code === 'CB_ESTOP') {
    suspect = 'Cadena de seguridad (E-stop)';
    action = 'DETENER. Liberar el paro de emergencia y rearmar según procedimiento.';
    checklist = ['Verificar botón de E-stop', 'Revisar cadena de seguridad', 'Rearmar y habilitar el robot'];
  } else if (top.code === 'CB_PSTOP' || top.code === 'CB_COLLISION') {
    suspect = 'Cobot — paro protectivo / colisión';
    action = 'Inspeccionar la zona del cobot por obstrucción o contacto antes de rearmar.';
    checklist = ['Inspeccionar obstrucciones', 'Verificar payload y trayectoria', 'Rearmar protective stop'];
  } else if (top.code === 'GRP_P_LOW_ALARM' || top.code === 'GRP_P_LOW_WARN') {
    suspect = 'Gripper neumático / suministro de aire';
    action = 'Verificar presión de aire y fugas en mangueras/racores.';
    checklist = ['Confirmar presión de línea', 'Revisar fugas', 'Verificar válvula de control'];
  } else if (top.code === 'PLC_STALE') {
    suspect = 'Enlace PLC I/O (telemetry.io)';
    action = 'El PLC dejó de actualizar. Revisar el gateway de la RPi y la conexión de red.';
    checklist = ['Verificar proceso del gateway', 'Revisar túnel/red', 'Confirmar que el gateway publica telemetry.io'];
  }

  const canKeep = top.severity !== 'CRITICAL';
  const symptoms = active.slice(0, 4).map((a) => a.message);

  return {
    source: 'MOCK',
    probableFault: `${top.message}${demoNote}`,
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
