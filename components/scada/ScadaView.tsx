// ─────────────────────────────────────────────────────────────────────────────
// ScadaView.tsx — Dashboard SCADA REAL-ONLY (pestaña "SCADA").
//
// Estética: control-room industrial brutalista (dark). Color SÓLO para estado.
// Secciones: Overview · I/O Real · Alarmas & Mant. · Cobot Health · Tendencias.
// IA = drawer "Maintenance Copilot" bajo demanda (no marca resuelto, solo recomienda).
// Layout centrado (max-width 1440, margin auto). 100% aditivo: consume su propio
// motor (useScada); no toca FSM/Celda 3D/cobot/gateway/telemetry.io/OpenAI.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react';
import { useScada } from './useScada';
import { useCobotTelemetry, useAiBackendHealth } from './cobotTelemetrySource';
import { requestAiDiagnosis, localMockDiagnosis } from './aiClient';
import { recoverCollisionsAndErrors } from './cobotRecoveryClient';
import type {
  Alarm, AiDiagnosis, ScadaSnapshot, Severity, Tag, DataSource, IoSignal,
  CobotHealthSnap, MaintItem, AiBackendHealth, MaintLogEntry, ProductionSnap,
} from './scadaTypes';
import { useScadaTheme } from './shared/useScadaTheme';
import { cssVars } from './shared/scadaTheme';
import ScadaThemeToggle from './shared/ScadaThemeToggle';
import ScadaIoPanel from './shared/ScadaIoPanel';
import type { ScadaTileData, SignalQuality } from './shared/ScadaSignalTile';
import { derivePillars } from './ai/pillars';
import PassNoPassBanner from './ai/PassNoPassBanner';
import Scada40Panel from './ai/Scada40Panel';
import CafiWindows from './ai/CafiWindows';

// ── Tokens (industrial · control-room). La paleta estructural usa CSS variables
// (--sc-*) que el root de ScadaView inyecta según el tema (light/dark). Los colores
// semánticos (verde/rojo/ámbar) se mantienen: leen bien en ambos temas. ──
const MONO = '"Space Mono","JetBrains Mono","IBM Plex Mono","Courier New",monospace';
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif';
const C = {
  bg: 'var(--sc-bg)', panel: 'var(--sc-surface)', panel2: 'var(--sc-surface-soft)',
  border: 'var(--sc-border)', borderSoft: 'var(--sc-border-soft)',
  text: 'var(--sc-text)', muted: 'var(--sc-muted)', dim: 'var(--sc-dim)',
};
const SRC: Record<DataSource, string> = { REAL: '#3DCD58', STALE: '#E0A82E', NOT_CONNECTED: '#56697E', CONFIGURED: '#38BDF8', DEMO: '#2DD4BF' };
const SEV: Record<Severity, string> = { INFO: '#38BDF8', WARNING: '#FBBF24', ALARM: '#FB7185', CRITICAL: '#EF4444' };
const SRC_LABEL: Record<DataSource, string> = { REAL: 'REAL', STALE: 'STALE', NOT_CONNECTED: 'NO CONECTADO', CONFIGURED: 'CONFIG', DEMO: 'DEMO' };
const MAXW = 1440;   // contenido centrado en pantallas grandes

// Comentarios de mantenimiento → correo de administración.
//   1) AUTO: POST a /api/scada/notify; el BACKEND envía el correo (la access key vive
//      SOLO en el servidor, env var `mailordo` — nunca en el navegador). Seguro.
//   2) Fallback: si el backend no responde, abre el compositor de Gmail prellenado.
const ADMIN_EMAIL = 'santiagoordonez875@gmail.com';

type EmailResult = { via: 'auto' | 'gmail' | 'none' };

async function sendToAdminEmail(text: string, alarmCode: string | null): Promise<EmailResult> {
  const t = text.trim();
  if (!t || typeof window === 'undefined') return { via: 'none' };
  const subject = `SCADA · Comentario de mantenimiento${alarmCode ? ` [${alarmCode}]` : ''}`;
  const message = `${t}\n\n— Operador · SCADA Celda de Remachado${alarmCode ? `\nAlarma: ${alarmCode}` : ''}`;

  // 1) Auto-envío server-side (la key NO está en el frontend).
  try {
    const res = await fetch('/api/scada/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(8000) : undefined,
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (res.ok && j.ok) return { via: 'auto' };
  } catch { /* cae al fallback de Gmail */ }

  // 2) Fallback: compositor de Gmail prellenado (el operador pulsa enviar).
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(ADMIN_EMAIL)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
  const win = window.open(gmail, '_blank');
  if (win) { try { win.opener = null; } catch { /* noop */ } }
  else { window.location.href = gmail; }
  return { via: 'gmail' };
}

type Section = 'overview' | 'scada40' | 'cafis' | 'io' | 'alarms' | 'cobot' | 'trends';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'scada40', label: 'SCADA 4.0 (AI)' },
  { id: 'cafis', label: 'CAFIs' },
  { id: 'io', label: 'I/O Real' },
  { id: 'alarms', label: 'Alarmas & Mant.' },
  { id: 'cobot', label: 'Cobot Health' },
  { id: 'trends', label: 'Tendencias' },
];

export default function ScadaView() {
  const { tokens: theme } = useScadaTheme();
  const { snapshot, engine, acknowledge, acknowledgeAll, resolve, addComment, confirmCafiCollection } = useScada();
  const cobot = useCobotTelemetry();
  const aiHealth = useAiBackendHealth();
  useEffect(() => { engine.setCobotTelemetry(cobot.telemetry); }, [cobot.telemetry, engine]);
  useEffect(() => { engine.setConnected(cobot.connected); }, [cobot.connected, engine]);
  useEffect(() => { engine.setPlcIo(cobot.io); }, [cobot.io, engine]);
  useEffect(() => { engine.setProduction(cobot.production); }, [cobot.production, engine]);

  const [demo, setDemo] = useState(false);
  useEffect(() => { engine.setDemo(demo); }, [demo, engine]);

  const [section, setSection] = useState<Section>('overview');
  const [ai, setAi] = useState<AiDiagnosis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [showTags, setShowTags] = useState(false);
  // Borrador de comentario del operador a administración (compartido con la IA).
  const [adminDraft, setAdminDraft] = useState('');

  const runAi = async () => {
    setAiOpen(true); setAiLoading(true);
    try { setAi(await requestAiDiagnosis(snapshot)); }
    catch { setAi(localMockDiagnosis(snapshot)); }
    finally { setAiLoading(false); }
  };

  const activeAlarms = snapshot.alarms.filter((a) => a.active);
  // SCADA 4.0 / AI: deriva los 5 pilares + PASS/NO PASS desde el snapshot real.
  const pillars = derivePillars(snapshot);

  return (
    <div style={{ ...cssVars(theme), height: '100%', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text, fontFamily: SANS, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: `1px solid ${C.border}`, background: C.panel2, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.4 }}>SCADA · Celda de Remachado</div>
          <div style={{ fontSize: 10.5, color: C.muted, letterSpacing: 0.4 }}>Real-time cell telemetry · <span style={{ color: SRC.REAL, fontWeight: 700 }}>REAL MODE</span></div>
        </div>
        <PlantPill state={snapshot.overview.plantState} />
        <div style={{ flex: 1 }} />
        <LinkChip label="Cobot" link={snapshot.cobotLink} />
        <LinkChip label="Sistema I/O" link={snapshot.plcLink} />
        <ScadaThemeToggle />
        <DemoToggle on={demo} onToggle={() => setDemo((v) => !v)} />
        <button onClick={runAi} style={primaryBtn} title="Analizar el estado actual con el Maintenance Copilot (OpenAI / mock local)">Analizar con IA</button>
      </div>

      {/* Tabs */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '0 12px', borderBottom: `1px solid ${C.border}`, background: C.panel2 }}>
        {SECTIONS.map((sec) => (
          <button key={sec.id} onClick={() => setSection(sec.id)} style={tabBtn(section === sec.id)}>{sec.label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: C.muted, marginRight: 10 }}>{activeAlarms.length} alarma(s) activa(s)</div>
        <button onClick={() => setShowTags((v) => !v)} style={ghostBtn(showTags)} title="Tabla de tags cruda (modo avanzado / debug)">{showTags ? 'Ocultar tags' : 'Advanced tags'}</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 20 }}>
          <div style={{ maxWidth: MAXW, margin: '0 auto', width: '100%' }}>
            {showTags ? <TagTable tags={snapshot.tags} />
              : section === 'overview' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <PassNoPassBanner status={pillars.status} />
                  <Overview s={snapshot} ai={ai} aiHealth={aiHealth} />
                </div>
              )
              : section === 'scada40' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <PassNoPassBanner status={pillars.status} />
                  <Scada40Panel pillars={pillars} />
                </div>
              )
              : section === 'cafis' ? <CafiWindows cafis={snapshot.cafis} total={snapshot.overview.cafiTotal} accepted={snapshot.overview.cafiAccepted} rejected={snapshot.overview.cafiRejected} inProcess={snapshot.overview.cafiInProcess} mode="real" overCapacity={snapshot.overview.cafiOverCapacity} onConfirmCollection={confirmCafiCollection} />
              : section === 'io' ? <IoMatrix s={snapshot} />
              : section === 'alarms' ? <AlarmsMaint s={snapshot} acknowledge={acknowledge} acknowledgeAll={acknowledgeAll} resolve={resolve} addComment={addComment} adminDraft={adminDraft} setAdminDraft={setAdminDraft} />
              : section === 'cobot' ? <CobotHealth c={snapshot.cobot} gatewayUrl={cobot.url} online={cobot.connected} />
              : <Trends s={snapshot} />}
          </div>
        </div>

        {/* AI drawer */}
        {aiOpen && <AiDrawer ai={ai} loading={aiLoading} health={aiHealth} mode={snapshot.mode}
          onClose={() => setAiOpen(false)} onRun={runAi}
          onUseAsMessage={(msg) => { setAdminDraft(msg); setSection('alarms'); }} />}
      </div>
    </div>
  );
}

// ── Overview — 10 métricas esenciales (operativas) ───────────────────────────
// Una métrica solo entra aquí si ayuda a decidir: seguir / detener / revisar /
// llamar mantenimiento. Sin producción/disponibilidad/duty-cycle/temp-conveyor fake.
function tempCol(t: number | null): string {
  if (t === null) return C.dim;
  return t > 70 ? SEV.CRITICAL : t > 60 ? SEV.ALARM : t > 50 ? SEV.WARNING : SRC.REAL;
}
function plantCol(state: string): string {
  return state === 'NOMINAL' ? SRC.REAL : state === 'OFFLINE' ? C.dim
    : state === 'WARNING' ? SEV.WARNING : state === 'CRITICAL' ? SEV.CRITICAL : SEV.ALARM;
}

function Overview({ s, ai, aiHealth }: { s: ScadaSnapshot; ai: AiDiagnosis | null; aiHealth: AiBackendHealth }) {
  const o = s.overview;
  const cb = s.cobot;
  const conv = s.conveyor;

  const metrics: MetricDef[] = [
    { label: '1 · Estado de celda', value: o.plantState, color: plantCol(o.plantState) },
    { label: '2 · Etapa actual', value: o.stage ?? 'N/D', color: o.stage ? C.text : C.dim, text: true,
      sub: o.stage ? (o.stageEstimated ? 'estimado por I/O real' : undefined) : 'sin señal real' },
    { label: '3 · Progreso del ciclo', value: o.cycleStep !== null && o.cycleTotal !== null ? `${o.cycleStep}/${o.cycleTotal}` : 'N/D',
      color: o.cycleStep !== null ? C.text : C.dim, progress: (o.cycleStep !== null && o.cycleTotal) ? o.cycleStep / o.cycleTotal : null,
      sub: o.cycleStep === null ? 'sin señal real' : (o.stageEstimated ? 'estimado por I/O real' : undefined) },
    { label: '4 · Alarmas activas', value: String(o.activeAlarms), color: o.activeAlarms ? (o.worstSeverity ? SEV[o.worstSeverity] : SEV.ALARM) : SRC.REAL,
      sub: o.activeAlarms ? `peor: ${o.worstSeverity}` : 'ninguna' },
    { label: '5 · Tiempo de ciclo', value: o.cycleTimeS !== null ? `${o.cycleTimeS}s` : 'N/D', color: o.cycleTimeS !== null ? C.text : C.dim,
      sub: o.cycleTimeS === null ? 'sin señal real' : (o.cycleRunning ? 'en curso' : 'último ciclo') },
    { label: '6 · Prom. 10 ciclos', value: o.avgCycleTimeS !== null ? `${o.avgCycleTimeS}s` : '—', color: o.avgCycleTimeS !== null ? C.text : C.dim,
      sub: o.avgCycleTimeS === null ? 'sin historial' : `${s.history.cycleTimes.length} ciclo${s.history.cycleTimes.length === 1 ? '' : 's'}` },
    { label: '7 · Conveyor ON-time', value: conv.signalAvailable ? `${conv.onTimeS}s` : 'NO CONEC.', text: !conv.signalAvailable,
      color: !conv.signalAvailable ? C.dim : conv.warning === 'ALARM' ? SEV.ALARM : conv.warning === 'WARNING' ? SEV.WARNING : SRC.REAL,
      sub: conv.signalAvailable ? undefined : 'motor signal' },
    { label: '8 · Joint máx. temp', value: cb.maxJointTempC !== null ? `${cb.maxJointTempC}°C` : 'N/D', color: tempCol(cb.maxJointTempC),
      sub: cb.maxJointTempJoint !== null ? `J${cb.maxJointTempJoint}` : undefined },
    { label: '9 · Controlador', value: cb.controllerTempC !== null ? `${cb.controllerTempC}°C` : 'N/D', color: tempCol(cb.controllerTempC) },
    { label: '10 · Sistema I/O', value: SRC_LABEL[s.plcLink.state], color: SRC[s.plcLink.state], text: true,
      sub: s.plcLink.ageS !== null ? `${s.plcLink.ageS}s` : 'sin frame' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 1, background: C.border, border: `1px solid ${C.border}` }}>
        {metrics.map((m) => <MetricTile key={m.label} m={m} />)}
      </div>

      {o.stageEstimated && s.mode === 'REAL' && (
        <Banner color={C.dim} text="Etapa, progreso y tiempo de ciclo estimados por las señales reales de I/O (el gateway aún no publica un bloque FSM)." />
      )}

      {o.conveyorWarning && <Banner color={conv.warning === 'ALARM' ? SEV.ALARM : SEV.WARNING} text={o.conveyorWarning} />}

      <ProductionPanel p={s.production} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
        <Panel title="Comunicaciones">
          <KV k="Cobot WS" v={<SourceBadge src={s.cobotLink.state} />} sub={s.cobotLink.ageS !== null ? `último frame: ${s.cobotLink.ageS}s` : 'sin frame'} />
          <KV k="Sistema I/O" v={<SourceBadge src={s.plcLink.state} />} sub={s.plcLink.ageS !== null ? `último frame: ${s.plcLink.ageS}s` : 'esperando telemetry.io'} />
          <KV k="Backend IA" v={<AiHealthBadge h={aiHealth} />} />
          <KV k="Modo" v={<SourceBadge src={s.mode === 'DEMO' ? 'DEMO' : 'REAL'} />} />
        </Panel>
        <Panel title={`Alarmas activas (${o.activeAlarms})`}>
          {s.alarms.filter((a) => a.active).slice(0, 6).map((a) => <AlarmRow key={a.id} a={a} />)}
          {o.activeAlarms === 0 && <Empty>Sin alarmas activas.</Empty>}
        </Panel>
        <Panel title="Último diagnóstico IA">
          {ai ? (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <SeverityBadge sev={ai.severity} />
                <Chip color={ai.source === 'AI' ? SRC.REAL : SRC.DEMO} text={ai.source === 'AI' ? 'OpenAI' : 'Mock local'} />
                <Chip color={ai.canKeepOperating ? SRC.REAL : SEV.CRITICAL} text={ai.canKeepOperating ? 'PUEDE OPERAR' : 'DETENER'} />
              </div>
              <div style={{ fontSize: 12, color: C.text }}>{ai.probableFault}</div>
            </div>
          ) : <Empty>Sin diagnóstico generado todavía. Pulsa “Analizar con IA”.</Empty>}
        </Panel>
      </div>

      {!o.plcConnected && s.mode === 'REAL' && (
        <Banner color={C.dim} text="Sistema I/O no conectado — esperando telemetry.io del gateway. Conveyor, mesa, gripper, fixtures y cámara se mostrarán cuando el gateway publique el bloque io." />
      )}
    </div>
  );
}

// Tile de métrica del Overview (valor grande + sub + barra opcional de progreso).
interface MetricDef { label: string; value: string; color: string; sub?: string; text?: boolean; progress?: number | null }
function MetricTile({ m }: { m: MetricDef }) {
  return (
    <div style={{ background: C.panel, padding: '14px 16px', display: 'flex', flexDirection: 'column', minHeight: 78 }}>
      <div style={{ ...labelStyle, fontSize: 9 }}>{m.label}</div>
      <div style={{ fontSize: m.text ? 16 : 26, fontWeight: 700, fontFamily: MONO, color: m.color, marginTop: 6, lineHeight: 1.05, wordBreak: 'break-word' }}>{m.value}</div>
      {typeof m.progress === 'number' && (
        <div style={{ height: 4, background: C.borderSoft, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.round(Math.max(0, Math.min(1, m.progress)) * 100)}%`, background: SRC.REAL }} />
        </div>
      )}
      {m.sub && <div style={{ fontSize: 9.5, color: C.dim, marginTop: m.progress != null ? 4 : 6 }}>{m.sub}</div>}
    </div>
  );
}

// Producción REAL del gateway (COUNT.* + CAMERA_STATUS del bloque hmi). Real-only:
// si no llega, muestra N/A + NO CONECTADO; en DEMO sale marcado DEMO.
function ProductionPanel({ p }: { p: ProductionSnap }) {
  const stat = (label: string, value: string, color: string) => (
    <div style={{ background: C.panel2, padding: '12px 14px', border: `1px solid ${C.borderSoft}`, borderRadius: 2, flex: 1, minWidth: 120 }}>
      <div style={{ ...labelStyle, fontSize: 9 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: MONO, color, marginTop: 4, lineHeight: 1 }}>{value}</div>
    </div>
  );
  const na = (v: number | null) => (v === null ? 'N/A' : String(v));
  const col = p.available ? C.text : C.dim;
  return (
    <Panel title="Producción (real · gateway)">
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {stat('Total', na(p.total), col)}
        {stat('Aceptados', na(p.accepted), p.accepted !== null ? SRC.REAL : C.dim)}
        {stat('Rechazados', na(p.rejected), p.rejected ? SEV.ALARM : p.rejected === 0 ? SRC.REAL : C.dim)}
        {stat('Yield', p.yieldPct !== null ? `${p.yieldPct}%` : 'N/A', p.yieldPct === null ? C.dim : p.yieldPct >= 95 ? SRC.REAL : p.yieldPct >= 85 ? SEV.WARNING : SEV.ALARM)}
        <div style={{ background: C.panel2, padding: '12px 14px', border: `1px solid ${C.borderSoft}`, borderRadius: 2, flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div style={{ ...labelStyle, fontSize: 9 }}>Cámara</div>
          <div style={{ marginTop: 6 }}><CameraChip status={p.cameraStatus} /></div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <SourceBadge src={p.source} />
        <span style={{ fontSize: 9.5, color: C.dim }}>
          {p.available ? 'Contadores y estado de cámara del pipeline real del gateway (COUNT.* / CAMERA_STATUS).'
            : 'Esperando bloque hmi del gateway (COUNT.* / CAMERA_STATUS).'}
        </span>
      </div>
    </Panel>
  );
}
function CameraChip({ status }: { status: 'READY' | 'PASS' | 'FAIL' | null }) {
  if (status === null) return <Chip color={C.dim} text="N/A" />;
  const col = status === 'PASS' ? SRC.REAL : status === 'FAIL' ? SEV.ALARM : SRC.CONFIGURED;
  return <Chip color={col} text={status} />;
}

// ── I/O Real (matriz) ─────────────────────────────────────────────────────────
function ioToTile(r: IoSignal): ScadaTileData {
  const quality: SignalQuality = r.source === 'STALE' ? 'stale'
    : r.source === 'NOT_CONNECTED' ? 'not_connected'
    : r.value === null ? 'null' : 'real';
  return {
    label: r.label,
    signalKey: r.key,                    // key canónica intacta (debug)
    value: r.value,
    kind: r.kind === 'OUTPUT' ? 'output' : 'input',
    quality,
  };
}

function IoMatrix({ s }: { s: ScadaSnapshot }) {
  const connected = s.io.filter((x) => x.source !== 'NOT_CONNECTED').length;
  const tiles = s.io.map(ioToTile);
  return (
    <ScadaIoPanel
      tiles={tiles}
      mode="real"
      title="I/O Real — Sistema & Cobot"
      subtitle={connected > 0
        ? `${connected} señal(es) en vivo desde telemetry.io / cobot. Las no conectadas se muestran en gris.`
        : 'Sistema I/O no conectado. Agregar telemetry.io al gateway de la RPi para activar señales reales.'}
    />
  );
}

// ── Alarmas & Mantenimiento ────────────────────────────────────────────────────
function AlarmsMaint({ s, acknowledge, acknowledgeAll, resolve, addComment, adminDraft, setAdminDraft }: {
  s: ScadaSnapshot;
  acknowledge: (id: string) => void;
  acknowledgeAll: () => void;
  resolve: (id: string) => { ok: boolean; reason?: string };
  addComment: (text: string, alarmCode?: string | null) => void;
  adminDraft: string;
  setAdminDraft: (v: string) => void;
}) {
  const counts: Record<Severity, number> = { INFO: 0, WARNING: 0, ALARM: 0, CRITICAL: 0 };
  s.alarms.forEach((a) => { if (a.active) counts[a.severity]++; });
  const m = s.maintenance;
  const pending = m.checklist.filter((c) => !c.done);

  const [openComment, setOpenComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [resolveErr, setResolveErr] = useState<{ id: string; msg: string } | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);

  const fireEmail = async (txt: string, code: string | null) => {
    setEmailStatus('Enviando correo…');
    const r = await sendToAdminEmail(txt, code);
    setEmailStatus(r.via === 'auto' ? '✓ Enviado por correo a administración'
      : r.via === 'gmail' ? 'Se abrió Gmail para enviarlo' : null);
    window.setTimeout(() => setEmailStatus(null), 5000);
  };
  const doResolve = (a: Alarm) => {
    const r = resolve(a.id);
    if (!r.ok) setResolveErr({ id: a.id, msg: r.reason ?? 'No se puede resolver.' });
    else setResolveErr(null);
  };
  const sendComment = (alarmCode: string | null) => {
    const txt = commentDraft.trim();
    if (!txt) return;
    addComment(txt, alarmCode);          // historial local del SCADA
    void fireEmail(txt, alarmCode);      // correo a administración (auto o Gmail)
    setCommentDraft(''); setOpenComment(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['CRITICAL', 'ALARM', 'WARNING', 'INFO'] as Severity[]).map((sv) => (
          <Chip key={sv} color={SEV[sv]} text={`${sv} · ${counts[sv]}`} />
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={acknowledgeAll} style={ghostBtn(false)}>Reconocer todas</button>
      </div>

      <Panel title={`Alarmas (${s.alarms.length})`}>
        <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 110px 110px 200px', gap: 6, ...labelStyle, padding: '0 0 8px', borderBottom: `1px solid ${C.border}` }}>
          <div>Severidad</div><div>Código · Mensaje</div><div>Estado</div><div>Estación · Dur</div><div>Acciones</div>
        </div>
        {s.alarms.length === 0 && <Empty>Sin alarmas registradas.</Empty>}
        {s.alarms.map((a) => (
          <div key={a.id} style={{ borderBottom: `1px solid ${C.borderSoft}`, padding: '7px 0', opacity: a.status === 'RESOLVED' ? 0.5 : 1 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 110px 110px 200px', gap: 6, alignItems: 'center' }}>
              <div><SeverityBadge sev={a.severity} /></div>
              <div style={{ fontSize: 11 }}>
                <span style={{ fontFamily: MONO, color: C.muted }}>{a.code}</span> · {a.message}
                {a.demo && <span style={{ fontSize: 9, color: SRC.DEMO }}> [DEMO]</span>}
              </div>
              <div><StatusBadge a={a} /></div>
              <div style={{ fontSize: 10, color: C.muted }}>{a.station}<div style={{ fontFamily: MONO }}>{a.active ? `${Math.round(a.durationS)}s` : 'inactiva'}</div></div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button onClick={() => acknowledge(a.id)} disabled={a.status !== 'ACTIVE'} style={miniBtn(a.status !== 'ACTIVE')}>Reconocer</button>
                <button onClick={() => doResolve(a)} disabled={a.active || a.status === 'RESOLVED'}
                  title={a.active ? 'La condición sigue presente en la lectura en tiempo real' : 'Marcar como resuelta'}
                  style={miniBtn(a.active || a.status === 'RESOLVED', SRC.REAL)}>Resuelta</button>
                <button onClick={() => { setOpenComment(openComment === a.id ? null : a.id); setCommentDraft(a.operatorComment ?? ''); }} style={miniBtn(false)}>Comentar</button>
              </div>
            </div>
            {resolveErr && resolveErr.id === a.id && (
              <div style={{ fontSize: 10, color: SEV.WARNING, marginTop: 4, fontFamily: MONO }}>⛔ {resolveErr.msg}</div>
            )}
            {a.operatorComment && (
              <div style={{ fontSize: 10.5, color: C.muted, marginTop: 4 }}>💬 {a.operatorComment}</div>
            )}
            {openComment === a.id && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <textarea value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} rows={2}
                  placeholder="Comentario del operador (p. ej. se revisó y se corrigió la falla)…"
                  style={inputStyle} />
                <button onClick={() => sendComment(a.code)} disabled={!commentDraft.trim()} style={{ ...primaryBtn, alignSelf: 'stretch' }}>Enviar a administración</button>
              </div>
            )}
          </div>
        ))}
      </Panel>

      {/* Comentario general del operador a administración */}
      <Panel title="Comentario del operador → administración">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea value={adminDraft} onChange={(e) => setAdminDraft(e.target.value)} rows={3}
            placeholder="Escribe un comentario para administración…" style={inputStyle} />
          <button onClick={() => { const txt = adminDraft.trim(); if (!txt) return; addComment(txt, null); void fireEmail(txt, null); setAdminDraft(''); }} disabled={!adminDraft.trim()}
            style={{ ...primaryBtn, alignSelf: 'stretch' }}>Enviar a administración</button>
        </div>
        {emailStatus && <div style={{ fontSize: 10.5, color: SRC.REAL, marginTop: 6, fontFamily: MONO }}>{emailStatus}</div>}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>
          Se envía <b>automáticamente</b> por correo a <b>{ADMIN_EMAIL}</b> vía el servidor (key <code>mailordo</code>, fuera del navegador) y se guarda en el historial local. Si el servidor no responde, abre el compositor de Gmail.
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 14 }}>
        <Panel title={`Historial de mantenimiento (${s.maintenanceLog.length})`}>
          {s.maintenanceLog.length === 0 && <Empty>Sin comentarios ni acciones registradas todavía.</Empty>}
          {s.maintenanceLog.slice(0, 12).map((e) => <LogRow key={e.id} e={e} now={s.ts} />)}
        </Panel>
        <Panel title="Mantenimiento (datos reales)">
          {m.items.length === 0 && <Empty>Sin datos de mantenimiento en vivo. Conecta telemetry.io para poblar esta sección.</Empty>}
          {m.items.map((it) => <MaintRow key={it.label} it={it} />)}
          {pending.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Integraciones pendientes ({pending.length})</div>
              {m.checklist.map((c) => (
                <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <span style={{ width: 13, height: 13, border: `1px solid ${c.done ? SRC.REAL : C.dim}`, borderRadius: 2, color: SRC.REAL, fontSize: 9, textAlign: 'center', lineHeight: '12px' }}>{c.done ? '✓' : ''}</span>
                  <span style={{ fontSize: 10.5, color: c.done ? C.muted : C.text, textDecoration: c.done ? 'line-through' : 'none' }}>{c.label}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatusBadge({ a }: { a: Alarm }) {
  const map = { ACTIVE: SEV.ALARM, ACKNOWLEDGED: SEV.WARNING, RESOLVED: SRC.REAL } as const;
  const label = a.status === 'ACTIVE' ? (a.active ? 'ACTIVA' : 'PEND. RESOLVER')
    : a.status === 'ACKNOWLEDGED' ? (a.active ? 'RECONOCIDA' : 'RECON. (inactiva)')
    : 'RESUELTA';
  return <Chip color={map[a.status]} text={label} />;
}

function LogRow({ e, now }: { e: MaintLogEntry; now: number }) {
  const col = e.kind === 'RESOLVE' ? SRC.REAL : e.kind === 'ACK' ? SEV.WARNING : SRC.CONFIGURED;
  const ago = Math.max(0, Math.round(now - e.at));
  return (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Chip color={col} text={e.kind} />
        <span style={{ fontSize: 9.5, color: C.dim, fontFamily: MONO }}>{e.by} · hace {ago}s{e.alarmCode ? ` · ${e.alarmCode}` : ''}</span>
      </div>
      <div style={{ fontSize: 11, color: C.text, marginTop: 2 }}>{e.text}</div>
    </div>
  );
}

function MaintRow({ it }: { it: MaintItem }) {
  const col = it.status === 'ALARM' ? SEV.ALARM : it.status === 'WARNING' ? SEV.WARNING : it.status === 'NA' ? C.dim : SRC.REAL;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <span style={{ fontSize: 11.5, color: C.muted }}>{it.label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 13, color: col }}>{it.value}</span>
        <SourceBadge src={it.source} />
      </span>
    </div>
  );
}

// Recuperación del cobot: reinicia colisiones y errores (POST collision_recover +
// clear_error al gateway). Única acción del SCADA que envía comandos → exige confirmar.
function CobotRecovery({ url, online, demo, faulted }: { url: string; online: boolean; demo: boolean; faulted: boolean }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const blocked = !online || demo;

  const run = async () => {
    setBusy(true); setArmed(false); setResult(null);
    const r = await recoverCollisionsAndErrors(url);
    setResult({ ok: r.ok, msg: r.message });
    setBusy(false);
    window.setTimeout(() => setResult(null), 9000);
  };

  return (
    <Panel title="Recuperación del cobot">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 11.5, color: C.text }}>Reiniciar colisiones y errores</div>
          <div style={{ fontSize: 9.5, color: C.dim, marginTop: 2 }}>
            Envía <code>collision_recover</code> + <code>clear_error</code> al gateway. No mueve el robot; limpia el estado de falla.
          </div>
        </div>
        {faulted && !demo && <Chip color={SEV.ALARM} text="FALLA ACTIVA" />}
        {!armed ? (
          <button onClick={() => { setResult(null); setArmed(true); }} disabled={blocked || busy}
            title={demo ? 'No se envía en modo DEMO' : !online ? 'Cobot no conectado' : 'Reiniciar colisiones y errores'}
            style={miniBtn(blocked || busy, SEV.WARNING)}>
            {busy ? 'Enviando…' : 'Reiniciar colisiones/errores'}
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10.5, color: SEV.WARNING, fontFamily: MONO }}>¿Confirmar?</span>
            <button onClick={run} style={miniBtn(false, SEV.ALARM)}>Sí, reiniciar</button>
            <button onClick={() => setArmed(false)} style={miniBtn(false)}>Cancelar</button>
          </span>
        )}
      </div>
      {demo && <div style={{ fontSize: 9.5, color: SRC.DEMO, marginTop: 8, fontFamily: MONO }}>Modo DEMO: la acción está deshabilitada (no se envía nada real).</div>}
      {result && (
        <div style={{ fontSize: 10.5, marginTop: 8, fontFamily: MONO, color: result.ok ? SRC.REAL : SEV.ALARM }}>
          {result.ok ? '✓ ' : '⛔ '}{result.msg}
        </div>
      )}
    </Panel>
  );
}

// ── Cobot Health ────────────────────────────────────────────────────────────────
function CobotHealth({ c, gatewayUrl, online }: { c: CobotHealthSnap; gatewayUrl: string; online: boolean }) {
  if (!c.available) return <Banner color={C.dim} text="Cobot no conectado — sin telemetría del gateway (/ws/cobot). Conecta el robot para ver Cobot Health en vivo." />;
  const out = (t: number) => t > 70 ? SEV.CRITICAL : t > 60 ? SEV.ALARM : t > 50 ? SEV.WARNING : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1, background: C.border, border: `1px solid ${C.border}` }}>
        <Kpi label="Joint máx. temp" value={c.maxJointTempC !== null ? `${c.maxJointTempC}°C` : 'N/D'} color={c.maxJointTempC !== null && out(c.maxJointTempC) ? out(c.maxJointTempC)! : SRC.REAL} />
        <Kpi label="Controlador" value={c.controllerTempC !== null ? `${c.controllerTempC}°C` : 'N/D'} color={SRC.CONFIGURED} />
        <Kpi label="Speed magnif." value={c.speedMagnificationPct !== null ? `${c.speedMagnificationPct}%` : 'N/D'} color={C.text} />
        <Kpi label="Corriente media" value={c.avgCurrentA !== null ? `${c.avgCurrentA} A` : 'N/D'} color={C.text} />
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Chip color={c.flags.enabled ? SRC.REAL : C.dim} text={`enabled: ${c.flags.enabled ? 'sí' : 'no'}`} />
        <Chip color={c.flags.powerOn ? SRC.REAL : C.dim} text={`power: ${c.flags.powerOn ? 'on' : 'off'}`} />
        <Chip color={c.flags.moving ? SRC.CONFIGURED : C.dim} text={`moving: ${c.flags.moving ? 'sí' : 'no'}`} />
        <Chip color={c.flags.estop ? SEV.CRITICAL : C.dim} text={`E-stop: ${c.flags.estop ? 'ACTIVO' : 'no'}`} />
        <Chip color={c.flags.protectiveStop ? SEV.ALARM : C.dim} text={`prot.stop: ${c.flags.protectiveStop ? 'sí' : 'no'}`} />
        <Chip color={c.flags.collision ? SEV.ALARM : C.dim} text={`collision: ${c.flags.collision ? 'sí' : 'no'}`} />
        <Chip color={c.flags.softLimit ? SEV.WARNING : C.dim} text={`soft limit: ${c.flags.softLimit ? 'sí' : 'no'}`} />
        <Chip color={c.flags.motionErr ? SEV.ALARM : C.dim} text={`motion err: ${c.flags.motionErr}`} />
      </div>

      <CobotRecovery
        url={gatewayUrl}
        online={online}
        demo={c.source === 'DEMO'}
        faulted={c.flags.collision || c.flags.motionErr !== 0 || c.flags.protectiveStop}
      />

      <Panel title="Articulaciones (J1–J6)">
        <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 6, ...labelStyle, padding: '0 0 8px', borderBottom: `1px solid ${C.border}` }}>
          <div>Joint</div><div>Ángulo</div><div>Temp</div><div>Corriente</div>
        </div>
        {c.joints.map((j) => {
          const oc = out(j.tempC);
          return (
            <div key={j.index} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 6, alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.borderSoft}`, background: oc ? `${oc}11` : 'transparent' }}>
              <div style={{ fontFamily: MONO, color: C.muted }}>J{j.index}</div>
              <div style={{ fontFamily: MONO }}>{j.angleDeg}°</div>
              <div style={{ fontFamily: MONO, color: oc ?? C.text, fontWeight: oc ? 700 : 400 }}>{j.tempC}°C</div>
              <div style={{ fontFamily: MONO }}>{j.currentA} A</div>
            </div>
          );
        })}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Panel title="TCP">
          {c.tcp ? <>
            <KV k="X / Y / Z" v={`${c.tcp.xMm} / ${c.tcp.yMm} / ${c.tcp.zMm} mm`} />
            <KV k="RX / RY / RZ" v={`${c.tcp.rxDeg} / ${c.tcp.ryDeg} / ${c.tcp.rzDeg}°`} />
          </> : <Empty>N/D</Empty>}
        </Panel>
        <Panel title="Force / Torque (end-effector)">
          {c.ft ? <>
            <KV k="Fx / Fy / Fz" v={`${c.ft.fxN} / ${c.ft.fyN} / ${c.ft.fzN} N`} />
            <KV k="Tx / Ty / Tz" v={`${c.ft.txNm} / ${c.ft.tyNm} / ${c.ft.tzNm} Nm`} />
          </> : <Empty>N/D</Empty>}
        </Panel>
      </div>
    </div>
  );
}

// ── Tendencias (gráficas) ──────────────────────────────────────────────────────
function Trends({ s }: { s: ScadaSnapshot }) {
  const h = s.history;
  // Joints: line si hay historial, si no bar del estado actual.
  const jointSeries = h.jointTemps.length >= 2
    ? [0, 1, 2, 3, 4, 5].map((j) => ({ name: `J${j + 1}`, color: JOINT_COLORS[j], points: h.jointTemps.map((p) => p.temps[j] ?? 0) }))
    : null;
  const jointBars = s.cobot.available ? s.cobot.joints.map((j) => ({ label: `J${j.index}`, value: j.tempC })) : [];
  const ctrlSeries = h.controllerTemps.length >= 2 ? [{ name: 'Ctrl', color: SRC.CONFIGURED, points: h.controllerTemps.map((p) => p.v) }] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <Panel title="Conveyor ON-time — en vivo">
        {!s.conveyor.signalAvailable ? <Empty>Conveyor motor signal not connected.</Empty>
          : h.conveyorOnTime.length >= 2
            ? <LineChart series={[{ name: 'on-time', color: SRC.CONFIGURED, points: h.conveyorOnTime.map((p) => p.v) }]} unit="s" refs={[{ v: 60, color: SEV.WARNING }, { v: 120, color: SEV.ALARM }]} />
            : <div style={{ fontSize: 26, fontFamily: MONO, color: SRC.CONFIGURED }}>{s.conveyor.onTimeS}s <span style={{ fontSize: 11, color: C.dim }}>(acumulando…)</span></div>}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>Sube mientras el motor está ON; vuelve a 0 al apagar. Ámbar &gt;60s · rojo &gt;120s.</div>
      </Panel>

      <Panel title="Conveyor ON-time — últimos 10 encendidos">
        {!s.conveyor.signalAvailable ? <Empty>Conveyor motor signal not connected.</Empty>
          : h.conveyorOnDurations.length === 0 ? <Empty>Sin historial real todavía.</Empty>
            : <BarChart values={h.conveyorOnDurations} unit="s" warnAt={60} alarmAt={120} labels={h.conveyorOnDurations.map((_, i) => `#${i + 1}`)} />}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>Cada barra = duración de un encendido continuo. Ámbar &gt;60s · rojo &gt;120s.</div>
      </Panel>

      <Panel title="Tiempo de ciclo — últimos 10">
        {h.cycleTimes.length === 0
          ? <Empty>Sin historial real todavía. {s.mode === 'REAL' ? 'SCADA no recibe el ciclo de la FSM (real-only).' : ''}</Empty>
          : <BarChart values={h.cycleTimes} unit="s" labels={h.cycleTimes.map((_, i) => `#${i + 1}`)} />}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>Duración de cada ciclo completo. {s.overview.avgCycleTimeS !== null ? `Promedio: ${s.overview.avgCycleTimeS}s.` : ''}</div>
      </Panel>

      <Panel title="Temperaturas de joints J1–J6">
        {jointSeries ? <LineChart series={jointSeries} unit="°C" refs={[{ v: 50, color: SEV.WARNING }, { v: 60, color: SEV.ALARM }, { v: 70, color: SEV.CRITICAL }]} />
          : jointBars.length ? <BarChart values={jointBars.map((b) => b.value)} labels={jointBars.map((b) => b.label)} unit="°C" warnAt={50} alarmAt={60} />
            : <Empty>Cobot no conectado — sin temperaturas de joints.</Empty>}
        {jointSeries && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>{jointSeries.map((sx) => <span key={sx.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: C.muted }}><span style={{ width: 10, height: 2, background: sx.color, display: 'inline-block' }} />{sx.name}</span>)}</div>}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>Umbrales: warning 50°C · alarm 60°C · critical 70°C.</div>
      </Panel>

      <Panel title="Temperatura del controlador">
        {ctrlSeries ? <LineChart series={ctrlSeries} unit="°C" refs={[{ v: 50, color: SEV.WARNING }, { v: 60, color: SEV.ALARM }]} />
          : s.cobot.controllerTempC !== null ? <div style={{ fontSize: 26, fontFamily: MONO, color: SRC.CONFIGURED }}>{s.cobot.controllerTempC}°C <span style={{ fontSize: 11, color: C.dim }}>(acumulando historial…)</span></div>
            : <Empty>Cobot no conectado — sin temperatura del controlador.</Empty>}
        <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>Últimos {h.controllerTemps.length} puntos (~{h.controllerTemps.length}s). Umbrales: 50°C / 60°C.</div>
      </Panel>
    </div>
  );
}

const JOINT_COLORS = ['#3DCD58', '#38BDF8', '#FBBF24', '#FB7185', '#A78BFA', '#2DD4BF'];

// Bar chart SVG ligero (sin dependencias).
function BarChart({ values, labels, unit, warnAt, alarmAt }: { values: number[]; labels?: string[]; unit: string; warnAt?: number; alarmAt?: number }) {
  const W = 760, H = 150, padB = 22, padT = 16, padL = 4;
  const max = Math.max(...values, alarmAt ?? 0, 1) * 1.1;
  const n = values.length;
  const bw = (W - padL * 2) / n;
  const col = (v: number) => (alarmAt && v >= alarmAt) ? SEV.ALARM : (warnAt && v >= warnAt) ? SEV.WARNING : SRC.REAL;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {warnAt && warnAt < max && <line x1={padL} x2={W - padL} y1={H - padB - (warnAt / max) * (H - padB - padT)} y2={H - padB - (warnAt / max) * (H - padB - padT)} stroke={SEV.WARNING} strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />}
      {alarmAt && alarmAt < max && <line x1={padL} x2={W - padL} y1={H - padB - (alarmAt / max) * (H - padB - padT)} y2={H - padB - (alarmAt / max) * (H - padB - padT)} stroke={SEV.ALARM} strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />}
      {values.map((v, i) => {
        const bh = (v / max) * (H - padB - padT);
        const x = padL + i * bw + bw * 0.15, y = H - padB - bh;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw * 0.7} height={bh} fill={col(v)} rx={1} />
            <text x={x + bw * 0.35} y={y - 4} fill={C.text} fontSize={10} fontFamily={MONO} textAnchor="middle">{v}</text>
            <text x={x + bw * 0.35} y={H - 7} fill={C.dim} fontSize={9} fontFamily={MONO} textAnchor="middle">{labels?.[i] ?? i + 1}</text>
          </g>
        );
      })}
      <text x={W - padL} y={11} fill={C.dim} fontSize={9} fontFamily={MONO} textAnchor="end">{unit}</text>
    </svg>
  );
}

// Curva suave (Catmull-Rom → Bézier) para líneas fluidas.
function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length < 3) return 'M ' + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ');
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

// Line chart SVG ligero: líneas finas (1px), curvas suaves, grid + ejes + umbrales.
function LineChart({ series, unit, refs, height = 175 }: { series: { name: string; color: string; points: number[] }[]; unit: string; refs?: { v: number; color: string }[]; height?: number }) {
  const W = 760, H = height, padB = 18, padT = 12, padL = 34, padR = 12;
  const allVals = series.flatMap((sx) => sx.points).concat((refs ?? []).map((r) => r.v));
  let maxV = Math.max(...allVals, 1), minV = Math.min(...allVals, 0);
  const span = (maxV - minV) || 1;
  maxV += span * 0.08; minV = Math.max(0, minV - span * 0.08);
  const range = (maxV - minV) || 1;
  const n = Math.max(...series.map((sx) => sx.points.length), 2);
  const xOf = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const yOf = (v: number) => H - padB - ((v - minV) / range) * (H - padB - padT);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => minV + f * range);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {grid.map((gv, k) => (
        <g key={`g${k}`}>
          <line x1={padL} x2={W - padR} y1={yOf(gv)} y2={yOf(gv)} stroke={C.borderSoft} strokeWidth={0.5} />
          <text x={padL - 4} y={yOf(gv) + 3} fill={C.dim} fontSize={8.5} fontFamily={MONO} textAnchor="end">{gv.toFixed(0)}</text>
        </g>
      ))}
      {(refs ?? []).map((r, k) => (
        <g key={`r${k}`}>
          <line x1={padL} x2={W - padR} y1={yOf(r.v)} y2={yOf(r.v)} stroke={r.color} strokeDasharray="3 4" strokeWidth={0.8} opacity={0.55} />
          <text x={W - padR} y={yOf(r.v) - 2} fill={r.color} fontSize={8.5} fontFamily={MONO} textAnchor="end">{r.v}{unit}</text>
        </g>
      ))}
      {series.map((sx) => {
        const pts = sx.points.map((v, i) => [xOf(i), yOf(v)] as [number, number]);
        const last = pts[pts.length - 1];
        return (
          <g key={sx.name}>
            <path d={smoothPath(pts)} fill="none" stroke={sx.color} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
            {last && <circle cx={last[0]} cy={last[1]} r={1.8} fill={sx.color} />}
          </g>
        );
      })}
    </svg>
  );
}

// ── Tag table (Advanced / debug) ────────────────────────────────────────────────
function TagTable({ tags }: { tags: Tag[] }) {
  const [q, setQ] = useState('');
  const f = tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Panel title={`Advanced tags — modo debug (${f.length}/${tags.length})`}>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 10 }}>Vista cruda de todas las señales CON dato real/demo. Solo para diagnóstico técnico.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar tags…"
        style={{ width: '100%', maxWidth: 320, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 2, padding: '6px 10px', fontFamily: MONO, fontSize: 11, marginBottom: 10, boxSizing: 'border-box' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 100px', gap: 6, ...labelStyle, padding: '0 0 8px', borderBottom: `1px solid ${C.border}` }}>
        <div>Tag</div><div>Valor</div><div>Unidad</div><div>Fuente</div>
      </div>
      <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
        {f.length === 0 && <Empty>Sin tags con dato (todo no conectado).</Empty>}
        {f.map((t) => (
          <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 100px', gap: 6, alignItems: 'center', padding: '5px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>{t.name}</div>
            <div style={{ fontFamily: MONO, fontSize: 11 }}>{fmtVal(t.value)}</div>
            <div style={{ fontSize: 10, color: C.dim }}>{t.unit ?? ''}</div>
            <div><SourceBadge src={t.source} /></div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── AI drawer (Maintenance Copilot) ──────────────────────────────────────────────
function AiDrawer({ ai, loading, health, mode, onClose, onRun, onUseAsMessage }: {
  ai: AiDiagnosis | null; loading: boolean; health: AiBackendHealth; mode: string;
  onClose: () => void; onRun: () => void; onUseAsMessage: (msg: string) => void;
}) {
  return (
    <div style={{ width: 380, flexShrink: 0, borderLeft: `1px solid ${C.border}`, background: C.panel2, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', flex: 1 }}>Maintenance Copilot</div>
        <AiHealthBadge h={health} />
        <button onClick={onClose} style={ghostBtn(false)} aria-label="Cerrar panel IA">✕</button>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {mode === 'DEMO' && <Banner color={SRC.DEMO} text="Snapshot en modo DEMO: la IA sabe que son datos sintéticos, no reales." />}
        {!loading && !ai && (
          <>
            <Empty>Sin diagnóstico generado todavía.</Empty>
            <button onClick={onRun} style={{ ...primaryBtn, width: '100%', padding: '12px 0', fontSize: 13 }}>Analizar estado actual</button>
            <div style={{ fontSize: 9.5, color: C.dim }}>La IA recibe sólo datos reales y marca lo no conectado. Recomienda — no marca resuelto.</div>
          </>
        )}
        {loading && <Empty>Enviando snapshot SCADA al copiloto…</Empty>}
        {!loading && ai && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <SeverityBadge sev={ai.severity} />
              <Chip color={ai.source === 'AI' ? SRC.REAL : SRC.DEMO} text={ai.source === 'AI' ? 'OpenAI' : 'Mock local'} />
              <Chip color={ai.canKeepOperating ? SRC.REAL : SEV.CRITICAL} text={ai.canKeepOperating ? 'PUEDE OPERAR' : 'DETENER'} />
            </div>
            <AiCard label="Diagnóstico probable" text={ai.probableFault} />
            {ai.suspectComponent && <AiCard label="Componente sospechoso" text={ai.suspectComponent} />}
            <AiCard label="Acción recomendada" text={ai.recommendedAction} />
            {ai.evidence.length > 0 && <AiCard label="Evidencia" text={ai.evidence.join('\n')} mono />}
            {ai.checklist.length > 0 && (
              <div style={cardBox}>
                <div style={labelStyle}>Checklist</div>
                <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 11.5, color: C.text }}>{ai.checklist.map((x, i) => <li key={i} style={{ marginBottom: 3 }}>{x}</li>)}</ul>
              </div>
            )}
            {ai.maintenanceMessage && <AiCard label="Mensaje sugerido" text={ai.maintenanceMessage} mono />}
            <button onClick={() => onUseAsMessage(ai.maintenanceMessage || ai.probableFault)} style={{ ...primaryBtn, width: '100%' }}>
              Usar como mensaje a administración
            </button>
            <button onClick={onRun} style={ghostBtn(false)}>Volver a analizar</button>
          </>
        )}
      </div>
    </div>
  );
}

const cardBox: React.CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 3, padding: '8px 10px' };
function AiCard({ label, text, mono }: { label: string; text: string; mono?: boolean }) {
  if (!text) return null;
  return (
    <div style={cardBox}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 11.5, color: C.text, whiteSpace: 'pre-wrap', fontFamily: mono ? MONO : SANS, marginTop: 4 }}>{text}</div>
    </div>
  );
}

// ── Primitivos UI ──────────────────────────────────────────────────────────────
const labelStyle: React.CSSProperties = { fontSize: 9.5, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 600 };
const inputStyle: React.CSSProperties = { flex: 1, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 3, padding: '8px 10px', fontFamily: SANS, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' };

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 2, padding: 16 }}>
      <div style={{ ...labelStyle, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}
function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: C.panel, padding: '16px 18px' }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, fontFamily: MONO, color, marginTop: 6, lineHeight: 1 }}>{value}</div>
    </div>
  );
}
function KV({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <span style={{ fontSize: 11.5, color: C.muted }}>{k}</span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span style={{ fontSize: 12.5, fontFamily: MONO, color: C.text }}>{v}</span>
        {sub && <span style={{ fontSize: 9.5, color: C.dim }}>{sub}</span>}
      </span>
    </div>
  );
}

function Dot({ on, color = '#3DCD58', invert }: { on: boolean; color?: string; invert?: boolean }) {
  const col = on ? color : C.dim;
  return <span style={{ width: 11, height: 11, borderRadius: 11, display: 'inline-block', background: col, boxShadow: on ? `0 0 8px ${col}` : 'none' }} />;
}
function Chip({ color, text }: { color: string; text: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', background: `${color}1c`, color, border: `1px solid ${color}59`, borderRadius: 2, padding: '2px 7px', fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, fontFamily: MONO }}>{text}</span>;
}
function SourceBadge({ src }: { src: DataSource }) { return <Chip color={SRC[src]} text={SRC_LABEL[src]} />; }
function SeverityBadge({ sev }: { sev: Severity }) { return <Chip color={SEV[sev]} text={sev} />; }
function AiHealthBadge({ h }: { h: AiBackendHealth }) {
  const map: Record<AiBackendHealth['state'], { c: string; t: string }> = {
    CONFIGURED: { c: SRC.REAL, t: 'CONFIGURED' }, NOT_CONFIGURED: { c: SRC.STALE, t: 'SIN KEY' },
    NOT_CONNECTED: { c: C.dim, t: 'NO CONECTADO' }, UNKNOWN: { c: C.dim, t: '…' },
  };
  const x = map[h.state];
  return <Chip color={x.c} text={`IA ${x.t}`} />;
}
function LinkChip({ label, link }: { label: string; link: { state: DataSource; ageS: number | null } }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: C.muted }}><Dot on={link.state === 'REAL' || link.state === 'DEMO'} color={SRC[link.state]} />{label} <span style={{ color: SRC[link.state], fontWeight: 600 }}>{SRC_LABEL[link.state]}</span></span>;
}
function PlantPill({ state }: { state: string }) {
  const c = state === 'NOMINAL' ? SRC.REAL : state === 'OFFLINE' ? C.dim : state === 'WARNING' ? SEV.WARNING : state === 'CRITICAL' ? SEV.CRITICAL : SEV.ALARM;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: `${c}1c`, color: c, border: `1px solid ${c}59`, borderRadius: 2, padding: '3px 9px', fontSize: 11, fontWeight: 700, fontFamily: MONO }}><Dot on color={c} /> {state}</span>;
}
function DemoToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} title="Modo DEMO: sintetiza datos para presentar el SCADA sin hardware. Todo lo demo se marca como tal."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: on ? `${SRC.DEMO}1c` : 'transparent', color: on ? SRC.DEMO : C.muted, border: `1px solid ${on ? SRC.DEMO + '88' : C.border}`, borderRadius: 2, padding: '5px 10px', fontSize: 10.5, fontWeight: 600, cursor: 'pointer', fontFamily: MONO, letterSpacing: 0.5 }}>
      <Dot on={on} color={SRC.DEMO} /> {on ? 'DEMO ON' : 'Modo DEMO'}
    </button>
  );
}
function AlarmRow({ a }: { a: Alarm }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.borderSoft}` }}>
      <SeverityBadge sev={a.severity} />
      <span style={{ fontSize: 11.5, color: C.text, flex: 1 }}>{a.message} {a.demo && <span style={{ fontSize: 9, color: SRC.DEMO }}>[DEMO]</span>}</span>
      <span style={{ fontSize: 10, color: C.muted }}>{a.station}</span>
    </div>
  );
}
function Banner({ color, text }: { color: string; text: string }) {
  return <div style={{ background: `${color}14`, border: `1px solid ${color}44`, borderLeft: `3px solid ${color}`, borderRadius: 2, padding: '10px 14px', fontSize: 11.5, color: C.text }}>{text}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, color: C.dim, padding: '8px 0' }}>{children}</div>;
}

const primaryBtn: React.CSSProperties = { background: 'var(--sc-btn-bg)', color: 'var(--sc-btn-text)', border: '1px solid var(--sc-btn-border)', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 180ms' };
function miniBtn(disabled: boolean, color = SRC.CONFIGURED): React.CSSProperties {
  return { background: 'transparent', color: disabled ? C.dim : color, border: `1px solid ${disabled ? C.border : color + '66'}`, borderRadius: 2, padding: '4px 7px', fontSize: 9.5, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: MONO, opacity: disabled ? 0.6 : 1 };
}
function tabBtn(active: boolean): React.CSSProperties {
  return { background: 'transparent', color: active ? C.text : C.muted, border: 'none', borderBottom: active ? `2px solid ${SRC.REAL}` : '2px solid transparent', padding: '10px 16px', fontSize: 11, fontWeight: active ? 700 : 500, letterSpacing: 0.8, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
}
function ghostBtn(active: boolean): React.CSSProperties {
  return { background: active ? 'var(--sc-ghost-active)' : 'transparent', color: active ? C.text : C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: '5px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: MONO, letterSpacing: 0.4 };
}
function fmtVal(v: number | boolean | string | null): string {
  if (v === null) return 'N/A';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
