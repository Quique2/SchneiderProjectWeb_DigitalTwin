// ─────────────────────────────────────────────────────────────────────────────
// sop.ts — Pilar 4 (Coordinator): SOP + decisión + recuperación.
// Transforma la etapa actual + el veredicto PASS/NO_PASS en instrucciones para el
// operador. REAL-ONLY: NO manda comandos; solo guía (el botón "Confirmar" registra).
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadaSnapshot } from '../scadaTypes';
import type { PassNoPass, FailCategory } from './passNoPass';
import type { ScadaLang } from '../scadaI18n';
import { tscAi } from '../scadaAiI18n';

export interface SopGuidance {
  stage: string;
  decision: 'CONTINUE' | 'HOLD' | 'STOP';
  sopSteps: string[];
  recovery: string[];
  operatorPrompt: string;
}

export function sopFor(s: ScadaSnapshot, status: PassNoPass, lang: ScadaLang = 'es'): SopGuidance {
  const stage = s.overview.stage ?? tscAi(lang, 'noStage');

  // NO_PASS → detener/retener + recuperación según la causa.
  if (status.verdict === 'NO_PASS') {
    const recovery = recoveryFor(status.failCategories, lang);
    // STOP if the failure involves safety/hardware (not just inspection or placement).
    const stop = status.failCategories.some((c) => ['estop', 'alarm', 'anomaly', 'trajectory', 'predictive'].includes(c));
    return {
      stage,
      decision: stop ? 'STOP' : 'HOLD',
      sopSteps: [
        tscAi(lang, 'sopNoPassStep'),
        ...status.reasons.map((r) => `${tscAi(lang, 'sopCause')} ${r}`),
      ],
      recovery,
      operatorPrompt: stop
        ? tscAi(lang, 'promptStop')
        : tscAi(lang, 'promptHold'),
    };
  }

  // WARNING → continuar con vigilancia.
  if (status.verdict === 'WARNING') {
    return {
      stage,
      decision: 'CONTINUE',
      sopSteps: [
        tscAi(lang, 'sopWatchContinue'),
        ...status.reasons.map((r) => `${tscAi(lang, 'sopWatch')} ${r}`),
      ],
      recovery: [tscAi(lang, 'sopScheduleReview')],
      operatorPrompt: tscAi(lang, 'promptWarning'),
    };
  }

  // UNKNOWN → esperar telemetría.
  if (status.verdict === 'UNKNOWN') {
    return {
      stage, decision: 'HOLD',
      sopSteps: [tscAi(lang, 'sopUnknownStep')],
      recovery: [tscAi(lang, 'sopRecovery1'), tscAi(lang, 'sopRecovery2')],
      operatorPrompt: tscAi(lang, 'promptUnknown'),
    };
  }

  // PASS → continuar la secuencia.
  return {
    stage,
    decision: 'CONTINUE',
    sopSteps: [
      tscAi(lang, 'sopPassStep1'),
      `${tscAi(lang, 'sopPassStep2prefix')} ${stage}. ${tscAi(lang, 'sopPassStep2suffix')}`,
      tscAi(lang, 'sopPassStep3'),
    ],
    recovery: [],
    operatorPrompt: tscAi(lang, 'promptPass'),
  };
}

function recoveryFor(categories: FailCategory[], lang: ScadaLang): string[] {
  if (categories.includes('inspection'))
    return [tscAi(lang, 'recovCamR1'), tscAi(lang, 'recovCamR2'), tscAi(lang, 'recovCamR3')];
  if (categories.includes('placement'))
    return [tscAi(lang, 'recovPlaceR1'), tscAi(lang, 'recovPlaceR2'), tscAi(lang, 'recovPlaceR3')];
  if (categories.includes('estop'))
    return [tscAi(lang, 'recovEstopR1'), tscAi(lang, 'recovEstopR2'), tscAi(lang, 'recovEstopR3')];
  if (categories.includes('trajectory') || categories.includes('anomaly'))
    return [tscAi(lang, 'recovCollR1'), tscAi(lang, 'recovCollR2'), tscAi(lang, 'recovCollR3')];
  if (categories.includes('predictive'))
    return [tscAi(lang, 'recovPredR1'), tscAi(lang, 'recovPredR2'), tscAi(lang, 'recovPredR3')];
  return [tscAi(lang, 'recovGenR1'), tscAi(lang, 'recovGenR2'), tscAi(lang, 'recovGenR3')];
}
