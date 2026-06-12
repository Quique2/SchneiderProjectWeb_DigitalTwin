// ─────────────────────────────────────────────────────────────────────────────
// sop.ts — Pilar 4 (Coordinator): SOP + decisión + recuperación.
// Transforma la etapa actual + el veredicto PASS/NO_PASS en instrucciones para el
// operador. REAL-ONLY: NO manda comandos; solo guía (el botón "Confirmar" registra).
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';
import type { PassNoPass } from './passNoPass';

export interface SopGuidance {
  stage: string;
  decision: 'CONTINUE' | 'HOLD' | 'STOP';
  sopSteps: string[];
  recovery: string[];
  operatorPrompt: string;
}

export function sopFor(s: ScadaSnapshot, status: PassNoPass): SopGuidance {
  const stage = s.overview.stage ?? 'Sin etapa';

  // NO_PASS → detener/retener + recuperación según la causa.
  if (status.verdict === 'NO_PASS') {
    const recovery = recoveryFor(status);
    const stop = status.reasons.some((r) => /CRÍTICA|E-stop|Colisión|protectivo|Falla prevista/i.test(r));
    return {
      stage,
      decision: stop ? 'STOP' : 'HOLD',
      sopSteps: [
        'NO PASS — no autorizar despacho de la pieza.',
        ...status.reasons.map((r) => `Causa: ${r}`),
      ],
      recovery,
      operatorPrompt: stop
        ? '¿Confirmas DETENER la celda y ejecutar la recuperación?'
        : '¿Confirmas RETENER el ciclo y aplicar la corrección indicada?',
    };
  }

  // WARNING → continuar con vigilancia.
  if (status.verdict === 'WARNING') {
    return {
      stage,
      decision: 'CONTINUE',
      sopSteps: [
        'Operación con ADVERTENCIA — continuar bajo vigilancia.',
        ...status.reasons.map((r) => `Vigilar: ${r}`),
      ],
      recovery: ['Programar revisión preventiva del componente en advertencia.'],
      operatorPrompt: '¿Confirmas continuar bajo vigilancia?',
    };
  }

  // UNKNOWN → esperar telemetría.
  if (status.verdict === 'UNKNOWN') {
    return {
      stage, decision: 'HOLD',
      sopSteps: ['Sin telemetría suficiente. Verificar enlace del gateway/cobot antes de operar.'],
      recovery: ['Confirmar WebSocket del gateway', 'Confirmar que llega telemetry.io'],
      operatorPrompt: '¿Confirmas revisión de conexión?',
    };
  }

  // PASS → continuar la secuencia.
  return {
    stage,
    decision: 'CONTINUE',
    sopSteps: [
      'PASS — CAFI correctamente posicionado.',
      `Etapa actual: ${stage}. Continuar la secuencia de remachado/inspección.`,
      'Despacho autorizado al completar el ciclo.',
    ],
    recovery: [],
    operatorPrompt: '¿Confirmas continuar la secuencia?',
  };
}

function recoveryFor(status: PassNoPass): string[] {
  const r = status.reasons.join(' ').toLowerCase();
  if (r.includes('inspección') || r.includes('fail') || r.includes('no read') || r.includes('cámara'))
    return ['Retirar la pieza al bin de rechazo.', 'Revisar enfoque/iluminación de la cámara.', 'Reintentar inspección con la siguiente pieza.'];
  if (r.includes('colocación') || r.includes('misalign'))
    return ['Reposicionar el fixture antes de reiniciar el ciclo.', 'Verificar presencia/asentamiento del CAFI.', 'Reiniciar la secuencia.'];
  if (r.includes('colisión') || r.includes('trayectoria') || r.includes('protectivo'))
    return ['Inspeccionar la zona del cobot por obstrucción.', 'Liberar paro protectivo y rearmar.', 'Verificar payload y trayectoria.'];
  if (r.includes('e-stop'))
    return ['Liberar el paro de emergencia.', 'Rearmar la cadena de seguridad.', 'Habilitar el robot según procedimiento.'];
  if (r.includes('falla prevista') || r.includes('rul') || r.includes('vibración'))
    return ['Programar mantenimiento del actuador de remachado.', 'Revisar vibración/holguras.', 'Operar a velocidad reducida hasta el servicio.'];
  return ['Inspección visual del componente.', 'Reconocer la alarma tras corregir.', 'Reiniciar la secuencia.'];
}
