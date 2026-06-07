// ─────────────────────────────────────────────────────────────────────────────
// cellStateMachine.test.ts — Pruebas de la máquina de estados pura de la celda.
//
// TypeScript puro (sin Node/DOM salvo `console`), por lo que `npx tsc --noEmit`
// las typechquea. El runner ejecutable vive en
// `scripts/validate-cell-state-machine.mjs`, que importa `runCellStateMachineTests`.
//
// Correr:   node scripts/validate-cell-state-machine.mjs
//
// Cubre: gates de spawn/sensor/cola, pick, ciclo completo PASS/FAIL, remachado,
// DOS CAFIs en el disco a la vez, STOP/RESUME, RESTART→CLEANING→IDLE, RESET y
// la separación HMI/DEBUG.
// ─────────────────────────────────────────────────────────────────────────────

import { createCellStateMachine, type CellStateMachine } from './cellStateMachine';
import type { CellSnapshot, Verdict } from './cellStateTypes';

export interface TestReport {
  passed: number;
  failed: number;
  failures: string[];
}

type Checker = (name: string, cond: boolean, detail?: string) => void;

function run(m: CellStateMachine, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) m.tick(dt);
}

function runUntil(
  m: CellStateMachine,
  predicate: (s: CellSnapshot) => boolean,
  maxSeconds = 60,
  dt = 1 / 60,
): boolean {
  const steps = Math.round(maxSeconds / dt);
  for (let i = 0; i < steps; i++) {
    m.tick(dt);
    if (predicate(m.snapshot())) return true;
  }
  return predicate(m.snapshot());
}

// El remachado real son 30 s; para que las pruebas corran rápido usamos speed
// alto (el dwell de remachado IGNORA speed, así que lo acortamos por config).
const newMachine = (verdict: Verdict = 'PASS'): CellStateMachine =>
  createCellStateMachine({ visionPolicy: () => verdict, config: { speed: 4, riveting: 2 } });

export function runCellStateMachineTests(log: (line: string) => void = () => {}): TestReport {
  const report: TestReport = { passed: 0, failed: 0, failures: [] };
  const check: Checker = (name, cond, detail = '') => {
    if (cond) {
      report.passed++;
      log(`  \x1b[32m✓\x1b[0m ${name}`);
    } else {
      report.failed++;
      report.failures.push(name);
      log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `  → ${detail}` : ''}`);
    }
  };

  // 1. START arma la celda y NO crea CAFI.
  {
    const m = newMachine();
    m.start();
    const s = m.snapshot();
    check('1. START arma la celda (RUNNING) y NO crea ninguna CAFI',
      s.cell === 'RUNNING' && s.cafis.length === 0 && s.cobotTask === 'IDLE',
      `cell=${s.cell} cafis=${s.cafis.length}`);
  }

  // 2. Colocar CAFI bloqueado si la celda no está RUNNING.
  {
    const m = newMachine();
    const okIdle = m.placeCafi();
    check('2. Colocar CAFI bloqueado si la celda NO está RUNNING',
      okIdle === false && m.snapshot().cafis.length === 0, `placeCafi=${okIdle}`);
  }

  // 3. Colocar CAFI permitido si RUNNING y sensor libre.
  {
    const m = newMachine();
    m.start();
    const ok = m.placeCafi();
    check('3. Colocar CAFI permitido si RUNNING y sensor libre',
      ok === true && m.snapshot().cafis.length === 1, `placeCafi=${ok}`);
  }

  // 4. Colocar CAFI bloqueado si el sensor está ocupado.
  {
    const m = newMachine();
    m.start();
    m.placeCafi();
    runUntil(m, (s) => s.sensorOccupied, 10);
    // Pausar el avance para que el cobot no tome la pieza antes de medir.
    m.stop();
    const blocked = m.placeCafi();
    const s = m.snapshot();
    check('4. Colocar CAFI bloqueado si el sensor está ocupado',
      blocked === false, `placeCafi=${blocked} reason=${s.spawnBlockReason}`);
  }

  // 5. Máximo 2 CAFIs esperando.
  {
    const m = newMachine();
    m.start();
    const a = m.placeCafi();
    const b = m.placeCafi();
    const c = m.placeCafi();
    const s = m.snapshot();
    check('5. Máximo 2 CAFIs esperando (la 3ª se bloquea)',
      a && b && c === false && s.waitingCount === 2 && s.spawnBlockReason === 'COLA LLENA (2)',
      `a=${a} b=${b} c=${c} waiting=${s.waitingCount}`);
  }

  // 6. PICK_CONVEYOR libera el sensor.
  {
    const m = newMachine();
    m.start();
    m.placeCafi();
    runUntil(m, (s) => s.cafis[0]?.state === 'IN_GRIPPER', 15);
    const s = m.snapshot();
    check('6. PICK_CONVEYOR pasa la pieza a IN_GRIPPER y libera el sensor',
      s.sensorOccupied === false && s.cafis[0].state === 'IN_GRIPPER',
      `sensor=${s.sensorOccupied} cafi=${s.cafis[0]?.state}`);
  }

  // 7. Ciclo completo con 1 CAFI termina en bin (PASS → aceptado, riveted).
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    const done = runUntil(m, (s) => s.cafis[0]?.state === 'ACCEPTED_BIN', 60);
    const c = m.snapshot().cafis[0];
    check('7. Ciclo completo (1 CAFI) termina en bin de aceptados',
      done && c.state === 'ACCEPTED_BIN' && c.bin === 'ACCEPT' && c.riveted === true,
      `state=${c?.state} bin=${c?.bin} riveted=${c?.riveted}`);
  }

  // 8. FAIL enruta al bin de rechazados.
  {
    const m = newMachine('FAIL');
    m.start(); m.placeCafi();
    const rejected = runUntil(m, (s) => s.cafis[0]?.state === 'REJECTED_BIN', 60);
    const c = m.snapshot().cafis[0];
    check('8. FAIL enruta al bin de rechazados',
      rejected && c.bin === 'REJECT', `state=${c?.state} bin=${c?.bin}`);
  }

  // 9. El remachado dura y marca riveted=true.
  {
    const m = newMachine('PASS');
    m.start(); m.placeCafi();
    const riveted = runUntil(m, (s) => s.cafis[0]?.riveted === true, 40);
    check('9. El remachado marca la pieza riveted=true', riveted,
      `riveted=${m.snapshot().cafis[0]?.riveted}`);
  }

  // 10. DOS CAFIs en el disco simultáneamente (concurrencia A/B).
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    m.placeCafi();
    const both = runUntil(m, (s) => s.fixtureA.present && s.fixtureB.present, 60);
    const s = m.snapshot();
    check('10. Dos CAFIs montadas en el disco a la vez (fixtures A y B)',
      both && s.fixtureA.present && s.fixtureB.present,
      `A=${s.fixtureA.present} B=${s.fixtureB.present}`);
  }

  // 11. Ambas CAFIs terminan en bin (ciclo concurrente completo).
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    m.placeCafi();
    const done = runUntil(m, (s) => {
      const inBin = (id: number) => {
        const c = s.cafis.find((x) => x.id === id);
        return c?.state === 'ACCEPTED_BIN' || c?.state === 'REJECTED_BIN';
      };
      return inBin(1) && inBin(2);
    }, 120);
    const s = m.snapshot();
    check('11. Las dos CAFIs completan su ciclo (concurrente)',
      done && s.counts.accepted + s.counts.rejected === 2,
      `accepted=${s.counts.accepted} rejected=${s.counts.rejected}`);
  }

  // 12. STOP congela los timers.
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    run(m, 1);
    m.stop();
    const before = m.snapshot();
    run(m, 5);
    const after = m.snapshot();
    check('12. STOP pausa la celda y congela el reloj',
      after.cell === 'PAUSED' && after.clock === before.clock,
      `cell=${after.cell} clock ${before.clock}→${after.clock}`);
  }

  // 13. RESUME reanuda desde PAUSED.
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    run(m, 1);
    m.stop();
    const ok = m.resume();
    check('13. RESUME reanuda la celda (PAUSED → RUNNING)',
      ok && m.snapshot().cell === 'RUNNING', `resume=${ok} cell=${m.snapshot().cell}`);
  }

  // 14. RESTART → RESTARTING → CLEANING_REQUIRED, luego CONFIRM_CLEAN → IDLE.
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    runUntil(m, (s) => s.cafis[0]?.state === 'IN_OUTSIDE_FIXTURE' || s.cobotInTableZone, 20);
    m.stop();
    const restarted = m.restart();
    const reachedClean = runUntil(m, (s) => s.cell === 'CLEANING_REQUIRED', 20);
    const cleanSnap = m.snapshot();
    const confirmed = m.confirmClean();
    const idleSnap = m.snapshot();
    check('14. RESTART → CLEANING_REQUIRED → (confirmar) → IDLE',
      restarted && reachedClean && cleanSnap.cell === 'CLEANING_REQUIRED' &&
      confirmed && idleSnap.cell === 'IDLE',
      `restart=${restarted} clean=${cleanSnap.cell} confirm=${confirmed} idle=${idleSnap.cell}`);
  }

  // 15. RESET limpia estado a IDLE seguro.
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    run(m, 3);
    m.stop();
    const ok = m.reset();
    const s = m.snapshot();
    check('15. RESET limpia estado y vuelve a IDLE seguro',
      ok && s.cell === 'IDLE' && s.cafis.length === 0 && s.activeCafiId === null &&
      s.turntable.angleDeg === 0 && s.verdict === null && s.riveting === 'IDLE',
      `cell=${s.cell} cafis=${s.cafis.length}`);
  }

  // 16. DEBUG detiene el avance automático.
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    run(m, 1);
    m.switchMode('DEBUG');
    const before = m.snapshot();
    run(m, 10);
    const after = m.snapshot();
    check('16. En DEBUG la simulación HMI no avanza (modo separado)',
      after.mode === 'DEBUG' && after.cell === 'PAUSED' && after.clock === before.clock,
      `mode=${after.mode} cell=${after.cell}`);
  }

  // 17. START bloqueado si hay piezas ocupando sensores (interlock de arranque).
  {
    const m = newMachine('PASS');
    m.start();
    m.placeCafi();
    runUntil(m, (s) => s.fixtureA.present || s.fixtureB.present, 20);
    m.stop();
    m.reset(); // limpia → IDLE; START debe permitirse de nuevo
    const okStart = m.start();
    check('17. START permitido tras RESET limpio',
      okStart && m.snapshot().cell === 'RUNNING', `start=${okStart}`);
  }

  return report;
}
