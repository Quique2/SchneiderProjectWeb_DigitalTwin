import React, { useState } from 'react';
import { useScadaSimMonitor, type ScadaCommandFeedback, type SourceState } from './useScadaSimMonitor';
import type { AiPillars, RunModel, RunStatus } from './runTypes';
import type { CafiEntity, CellSnapshot } from '../cellStateTypes';
import { activeCafiInfo, isInProcess, nextAction, pickActiveCafi, zoneLabel } from './cafiInsights';
import { derivePillars } from './aiPillars';
import { buildReportText, composeMailto, copyReportToClipboard, defaultSubject, downloadReportTxt, openMailto } from './adminReport';
import { activationTotals } from './metrics';
import { deriveStacklight, type StacklightState } from './stacklight';
import {
  bottleneckLabel,
  cafiStateLabel,
  cellStateLabel,
  componentLabel,
  localizeRecommendation,
  readStoredScadaLanguage,
  riskLabel,
  runStatusLabel,
  sourceStateLabel,
  tr,
  type ScadaLanguage,
  writeStoredScadaLanguage,
} from './i18n';
import { useScadaTheme } from '../scada/shared/useScadaTheme';
import type { ScadaTokens } from '../scada/shared/scadaTheme';
import ScadaSectionCard from '../scada/shared/ScadaSectionCard';
import ScadaIoPanel from '../scada/shared/ScadaIoPanel';
import { ScadaBadge, type BadgeTone } from '../scada/shared/ScadaStatusBadge';
import type { ScadaTileData } from '../scada/shared/ScadaSignalTile';

const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif';

type SimTab = 'panel' | 'cafis' | 'corridas';
type ActivationView = 'detail' | 'total';

function sFmt(msv: number | null | undefined): string {
  if (msv == null) return '-';
  return `${(msv / 1000).toFixed(1)} s`;
}

function sourceColor(s: SourceState, t: ScadaTokens): string {
  return s === 'CONNECTED' ? t.success : s === 'LOST' ? t.danger : t.warning;
}

function statusTone(s: RunStatus): BadgeTone {
  if (s === 'ACTIVE') return 'success';
  if (s.startsWith('COMPLETED')) return 'success';
  if (s.startsWith('ABORT') || s === 'FAULTED') return 'danger';
  return 'warning';
}

function statusColor(s: RunStatus, t: ScadaTokens): string {
  const tone = statusTone(s);
  return tone === 'success' ? t.success : tone === 'danger' ? t.danger : t.warning;
}

function riskColor(r: 'BAJO' | 'MEDIO' | 'ALTO', t: ScadaTokens): string {
  return r === 'ALTO' ? t.danger : r === 'MEDIO' ? t.warning : t.success;
}

function buildTiles(s: CellSnapshot, language: ScadaLanguage): ScadaTileData[] {
  const q: ScadaTileData['quality'] = 'sim';
  const es = language === 'es';
  const inputs: [string, string, boolean][] = [
    [es ? 'Fotoelectrico conveyor' : 'Conveyor photoeye', 'conveyor_photoeye', s.di.conveyor],
    [es ? 'Fixture 1 presente' : 'Fixture 1 present', 'fixture_1_present', s.fixtureA.present],
    [es ? 'Fixture 2 presente' : 'Fixture 2 present', 'fixture_2_present', s.fixtureB.present],
    [es ? 'Limite mesa HOME' : 'Table HOME limit', 'table_home_limit', s.turntable.limitHome],
    [es ? 'Limite mesa WORK' : 'Table WORK limit', 'table_work_limit', s.turntable.limitWork],
    [es ? 'Vision presente' : 'Vision present', 'vision_present', s.di.vision],
    [es ? 'Cobot listo' : 'Cobot ready', 'cobot_ready', s.di.cobotReady],
  ];
  const outputs: [string, string, boolean][] = [
    [es ? 'Motor conveyor' : 'Conveyor motor', 'conveyor_motor_on', s.do.convMotor],
    [es ? 'Mesa moviendo' : 'Table moving', 'table_nema_moving', s.turntable.moving],
    [es ? 'Remache activo' : 'Rivet active', 'rivet_active', s.do.remachado],
    [es ? 'Disparo camara' : 'Camera trigger', 'camera_trigger', s.do.camara],
    [es ? 'Gripper abierto' : 'Gripper open', 'gripper_open', s.do.gripOpen],
    [es ? 'Gripper cerrado' : 'Gripper close', 'gripper_closed', s.do.gripClose],
    [es ? 'Solenoide fixture' : 'Fixture solenoid', 'fixture_solenoid', s.do.solLeft],
  ];
  const map = (arr: [string, string, boolean][], kind: ScadaTileData['kind']): ScadaTileData[] =>
    arr.map(([label, signalKey, value]) => ({ label, signalKey, value, kind, quality: q }));
  return [...map(inputs, 'input'), ...map(outputs, 'output')];
}

export default function ScadaSimView() {
  const { tokens: t, theme, setTheme } = useScadaTheme();
  const mon = useScadaSimMonitor();
  const [language, setLanguageState] = useState<ScadaLanguage>(() => readStoredScadaLanguage());
  const [view, setView] = useState<SimTab>('panel');

  const setLanguage = (next: ScadaLanguage) => {
    setLanguageState(next);
    writeStoredScadaLanguage(next);
  };

  const sc = sourceColor(mon.sourceState, t);
  const s = mon.lastSnapshot;
  const run = mon.currentRun;
  const tabs: { id: SimTab; label: string; badge?: number }[] = [
    { id: 'panel', label: tr(language, 'panel') },
    { id: 'cafis', label: tr(language, 'cafis'), badge: s ? s.cafis.length : 0 },
    { id: 'corridas', label: tr(language, 'runs'), badge: mon.history.length },
  ];

  return (
    <div style={{ height: '100%', width: '100%', background: t.bg, color: t.text, overflowY: 'auto', fontFamily: SANS }}>
      <div style={{ maxWidth: 1360, margin: '0 auto', padding: '24px clamp(12px, 4vw, 28px) 56px', overflowX: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', maxWidth: '100%' }}>
              <span style={{ fontSize: 30, fontWeight: 850, letterSpacing: 0 }}>{tr(language, 'title')}</span>
              <ScadaBadge text={tr(language, 'simulation')} tone="sim" dot />
              <ScadaBadge text={tr(language, 'modeMonitor')} tone="accent" />
            </div>
            <div style={{ fontSize: 13, color: t.muted, marginTop: 6 }}>{tr(language, 'subtitle')}</div>
          </div>
          <div style={{ minWidth: 0, maxWidth: '100%', flex: '1 1 280px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.surface, border: `1px solid ${sc}`, borderRadius: 12, padding: '8px 14px' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: sc, boxShadow: `0 0 8px ${sc}` }} />
              <span style={{ fontSize: 12.5, fontWeight: 850, color: sc, fontFamily: MONO, letterSpacing: 0.4 }}>{sourceStateLabel(mon.sourceState, language)}</span>
            </div>
            <Segmented t={t} value={language} items={[{ id: 'es', label: 'ES' }, { id: 'en', label: 'EN' }, { id: 'de', label: 'DE' }, { id: 'pt', label: 'PT' }, { id: 'it', label: 'IT' }, { id: 'fr', label: 'FR' }]} onChange={(v) => setLanguage(v as ScadaLanguage)} />
            <Segmented t={t} value={theme} items={[{ id: 'light', label: tr(language, 'light') }, { id: 'dark', label: tr(language, 'dark') }]} onChange={(v) => setTheme(v as 'light' | 'dark')} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 18 }}>
          <InfoCard t={t} label={tr(language, 'mode')} value="MONITOR" color={t.accent} small />
          <InfoCard t={t} label={tr(language, 'source')} value={sourceStateLabel(mon.sourceState, language)} color={sc} small />
          <InfoCard t={t} label={tr(language, 'lastSnapshot')} value={mon.ageS == null ? '-' : `${mon.ageS}s`} color={t.muted} />
          <InfoCard t={t} label={tr(language, 'cell')} value={cellStateLabel(s?.cell, language)} color={t.text} small />
          <InfoCard t={t} label={tr(language, 'simClock')} value={s ? `${(s.clock / 1000).toFixed(1)}s` : '-'} color={t.muted} small />
          <InfoCard t={t} label={tr(language, 'currentRun')} value={run ? `#${run.number}` : '-'} color={run ? t.accent : t.muted} small />
        </div>

        {mon.sourceState === 'LOST' && <Banner t={t} color={t.danger} title={tr(language, 'sourceLostTitle')} text={tr(language, 'sourceLostBody')} />}

        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {tabs.map((tb) => (
            <button key={tb.id} onClick={() => setView(tb.id)} style={{
              background: tb.id === view ? t.btnBg : 'transparent',
              color: tb.id === view ? t.btnText : t.muted,
              border: `1px solid ${tb.id === view ? t.btnBorder : t.border}`,
              borderRadius: 10,
              padding: '8px 16px',
              fontSize: 12.5,
              fontWeight: 750,
              letterSpacing: 0,
              cursor: 'pointer',
              fontFamily: MONO,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              transition: 'background 160ms, border 160ms, color 160ms',
            }}>
              {tb.label}
              {tb.badge !== undefined && tb.badge > 0 && <span style={{ fontSize: 10, background: `${t.sim}22`, color: t.sim, borderRadius: 6, padding: '1px 6px' }}>{tb.badge}</span>}
            </button>
          ))}
        </div>

        {view === 'panel' && (
          mon.sourceState === 'WAITING' || !s
            ? <NoSourceDashboard t={t} language={language} mon={mon} />
            : <Dashboard t={t} language={language} run={run} s={s} mon={mon} />
        )}
        {view === 'cafis' && <CafisTab t={t} language={language} s={s} />}
        {view === 'corridas' && (
          <HistorySection t={t} language={language} history={mon.history} onExportCsv={(r) => mon.exportCsv(r, language)} onExportJson={(r) => mon.exportJson(r, language)} onRefresh={mon.refreshHistory} />
        )}

        <div style={{ fontSize: 10.5, color: t.dim, textAlign: 'center', marginTop: 24 }}>{tr(language, 'simulatedDataNote')}</div>
      </div>
    </div>
  );
}

function NoSourceDashboard({ t, language, mon }: { t: ScadaTokens; language: ScadaLanguage; mon: ReturnType<typeof useScadaSimMonitor> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 14 }}>
        <CommandPanel t={t} language={language} sourceState={mon.sourceState} feedback={mon.commandFeedback} onCommand={mon.requestCommand} />
        <StacklightPanel t={t} language={language} state="OFF" />
      </div>
      <WaitingScreen t={t} language={language} />
    </div>
  );
}

function Dashboard({ t, language, run, s, mon }: { t: ScadaTokens; language: ScadaLanguage; run: RunModel | null; s: CellSnapshot; mon: ReturnType<typeof useScadaSimMonitor> }) {
  const pillars = run ? derivePillars(run) : null;
  const active = pickActiveCafi(s.cafis);
  const activeInfo = active ? activeCafiInfo(active, s.clock, language) : null;
  const stack = deriveStacklight(mon.sourceState, s, run);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 14 }}>
        <CommandPanel t={t} language={language} sourceState={mon.sourceState} feedback={mon.commandFeedback} onCommand={mon.requestCommand} />
        <StacklightPanel t={t} language={language} state={stack} />
      </div>

      <ProductionPanel t={t} language={language} run={run} onExportCsv={run ? () => mon.exportCsv(run, language) : undefined} onExportJson={run ? () => mon.exportJson(run, language) : undefined} />
      <ActiveCafiCard t={t} language={language} info={activeInfo} />
      <MaintPanel t={t} language={language} pillars={pillars} />
      <ActivationSection t={t} language={language} run={run} />
      <ReportBar t={t} language={language} run={run} pillars={pillars} />
      <ScadaIoPanel
        tiles={buildTiles(s, language)}
        mode="simulation"
        title={tr(language, 'ioTitle')}
        subtitle={tr(language, 'ioSubtitle')}
        labels={{
          input: tr(language, 'inputsSystem'),
          output: tr(language, 'outputsSystem'),
          legacy: tr(language, 'legacyDiag'),
          simulated: tr(language, 'simulatedIo'),
          real: tr(language, 'realIo'),
          empty: tr(language, 'noSignals'),
          tile: {
            on: tr(language, 'on'),
            off: tr(language, 'offState'),
            active: tr(language, 'active'),
            inactive: tr(language, 'inactive'),
            notWired: tr(language, 'notWired'),
            nullValue: tr(language, 'nullValue'),
            sim: 'SIM',
          },
        }}
      />
    </div>
  );
}

function CommandPanel({ t, language, sourceState, feedback, onCommand }: {
  t: ScadaTokens;
  language: ScadaLanguage;
  sourceState: SourceState;
  feedback: ScadaCommandFeedback;
  onCommand: ReturnType<typeof useScadaSimMonitor>['requestCommand'];
}) {
  const disabled = sourceState !== 'CONNECTED';
  const commands: { type: 'START' | 'STOP' | 'RESUME' | 'FINALIZE'; label: string; tone: string }[] = [
    { type: 'START', label: tr(language, 'start'), tone: t.success },
    { type: 'STOP', label: tr(language, 'stop'), tone: t.warning },
    { type: 'RESUME', label: tr(language, 'resume'), tone: t.accent },
    { type: 'FINALIZE', label: tr(language, 'finalize'), tone: t.danger },
  ];
  return (
    <ScadaSectionCard title={tr(language, 'commandCenter')} accent={t.accent} right={<CommandFeedbackBadge t={t} language={language} feedback={feedback} disabled={disabled} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 10 }}>
        {commands.map((cmd) => (
          <button key={cmd.type} disabled={disabled} onClick={() => onCommand({ type: cmd.type })} style={{
            minHeight: 46,
            borderRadius: 12,
            border: `1px solid ${disabled ? t.border : cmd.tone}`,
            background: disabled ? t.surfaceSoft : `${cmd.tone}18`,
            color: disabled ? t.dim : cmd.tone,
            fontFamily: MONO,
            fontWeight: 850,
            fontSize: 12,
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'background 160ms, border 160ms, color 160ms',
          }}>
            {cmd.label}
          </button>
        ))}
      </div>
      {disabled && <div style={{ fontSize: 11.5, color: t.warning, marginTop: 4 }}>{tr(language, 'noSourceConnected')}</div>}
    </ScadaSectionCard>
  );
}

function CommandFeedbackBadge({ t, language, feedback, disabled }: { t: ScadaTokens; language: ScadaLanguage; feedback: ScadaCommandFeedback; disabled: boolean }) {
  if (disabled) return <ScadaBadge text={language === 'es' ? 'Sin fuente' : 'No source'} tone="warning" />;
  if (feedback.state === 'waiting_ack') return <ScadaBadge text={`${tr(language, 'waitingAck')} ${feedback.command ?? ''}`} tone="warning" />;
  if (feedback.state === 'applied') return <ScadaBadge text={`${tr(language, 'commandApplied')} ${feedback.command ?? ''}`} tone="success" />;
  if (feedback.state === 'error' || feedback.state === 'timeout') return <ScadaBadge text={tr(language, 'commandError')} tone="danger" />;
  if (feedback.state === 'no_source') return <ScadaBadge text={language === 'es' ? 'Sin fuente' : 'No source'} tone="warning" />;
  return <ScadaBadge text={tr(language, 'commandSent')} tone="muted" />;
}

function StacklightPanel({ t, language, state }: { t: ScadaTokens; language: ScadaLanguage; state: StacklightState }) {
  const meta: Record<StacklightState, { label: string; color: string; reason: string }> = {
    GREEN: { label: tr(language, 'green'), color: t.success, reason: tr(language, 'stackGreenReason') },
    YELLOW: { label: tr(language, 'yellow'), color: t.warning, reason: tr(language, 'stackYellowReason') },
    RED: { label: tr(language, 'red'), color: t.danger, reason: tr(language, 'stackRedReason') },
    OFF: { label: tr(language, 'off'), color: t.ledOff, reason: tr(language, 'stackOffReason') },
  };
  const current = meta[state];
  return (
    <ScadaSectionCard title={tr(language, 'stacklightSim')} accent={current.color} right={<ScadaBadge text={current.label} tone={state === 'GREEN' ? 'success' : state === 'RED' ? 'danger' : state === 'YELLOW' ? 'warning' : 'muted'} />}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {(['RED', 'YELLOW', 'GREEN'] as StacklightState[]).map((x) => (
          <span key={x} style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: state === x ? meta[x].color : t.ledOff,
            boxShadow: state === x ? `0 0 14px ${meta[x].color}` : 'none',
            border: `1px solid ${state === x ? meta[x].color : t.border}`,
          }} />
        ))}
        <div>
          <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 850, color: current.color }}>{current.label}</div>
          <div style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{current.reason}</div>
        </div>
      </div>
    </ScadaSectionCard>
  );
}

function ProductionPanel({ t, language, run, onExportCsv, onExportJson }: {
  t: ScadaTokens; language: ScadaLanguage; run: RunModel | null; onExportCsv?: () => void; onExportJson?: () => void;
}) {
  return (
    <ScadaSectionCard title={tr(language, 'production')} accent={t.success} right={run ? (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <BtnSmall t={t} label={tr(language, 'exportCsv')} onClick={onExportCsv!} />
        <BtnSmall t={t} label={tr(language, 'exportJson')} onClick={onExportJson!} />
      </div>
    ) : null}>
      {run ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 12 }}>
          <Kpi t={t} label={tr(language, 'runNumber')} value={`#${run.number}`} color={t.accent} />
          <Kpi t={t} label={tr(language, 'status')} value={runStatusLabel(run.status, language)} color={statusColor(run.status, t)} small />
          <Kpi t={t} label={tr(language, 'duration')} value={sFmt(run.durationMs)} color={t.text} />
          <Kpi t={t} label={tr(language, 'completed')} value={String(run.production.completed)} color={t.text} />
          <Kpi t={t} label={tr(language, 'accepted')} value={String(run.production.accepted)} color={t.success} />
          <Kpi t={t} label={tr(language, 'rejected')} value={String(run.production.rejected)} color={t.danger} />
          <Kpi t={t} label={tr(language, 'inProcess')} value={String(run.production.inProcess)} color={t.warning} />
          <Kpi t={t} label={tr(language, 'currentCycle')} value={sFmt(run.production.currentCycleMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'average')} value={sFmt(run.production.averageCycleMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'lastCycle')} value={sFmt(run.production.lastCycleMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'last5Average')} value={sFmt(run.production.last5AvgMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'cobotIdle')} value={`${Math.round(run.production.cobotIdlePct * 100)}%`} color={t.muted} small />
        </div>
      ) : (
        <div style={{ fontSize: 13, color: t.muted }}>{tr(language, 'noActiveRun')}</div>
      )}
    </ScadaSectionCard>
  );
}

function ActiveCafiCard({ t, language, info }: { t: ScadaTokens; language: ScadaLanguage; info: ReturnType<typeof activeCafiInfo> | null }) {
  return (
    <ScadaSectionCard title={tr(language, 'activeCafi')} accent={t.sim} right={<ScadaBadge text={tr(language, 'lowerIdInProcess')} tone="sim" />}>
      {!info ? (
        <div style={{ fontSize: 14, color: t.muted, padding: '6px 0' }}>{tr(language, 'noCafisInProcess')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Kpi t={t} label="ID CAFI" value={`#${info.id}`} color={t.accent} />
          <Kpi t={t} label={tr(language, 'state')} value={cafiStateLabel(info.state, language)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'zone')} value={info.zone} color={t.sim} small />
          <Kpi t={t} label={tr(language, 'nextAction')} value={info.nextAction} color={t.warning} small />
          <Kpi t={t} label={tr(language, 'timeSinceDetection')} value={sFmt(info.sinceDetectedMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'timeInCurrentState')} value={sFmt(info.inStateMs)} color={t.text} small />
          <Kpi t={t} label={tr(language, 'verdict')} value={info.verdict ?? '-'} color={info.verdict === 'PASS' ? t.success : info.verdict === 'FAIL' ? t.danger : t.muted} small />
        </div>
      )}
    </ScadaSectionCard>
  );
}

function ActivationSection({ t, language, run }: { t: ScadaTokens; language: ScadaLanguage; run: RunModel | null }) {
  const [mode, setMode] = useState<ActivationView>('detail');
  const totals = activationTotals(run);
  return (
    <ScadaSectionCard title={tr(language, 'activations')} accent={t.sim} right={
      <Segmented t={t} value={mode} items={[{ id: 'detail', label: tr(language, 'detail') }, { id: 'total', label: tr(language, 'total') }]} onChange={(v) => setMode(v as ActivationView)} />
    }>
      {mode === 'total' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Kpi t={t} label={tr(language, 'totalSensorActivations')} value={String(totals.sensors)} color={t.sim} />
          <Kpi t={t} label={tr(language, 'totalActuatorActivations')} value={String(totals.actuators)} color={t.warning} />
          <Kpi t={t} label={tr(language, 'totalOperatorEvents')} value={String(totals.operator)} color={t.accent} />
          <Kpi t={t} label={tr(language, 'grandTotal')} value={String(totals.grandTotal)} color={t.text} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
          <SignalCountCard t={t} title={tr(language, 'sensorsActivations')} accent={t.sim} rows={[
            [language === 'es' ? 'Fotoelectrico conveyor' : 'Conveyor photoeye', run?.sensors.conveyorPhotoeye ?? 0],
            [language === 'es' ? 'Sensor fixture 1' : 'Fixture 1 sensor', run?.sensors.fixture1Present ?? 0],
            [language === 'es' ? 'Sensor fixture 2' : 'Fixture 2 sensor', run?.sensors.fixture2Present ?? 0],
            ['Limit switch HOME', run?.sensors.limitHome ?? 0],
            ['Limit switch WORK', run?.sensors.limitWork ?? 0],
            [language === 'es' ? 'Sensor vision' : 'Vision sensor', run?.sensors.visionPresent ?? 0],
            [language === 'es' ? 'Disparo camara' : 'Camera trigger', run?.sensors.cameraTrigger ?? 0],
            [language === 'es' ? 'Camara PASS' : 'Camera PASS', run?.sensors.cameraPass ?? 0, t.success],
            [language === 'es' ? 'Camara FAIL' : 'Camera FAIL', run?.sensors.cameraFail ?? 0, t.danger],
          ]} />
          <SignalCountCard t={t} title={tr(language, 'actuators')} accent={t.warning} rows={[
            ['Gripper close', run?.actuators.gripperClose ?? 0],
            ['Gripper open', run?.actuators.gripperOpen ?? 0],
            [language === 'es' ? 'Conveyor arranques' : 'Conveyor starts', run?.actuators.conveyorStarts ?? 0],
            ['Conveyor ON', sFmt(run?.actuators.conveyorOnMs)],
            [language === 'es' ? 'Giros mesa' : 'Table turns', run?.actuators.tableTurns ?? 0],
            ['HOME -> WORK', run?.actuators.tableHomeToWork ?? 0],
            ['WORK -> HOME', run?.actuators.tableWorkToHome ?? 0],
            [language === 'es' ? 'Mesa moviendo' : 'Table moving', sFmt(run?.actuators.tableMovingMs)],
            [language === 'es' ? 'Ciclos remache' : 'Rivet cycles', run?.actuators.rivetCycles ?? 0],
            [language === 'es' ? 'Remache activo' : 'Rivet active', sFmt(run?.actuators.rivetActiveMs)],
          ]} />
          <SignalCountCard t={t} title={tr(language, 'operatorEvents')} accent={t.accent} rows={[
            ['START', run?.operator.start ?? 0],
            ['STOP', run?.operator.stop ?? 0],
            ['RESUME', run?.operator.resume ?? 0],
            ['RESTART', run?.operator.restart ?? 0],
            [language === 'es' ? 'Confirmar limpieza' : 'Confirm clean', run?.operator.confirmClean ?? 0],
            [tr(language, 'finalize'), run?.operator.finalize ?? 0],
          ]} />
        </div>
      )}
    </ScadaSectionCard>
  );
}

function SignalCountCard({ t, title, accent, rows }: { t: ScadaTokens; title: string; accent: string; rows: [string, React.ReactNode, string?][] }) {
  return (
    <div style={{ background: t.surfaceSoft, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 4, height: 16, borderRadius: 4, background: accent }} />
        <div style={{ fontSize: 12.5, fontWeight: 850, color: t.muted, textTransform: 'uppercase' }}>{title}</div>
      </div>
      {rows.map(([k, v, color]) => <KV key={k} t={t} k={k} v={v} color={color} />)}
    </div>
  );
}

function MaintPanel({ t, language, pillars }: { t: ScadaTokens; language: ScadaLanguage; pillars: AiPillars | null }) {
  if (!pillars) {
    return (
      <ScadaSectionCard title={tr(language, 'maintenanceAi')} accent={t.sim} right={<ScadaBadge text="SIM" tone="sim" />}>
        <div style={{ fontSize: 13, color: t.muted }}>{tr(language, 'noActiveRun')}</div>
      </ScadaSectionCard>
    );
  }
  const pr = pillars.prediction, q = pillars.quality, ef = pillars.efficiency;
  const rc = riskColor(pr.estimatedMaintenanceRisk, t);
  return (
    <ScadaSectionCard title={tr(language, 'maintenanceAi')} accent={t.sim} right={<ScadaBadge text={language === 'es' ? 'Analitica de simulacion' : 'Simulation analytics'} tone="sim" />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Kpi t={t} label={tr(language, 'maintenanceRisk')} value={riskLabel(pr.estimatedMaintenanceRisk, language)} color={rc} />
        <Kpi t={t} label={tr(language, 'mostWornComponent')} value={componentLabel(pr.worstComponent, language)} color={t.warning} small />
        <Kpi t={t} label={tr(language, 'bottleneck')} value={bottleneckLabel(ef.bottleneckDetected, language)} color={t.accent} small />
        <Kpi t={t} label={tr(language, 'passRate')} value={`${q.passRate}%`} color={t.success} small />
        <Kpi t={t} label={tr(language, 'rejectRate')} value={`${q.rejectRate}%`} color={t.danger} small />
      </div>
      <div style={{ marginTop: 12, background: t.surfaceSoft, border: `1px solid ${t.border}`, borderRadius: 12, padding: '12px 14px', lineHeight: 1.5 }}>
        <div style={{ color: rc, fontWeight: 850, fontSize: 12.5 }}>{tr(language, 'recommendation')}</div>
        <div style={{ color: t.text, fontSize: 13, marginTop: 4 }}>{localizeRecommendation(pr.maintenanceRecommendation, language)}</div>
        <div style={{ color: t.muted, fontSize: 12.5, marginTop: 4 }}>{localizeRecommendation(q.qualityRecommendation, language)}</div>
      </div>
    </ScadaSectionCard>
  );
}

function ReportBar({ t, language, run, pillars }: { t: ScadaTokens; language: ScadaLanguage; run: RunModel | null; pillars: AiPillars | null }) {
  const [msg, setMsg] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [subjectOverride, setSubjectOverride] = useState<string>('');
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  if (!run || !pillars) return null;

  const generated = buildReportText(run, pillars, language);
  const body = bodyOverride ?? generated;
  const subject = subjectOverride || defaultSubject(run, language);
  const flash = (m: string) => setMsg(m);
  const inputStyle: React.CSSProperties = {
    background: t.surfaceSoft,
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12.5,
    fontFamily: SANS,
    outline: 'none',
  };

  return (
    <ScadaSectionCard title={tr(language, 'administrativeReport')} accent={t.accent} right={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{bodyOverride !== null && <ScadaBadge text={tr(language, 'edited')} tone="warning" />}{msg ? <ScadaBadge text={msg} tone="success" /> : null}</div>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 2fr)', gap: 8, marginBottom: 8 }}>
        <input style={inputStyle} placeholder={language === 'es' ? 'Destinatario (correo)' : 'Recipient (email)'} value={to} onChange={(e) => setTo(e.target.value)} />
        <input style={inputStyle} placeholder={language === 'es' ? 'Asunto' : 'Subject'} value={subject} onChange={(e) => setSubjectOverride(e.target.value)} />
      </div>
      <textarea
        aria-label={tr(language, 'reportPreview')}
        value={body}
        onChange={(e) => setBodyOverride(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 220,
          resize: 'vertical',
          fontFamily: MONO,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: t.text,
          background: t.surfaceSoft,
          border: `1px solid ${t.border}`,
          borderRadius: 10,
          padding: '12px 14px',
          outline: 'none',
          whiteSpace: 'pre',
        }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <BtnSmall t={t} label={tr(language, 'copyReport')} onClick={async () => { const ok = await copyReportToClipboard(body); flash(ok ? tr(language, 'copied') : tr(language, 'clipboardDenied')); }} />
        <BtnSmall t={t} label={tr(language, 'downloadTxt')} onClick={() => { downloadReportTxt(run, body, language); flash(tr(language, 'downloaded')); }} />
        <BtnSmall t={t} label={tr(language, 'openEmail')} onClick={() => { openMailto(composeMailto(to, subject, body)); flash(tr(language, 'openingEmail')); }} />
        <BtnSmall t={t} label={tr(language, 'regenerate')} onClick={() => { setBodyOverride(null); setSubjectOverride(''); flash(tr(language, 'copied')); }} />
      </div>
      <div style={{ fontSize: 10.5, color: t.dim, marginTop: 8 }}>{tr(language, 'mailNote')}</div>
    </ScadaSectionCard>
  );
}

function CafisTab({ t, language, s }: { t: ScadaTokens; language: ScadaLanguage; s: CellSnapshot | null }) {
  if (!s || s.cafis.length === 0) {
    return (
      <ScadaSectionCard title={tr(language, 'cafisCurrentState')} accent={t.sim} right={<ScadaBadge text="0" tone="muted" />}>
        <div style={{ fontSize: 14, color: t.muted, padding: '6px 0' }}>{tr(language, 'noCafisInProcess')}</div>
      </ScadaSectionCard>
    );
  }
  const cafis = [...s.cafis].sort((a, b) => a.id - b.id);
  const activeId = pickActiveCafi(s.cafis)?.id ?? null;
  const inProc = cafis.filter((c) => isInProcess(c.state)).length;
  const accepted = cafis.filter((c) => c.state === 'ACCEPTED_BIN').length;
  const rejected = cafis.filter((c) => c.state === 'REJECTED_BIN').length;
  const Cell = ({ children, w, color, bold }: { children: React.ReactNode; w: string; color?: string; bold?: boolean }) => (
    <span style={{ flex: w, minWidth: 0, fontSize: 11.5, color: color || t.text, fontFamily: MONO, fontWeight: bold ? 850 : 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
        <Kpi t={t} label={tr(language, 'totalCafis')} value={String(cafis.length)} color={t.text} />
        <Kpi t={t} label={tr(language, 'inProcess')} value={String(inProc)} color={t.warning} />
        <Kpi t={t} label={tr(language, 'accepted')} value={String(accepted)} color={t.success} small />
        <Kpi t={t} label={tr(language, 'rejected')} value={String(rejected)} color={t.danger} small />
      </div>
      <ScadaSectionCard title={tr(language, 'cafisCurrentState')} accent={t.sim} right={<ScadaBadge text={`${tr(language, 'activeMarker')} #${activeId ?? '-'}`} tone="sim" />}>
        <div style={{ display: 'flex', gap: 10, padding: '6px 8px', borderBottom: `1px solid ${t.border}`, color: t.muted, textTransform: 'uppercase', fontSize: 9.5, fontWeight: 850 }}>
          <Cell w="0.5" color={t.muted}>ID</Cell>
          <Cell w="1.3" color={t.muted}>{tr(language, 'state')}</Cell>
          <Cell w="1.4" color={t.muted}>{tr(language, 'zone')}</Cell>
          <Cell w="1.5" color={t.muted}>{tr(language, 'nextAction')}</Cell>
          <Cell w="0.8" color={t.muted}>{tr(language, 'camera')}</Cell>
          <Cell w="0.9" color={t.muted}>{tr(language, 'detection')}</Cell>
          <Cell w="0.9" color={t.muted}>{tr(language, 'inState')}</Cell>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 460, overflowY: 'auto' }}>
          {cafis.map((c: CafiEntity) => {
            const info = activeCafiInfo(c, s.clock, language);
            const isActive = c.id === activeId;
            const proc = isInProcess(c.state);
            const stateColor = proc ? t.warning : c.state === 'ACCEPTED_BIN' ? t.success : c.state === 'REJECTED_BIN' ? t.danger : t.muted;
            return (
              <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px', borderBottom: `1px solid ${t.borderSoft}`, background: isActive ? `${t.sim}14` : 'transparent', borderLeft: `3px solid ${isActive ? t.sim : 'transparent'}` }}>
                <Cell w="0.5" color={t.accent} bold>#{c.id}</Cell>
                <Cell w="1.3" color={stateColor} bold>{cafiStateLabel(c.state, language)}</Cell>
                <Cell w="1.4">{zoneLabel(c.state, language)}</Cell>
                <Cell w="1.5" color={proc ? t.text : t.dim}>{nextAction(c.state, language)}</Cell>
                <Cell w="0.8" color={c.verdict === 'PASS' ? t.success : c.verdict === 'FAIL' ? t.danger : t.dim}>{c.verdict ?? '-'}</Cell>
                <Cell w="0.9" color={t.muted}>{sFmt(info.sinceDetectedMs)}</Cell>
                <Cell w="0.9" color={t.muted}>{sFmt(info.inStateMs)}</Cell>
              </div>
            );
          })}
        </div>
      </ScadaSectionCard>
    </div>
  );
}

function HistorySection({ t, language, history, onExportCsv, onExportJson, onRefresh }: {
  t: ScadaTokens; language: ScadaLanguage; history: RunModel[];
  onExportCsv: (r: RunModel) => void; onExportJson: (r: RunModel) => void; onRefresh: () => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <ScadaSectionCard title={tr(language, 'history')} accent={t.sim} right={<BtnSmall t={t} label={tr(language, 'refresh')} onClick={onRefresh} />}>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: t.muted }}>{tr(language, 'noRuns')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((r) => {
              const col = statusColor(r.status, t);
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: t.surfaceSoft, border: `1px solid ${t.border}`, borderRadius: 12, padding: '10px 14px' }}>
                  <span style={{ fontSize: 14, fontWeight: 850, fontFamily: MONO, color: t.text, minWidth: 90 }}>{tr(language, 'run')} {r.number}</span>
                  <ScadaBadge text={runStatusLabel(r.status, language)} tone={statusTone(r.status)} />
                  <span style={{ fontSize: 12, color: t.muted }}>{sFmt(r.durationMs)}</span>
                  <span style={{ fontSize: 12, color: t.muted }}>{r.cafis.length} CAFIs - {r.production.accepted} OK / {r.production.rejected} X</span>
                  <span style={{ flex: 1 }} />
                  <BtnSmall t={t} label="CSV" onClick={() => onExportCsv(r)} />
                  <BtnSmall t={t} label="JSON" onClick={() => onExportJson(r)} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: col }} />
                </div>
              );
            })}
          </div>
        )}
      </ScadaSectionCard>
    </div>
  );
}

function WaitingScreen({ t, language }: { t: ScadaTokens; language: ScadaLanguage }) {
  return (
    <div style={{ background: t.surface, border: `1px dashed ${t.sim}`, borderRadius: 18, padding: '42px 30px', textAlign: 'center', boxShadow: t.shadow }}>
      <div style={{ fontSize: 20, fontWeight: 850, color: t.sim, marginBottom: 10 }}>{tr(language, 'waitingForCell')}</div>
      <div style={{ fontSize: 13.5, color: t.muted, maxWidth: 560, margin: '0 auto', lineHeight: 1.55 }}>{tr(language, 'waitingBody')}</div>
    </div>
  );
}

function Segmented({ t, value, items, onChange }: { t: ScadaTokens; value: string; items: { id: string; label: string }[]; onChange: (id: string) => void }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: t.surfaceSoft, border: `1px solid ${t.border}`, borderRadius: 10, padding: 2 }}>
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button key={item.id} onClick={() => onChange(item.id)} style={{
            minHeight: 30,
            background: active ? t.accent : 'transparent',
            color: active ? (t.mode === 'light' ? '#ffffff' : '#06121f') : t.muted,
            border: 'none',
            borderRadius: 8,
            padding: '5px 10px',
            fontSize: 10.5,
            fontWeight: 750,
            letterSpacing: 0,
            cursor: 'pointer',
            fontFamily: MONO,
            transition: 'background 160ms, color 160ms',
          }}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function InfoCard({ t, label, value, color, small }: { t: ScadaTokens; label: string; value: string; color: string; small?: boolean }) {
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '12px 14px', boxShadow: t.shadow }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, fontWeight: 750 }}>{label}</div>
      <div style={{ fontSize: small ? 13 : 18, fontWeight: 850, fontFamily: MONO, color, marginTop: 5, wordBreak: 'break-word', lineHeight: 1.15 }}>{value}</div>
    </div>
  );
}

function Kpi({ t, label, value, color, small }: { t: ScadaTokens; label: string; value: string; color: string; small?: boolean }) {
  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: '14px 16px', boxShadow: t.shadow }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase', color: t.muted, fontWeight: 750 }}>{label}</div>
      <div style={{ fontSize: small ? 15 : 24, fontWeight: 850, fontFamily: MONO, color, marginTop: 6, lineHeight: 1.1, wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}

function KV({ t, k, v, color }: { t: ScadaTokens; k: string; v: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: `1px solid ${t.borderSoft}` }}>
      <span style={{ fontSize: 12, color: t.muted }}>{k}</span>
      <span style={{ fontSize: 12.5, color: color || t.text, fontFamily: MONO, fontWeight: 750 }}>{v}</span>
    </div>
  );
}

function Banner({ t, color, title, text }: { t: ScadaTokens; color: string; title: string; text: string }) {
  return (
    <div style={{ background: `${color}14`, border: `1px solid ${color}55`, borderLeft: `4px solid ${color}`, borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 850, color }}>{title}</div>
      <div style={{ fontSize: 12.5, color: t.muted, marginTop: 3 }}>{text}</div>
    </div>
  );
}

function BtnSmall({ t, label, onClick }: { t: ScadaTokens; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: t.btnBg,
      color: t.btnText,
      border: `1px solid ${t.btnBorder}`,
      borderRadius: 9,
      padding: '6px 12px',
      fontSize: 11.5,
      fontWeight: 750,
      fontFamily: MONO,
      cursor: 'pointer',
      letterSpacing: 0,
      transition: 'background 160ms, border 160ms, color 160ms',
    }}>{label}</button>
  );
}
