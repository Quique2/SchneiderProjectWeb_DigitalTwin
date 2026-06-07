// ─────────────────────────────────────────────────────────────────────────────
// ScadaView.tsx — Dashboard SCADA industrial (pestaña "SCADA").
// Monitoreo, alarmas, mantenimiento, diagnóstico y asistente de IA (Gemini/mock).
// 100% aditivo: consume su propio motor (useScada), no toca FSM/Celda 3D/cobot real.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useRef, useState } from 'react';
import { useScada } from './useScada';
import { requestAiDiagnosis, localMockDiagnosis, msg as buildMsg } from './aiClient';
import type {
  Alarm, AiDiagnosis, ScadaSnapshot, Severity, Tag, DataSource,
} from './scadaTypes';

const MONO = '"JetBrains Mono","Fira Code","IBM Plex Mono","Courier New",monospace';
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif';

const SEV_COLOR: Record<Severity, string> = { INFO: '#38bdf8', WARNING: '#fbbf24', ALARM: '#fb7185', CRITICAL: '#ef4444' };
const SRC_COLOR: Record<DataSource, string> = { REAL: '#22c55e', SIM: '#8b5cf6', ESTIMATED: '#fbbf24', CONFIGURED: '#38bdf8' };

type Section = 'overview' | 'io' | 'alarms' | 'maintenance' | 'quality' | 'cobot' | 'tags';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'io', label: 'I/O Diagnostics' },
  { id: 'alarms', label: 'Alarms' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'quality', label: 'Quality' },
  { id: 'cobot', label: 'Cobot Health' },
  { id: 'tags', label: 'Tag Table' },
];

export default function ScadaView() {
  const { snapshot, acknowledge, acknowledgeAll } = useScada();
  const [section, setSection] = useState<Section>('overview');
  const [ai, setAi] = useState<AiDiagnosis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [maintMsg, setMaintMsg] = useState('');
  const [reports, setReports] = useState<string[]>([]);
  const hist = useTrendHistory(snapshot);

  const runAi = async () => {
    setAiLoading(true);
    try { setAi(await requestAiDiagnosis(snapshot)); }
    catch { setAi(localMockDiagnosis(snapshot)); }
    finally { setAiLoading(false); }
  };

  const genMessage = () => {
    const d = ai ?? localMockDiagnosis(snapshot);
    setMaintMsg(d.maintenanceMessage || buildMsg(d.severity, d.suspectComponent, d.probableFault, d.evidence, d.recommendedAction));
  };
  const copyMessage = () => { if (maintMsg && navigator.clipboard) navigator.clipboard.writeText(maintMsg).catch(() => {}); };
  const createReport = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const r = `=== REPORTE SCADA ${stamp} ===\nEstado: ${snapshot.overview.plantState} · Etapa: ${snapshot.overview.stage}\nFaults activos: ${snapshot.overview.activeFaults}\nProducción: ${snapshot.overview.totalProduced} (✓${snapshot.overview.accepted} / ✗${snapshot.overview.rejected})\nAlarmas:\n${snapshot.alarms.filter((a) => a.active).map((a) => `  - [${a.severity}] ${a.station}: ${a.message}`).join('\n') || '  (ninguna)'}\n${maintMsg ? '\nMensaje mantenimiento:\n' + maintMsg : ''}`;
    setReports((rs) => [r, ...rs].slice(0, 10));
  };

  const activeAlarms = snapshot.alarms.filter((a) => a.active);
  const overall = activeAlarms.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL'
    : activeAlarms.some((a) => a.severity === 'ALARM') ? 'ALARM'
      : activeAlarms.some((a) => a.severity === 'WARNING') ? 'WARNING' : 'OK';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#070f1a', color: '#e2e8f0', fontFamily: SANS, overflow: 'hidden' }}>
      {/* Header SCADA */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px', borderBottom: '1px solid #16263c', background: 'linear-gradient(180deg,#0b1828,#070f1a)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.5 }}>SCADA · Celda de Remachado</div>
        <StatusPill overall={overall} />
        <div style={{ ...badge('#8b5cf6'), fontSize: 10 }}>● SIM / MOCK</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: '#7e93ad' }}>{activeAlarms.length} alarma(s) activa(s)</div>
        <button onClick={runAi} disabled={aiLoading} style={aiBtn(aiLoading)}>
          {aiLoading ? 'Analizando…' : '🧠 Analizar fallas con IA'}
        </button>
      </div>

      {/* Section tabs */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 2, padding: '6px 12px', borderBottom: '1px solid #16263c', background: '#0a1422', overflowX: 'auto' }}>
        {SECTIONS.map((sec) => (
          <button key={sec.id} onClick={() => setSection(sec.id)} style={tabBtn(section === sec.id)}>{sec.label}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
          {section === 'overview' && <Overview s={snapshot} hist={hist} />}
          {section === 'io' && <IoDiagnostics s={snapshot} />}
          {section === 'alarms' && <Alarms s={snapshot} acknowledge={acknowledge} acknowledgeAll={acknowledgeAll} />}
          {section === 'maintenance' && <Maintenance s={snapshot} hist={hist} />}
          {section === 'quality' && <Quality s={snapshot} />}
          {section === 'cobot' && <CobotHealth s={snapshot} />}
          {section === 'tags' && <TagTable tags={snapshot.tags} />}
        </div>

        {/* Right rail: IA + Mantenimiento */}
        <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #16263c', background: '#0a1422', overflowY: 'auto', padding: 14 }}>
          <SectionTitle>Asistente IA · Mantenimiento</SectionTitle>
          <AiPanel ai={ai} loading={aiLoading} onRun={runAi} />
          <div style={{ height: 14 }} />
          <SectionTitle>Mensajes a mantenimiento</SectionTitle>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <button onClick={genMessage} style={smallBtn('#1d3a52')}>Generar mensaje</button>
            <button onClick={copyMessage} style={smallBtn('#1d3a52')}>Copiar</button>
            <button onClick={acknowledgeAll} style={smallBtn('#2a1d3a')}>Marcar atendidas</button>
            <button onClick={createReport} style={smallBtn('#1d3a2a')}>Reporte local</button>
          </div>
          <textarea value={maintMsg} onChange={(e) => setMaintMsg(e.target.value)} placeholder="El mensaje generado aparecerá aquí…"
            style={{ width: '100%', height: 120, background: '#06101c', color: '#cfe0f0', border: '1px solid #1c3148', borderRadius: 6, padding: 8, fontFamily: MONO, fontSize: 11, resize: 'vertical', boxSizing: 'border-box' }} />
          {reports.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: '#7e93ad', marginBottom: 4 }}>Reportes locales ({reports.length})</div>
              {reports.map((r, i) => (
                <pre key={i} style={{ background: '#06101c', border: '1px solid #16263c', borderRadius: 6, padding: 8, fontSize: 9.5, color: '#9fb3c8', whiteSpace: 'pre-wrap', maxHeight: 130, overflow: 'auto', margin: '0 0 6px' }}>{r}</pre>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
function Overview({ s, hist }: { s: ScadaSnapshot; hist: TrendHistory }) {
  const o = s.overview;
  return (
    <Grid>
      <Card title="Estado de planta" span={2}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Stat label="Estado" value={o.plantState} accent={o.plantState === 'FAULT' ? '#ef4444' : '#22c55e'} />
          <Stat label="Etapa actual" value={o.stage} />
          <Stat label="CAFI activo" value={o.activeCafiId == null ? '—' : `#${o.activeCafiId}`} />
          <Stat label="Disponibilidad" value={`${o.availabilityPct}%`} />
          <Stat label="Faults activos" value={o.activeFaults} accent={o.activeFaults ? '#fb7185' : '#22c55e'} />
        </div>
      </Card>
      <Card title="Producción">
        <Stat label="Total" value={o.totalProduced} big />
        <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
          <Stat label="Aceptados" value={o.accepted} accent="#22c55e" />
          <Stat label="Rechazados" value={o.rejected} accent="#fb7185" />
        </div>
      </Card>
      <Card title="Tiempo de ciclo">
        <Stat label="Último ciclo" value={`${o.cycleTimeS}s`} big />
        <Spark data={hist.cycle} color="#38bdf8" />
      </Card>
      <Card title="Conveyor duty (5 min)">
        <Stat label="Duty cycle" value={`${s.conveyor.dutyCycle5minPct}%`} big accent={s.conveyor.dutyCycle5minPct > 80 ? '#fb7185' : s.conveyor.dutyCycle5minPct > 60 ? '#fbbf24' : '#22c55e'} />
        <Spark data={hist.duty} color="#fbbf24" />
        <div style={{ fontSize: 10, color: '#7e93ad', marginTop: 4 }}>Motor temp (estimada): {s.conveyor.motorTempC}°C</div>
      </Card>
      <Card title="Mesa rotatoria">
        <Stat label="Posición" value={s.turntable.position} />
        <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
          <Stat label="Ciclos" value={s.turntable.indexCount} />
          <Stat label="Ángulo" value={`${s.turntable.angleDeg}°`} />
        </div>
      </Card>
      <Card title="Cobot · ctrl temp">
        <Stat label="Controlador" value={`${s.cobot.controllerTempC}°C`} big />
        <Spark data={hist.ctrlTemp} color="#a78bfa" />
        <div style={{ fontSize: 10, color: '#7e93ad', marginTop: 4 }}>Joint máx: {Math.max(...s.cobot.joints.map((j) => j.tempC))}°C</div>
      </Card>
      <Card title="Alarmas activas" span={3}>
        {s.alarms.filter((a) => a.active).slice(0, 6).map((a) => <AlarmRow key={a.id} a={a} />)}
        {s.alarms.filter((a) => a.active).length === 0 && <Empty>Sin alarmas activas</Empty>}
      </Card>
    </Grid>
  );
}

// ── I/O Diagnostics ──────────────────────────────────────────────────────────
function IoDiagnostics({ s }: { s: ScadaSnapshot }) {
  return (
    <Grid>
      <Card title={`Inputs (${s.io.inputs.length})`} span={1}>
        {s.io.inputs.map((t) => <IoRow key={t.name} t={t} />)}
      </Card>
      <Card title={`Outputs (${s.io.outputs.length})`} span={1}>
        {s.io.outputs.map((t) => <IoRow key={t.name} t={t} />)}
      </Card>
      <Card title="Sensores fotoeléctricos" span={1}>
        {s.sensors.map((sn) => (
          <Row key={sn.name} k={sn.name}>
            <Led on={sn.state} />
            <span style={{ marginLeft: 8, color: '#7e93ad', fontSize: 10 }}>blk {sn.blockedTimeS}s · trig {sn.triggerCount}</span>
          </Row>
        ))}
      </Card>
      <Card title="Fixtures" span={1}>
        {s.fixtures.map((f) => (
          <Row key={f.id} k={`Fixture ${f.id}`}>
            <span style={badge(f.present ? '#22c55e' : '#475569')}>{f.state}</span>
            <span style={{ marginLeft: 8, color: '#7e93ad', fontSize: 10 }}>CAFI {f.cafiId ?? '—'} · sw {f.switchCycles}</span>
          </Row>
        ))}
      </Card>
    </Grid>
  );
}

// ── Alarms ───────────────────────────────────────────────────────────────────
function Alarms({ s, acknowledge, acknowledgeAll }: { s: ScadaSnapshot; acknowledge: (id: string) => void; acknowledgeAll: () => void }) {
  const counts: Record<Severity, number> = { INFO: 0, WARNING: 0, ALARM: 0, CRITICAL: 0 };
  s.alarms.forEach((a) => { if (a.active) counts[a.severity]++; });
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['CRITICAL', 'ALARM', 'WARNING', 'INFO'] as Severity[]).map((sv) => (
          <div key={sv} style={{ ...badge(SEV_COLOR[sv]), fontSize: 11 }}>{sv} · {counts[sv]}</div>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={acknowledgeAll} style={smallBtn('#2a1d3a')}>Reconocer todas</button>
      </div>
      <Card title={`Registro de alarmas (${s.alarms.length})`} span={3}>
        <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 110px 70px 60px 90px', gap: 6, fontSize: 10, color: '#7e93ad', padding: '0 0 6px', borderBottom: '1px solid #16263c' }}>
          <div>Severidad</div><div>Código · Mensaje</div><div>Estación</div><div>Dur</div><div>Ack</div><div>Acción</div>
        </div>
        {s.alarms.length === 0 && <Empty>Sin alarmas</Empty>}
        {s.alarms.map((a) => (
          <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 110px 70px 60px 90px', gap: 6, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #0f1d2e', opacity: a.active ? 1 : 0.5 }}>
            <span style={{ ...badge(SEV_COLOR[a.severity]), fontSize: 9.5, justifySelf: 'start' }}>{a.severity}</span>
            <div style={{ fontSize: 11 }}><span style={{ fontFamily: MONO, color: '#9fb3c8' }}>{a.code}</span> · {a.message}</div>
            <div style={{ fontSize: 10, color: '#9fb3c8' }}>{a.station}</div>
            <div style={{ fontSize: 10, fontFamily: MONO }}>{Math.round(a.durationS)}s</div>
            <div>{a.acknowledged ? <span style={{ color: '#22c55e' }}>✓</span> : <span style={{ color: '#fb7185' }}>—</span>}</div>
            <button onClick={() => acknowledge(a.id)} disabled={a.acknowledged} style={smallBtn('#1d3a2a')}>Ack</button>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── Maintenance ──────────────────────────────────────────────────────────────
function Maintenance({ s, hist }: { s: ScadaSnapshot; hist: TrendHistory }) {
  const m = s.maintenance;
  const tt = s.turntable;
  return (
    <Grid>
      <Card title="Conveyor" span={1}>
        <KV k="Motor hours" v={`${m.conveyorMotorHours} h`} />
        <KV k="Arranques" v={m.conveyorStarts} />
        <KV k="Duty cycle (15m)" v={`${m.conveyorDutyCyclePct}%`} />
        <KV k="Temp motor (est.)" v={`${s.conveyor.motorTempC}°C`} src="ESTIMATED" />
      </Card>
      <Card title="Mesa rotatoria / NEMA" span={1}>
        <KV k="Ciclos totales" v={m.turntableCycles} />
        <KV k="Golpes HOME" v={m.homeLimitHits} />
        <KV k="Golpes WORK" v={m.workLimitHits} />
        <KV k="Ciclos desde mant." v={tt.cyclesSinceMaintenance} />
        <MaintBar label="Base (5,000)" value={tt.cyclesSinceMaintenance} max={5000} />
        <MaintBar label="Apriete (10,000)" value={tt.cyclesSinceMaintenance} max={10000} />
        <MaintBar label="Limit switches (25,000)" value={m.homeLimitHits + m.workLimitHits} max={25000} />
      </Card>
      <Card title="Gripper / Fixtures" span={1}>
        <KV k="Gripper ciclos" v={m.gripperCycles} />
        <KV k="Fixture 1 switch" v={m.fixture1SwitchCycles} />
        <KV k="Fixture 2 switch" v={m.fixture2SwitchCycles} />
        <KV k="Presión" v={`${s.gripper.airPressureBar} bar`} src={s.gripper.pressureSource} />
      </Card>
      <Card title="Cámara" span={1}>
        <KV k="Triggers" v={m.cameraTriggerCount} />
        <KV k="Inspecciones" v={m.cameraInspectionCount} />
        <KV k="Imágenes guardadas" v={s.camera.savedImagesCount} />
        <KV k="Almacenamiento" v={`${s.camera.storageUsedMb} MB`} />
      </Card>
      <Card title="Temperaturas de joints" span={2}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {m.jointTemps.map((t, i) => <Stat key={i} label={`J${i + 1}`} value={`${t}°C`} accent={t > 60 ? '#ef4444' : t > 50 ? '#fbbf24' : '#22c55e'} />)}
        </div>
        <Spark data={hist.ctrlTemp} color="#a78bfa" />
      </Card>
    </Grid>
  );
}

// ── Quality ──────────────────────────────────────────────────────────────────
function Quality({ s }: { s: ScadaSnapshot }) {
  const q = s.quality;
  return (
    <Grid>
      <Card title="Resultados">
        <div style={{ display: 'flex', gap: 16 }}>
          <Stat label="PASS" value={q.passCount} accent="#22c55e" big />
          <Stat label="FAIL" value={q.failCount} accent="#fb7185" big />
        </div>
        <KV k="Reject rate" v={`${q.rejectRatePct}%`} />
        <KV k="Último resultado" v={q.lastResult} />
      </Card>
      <Card title="Cámara Datalogic">
        <KV k="Proc. último" v={`${q.cameraProcessingMs} ms`} />
        <KV k="Proc. promedio" v={`${s.camera.avgInspectionTimeMs} ms`} />
        <KV k="Proc. máximo" v={`${s.camera.maxInspectionTimeMs} ms`} />
        <KV k="No-read" v={q.noReadCount} />
        <KV k="Comm" v={s.camera.commStatus} src={s.camera.commStatus === 'ONLINE' ? 'REAL' : undefined} />
        <KV k="Trigger rate" v={`${s.camera.triggerRatePerHour}/h`} />
      </Card>
    </Grid>
  );
}

// ── Cobot Health ─────────────────────────────────────────────────────────────
function CobotHealth({ s }: { s: ScadaSnapshot }) {
  const c = s.cobot;
  return (
    <Grid>
      <Card title="Controlador" span={1}>
        <KV k="Temperatura" v={`${c.controllerTempC} °C`} />
        <KV k="Potencia media" v={`${c.avgPowerW} W`} />
        <KV k="Corriente media" v={`${c.avgCurrentA} A`} />
        <KV k="Speed magnif." v={`${c.speedMagnificationPct} %`} />
      </Card>
      <Card title="TCP" span={1}>
        <KV k="X / Y / Z" v={`${c.tcp.xMm} / ${c.tcp.yMm} / ${c.tcp.zMm} mm`} />
        <KV k="RX / RY / RZ" v={`${c.tcp.rxDeg} / ${c.tcp.ryDeg} / ${c.tcp.rzDeg}°`} />
        <KV k="Target pose" v={c.tcp.targetPoseName} />
        <KV k="Error pos." v={`${c.tcp.positionErrorMm} mm`} src={c.tcp.positionErrorMm > 10 ? undefined : 'SIM'} />
        <KV k="Error orient." v={`${c.tcp.orientationErrorDeg}°`} />
      </Card>
      <Card title="Force / Torque (end-effector)" span={1}>
        <KV k="Fx / Fy / Fz" v={`${c.ft.fxN} / ${c.ft.fyN} / ${c.ft.fzN} N`} />
        <KV k="Tx / Ty / Tz" v={`${c.ft.txNm} / ${c.ft.tyNm} / ${c.ft.tzNm} Nm`} />
      </Card>
      <Card title="Articulaciones (J1–J6)" span={3}>
        <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 6, fontSize: 10, color: '#7e93ad', padding: '0 0 6px', borderBottom: '1px solid #16263c' }}>
          <div>Joint</div><div>Ángulo</div><div>Temp</div><div>Corriente</div>
        </div>
        {c.joints.map((j) => (
          <div key={j.index} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr 1fr', gap: 6, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #0f1d2e' }}>
            <div style={{ fontFamily: MONO, color: '#9fb3c8' }}>J{j.index}</div>
            <div style={{ fontFamily: MONO }}>{j.angleDeg}°</div>
            <div style={{ fontFamily: MONO, color: j.tempC > 60 ? '#ef4444' : j.tempC > 50 ? '#fbbf24' : '#cfe0f0' }}>{j.tempC}°C</div>
            <div style={{ fontFamily: MONO }}>{j.currentA} A</div>
          </div>
        ))}
      </Card>
    </Grid>
  );
}

// ── Tag table ────────────────────────────────────────────────────────────────
function TagTable({ tags }: { tags: Tag[] }) {
  const [q, setQ] = useState('');
  const f = tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card title={`Tabla de tags (${f.length}/${tags.length})`} span={3}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar tags…"
        style={{ width: '100%', maxWidth: 320, background: '#06101c', color: '#cfe0f0', border: '1px solid #1c3148', borderRadius: 6, padding: '6px 10px', fontFamily: MONO, fontSize: 11, marginBottom: 10, boxSizing: 'border-box' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 90px', gap: 6, fontSize: 10, color: '#7e93ad', padding: '0 0 6px', borderBottom: '1px solid #16263c' }}>
        <div>Tag</div><div>Valor</div><div>Unidad</div><div>Fuente</div>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {f.map((t) => (
          <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 90px', gap: 6, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #0f1d2e' }}>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#9fb3c8' }}>{t.name}</div>
            <div style={{ fontFamily: MONO, fontSize: 11 }}>{fmtVal(t.value)}</div>
            <div style={{ fontSize: 10, color: '#7e93ad' }}>{t.unit ?? ''}</div>
            <div><span style={{ ...badge(SRC_COLOR[t.source]), fontSize: 9 }}>{t.source}</span></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── AI panel ─────────────────────────────────────────────────────────────────
function AiPanel({ ai, loading, onRun }: { ai: AiDiagnosis | null; loading: boolean; onRun: () => void }) {
  if (loading) return <div style={cardBox}>Analizando snapshot SCADA…</div>;
  if (!ai) return (
    <div style={cardBox}>
      <div style={{ fontSize: 11, color: '#7e93ad' }}>Pulsa "Analizar fallas con IA" para un diagnóstico del estado actual.</div>
      <button onClick={onRun} style={{ ...smallBtn('#1d3a52'), marginTop: 8 }}>Analizar ahora</button>
    </div>
  );
  return (
    <div style={cardBox}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ ...badge(SEV_COLOR[ai.severity]), fontSize: 10 }}>{ai.severity}</span>
        <span style={{ ...badge(ai.source === 'GEMINI' ? '#22c55e' : '#8b5cf6'), fontSize: 9 }}>{ai.source}</span>
        <span style={{ ...badge(ai.canKeepOperating ? '#22c55e' : '#ef4444'), fontSize: 9 }}>{ai.canKeepOperating ? 'PUEDE OPERAR' : 'DETENER'}</span>
      </div>
      <AiBlock label="Posible falla" text={ai.probableFault} />
      <AiBlock label="Componente sospechoso" text={ai.suspectComponent} />
      <AiBlock label="Acción recomendada" text={ai.recommendedAction} />
      {ai.evidence.length > 0 && <AiBlock label="Evidencia" text={ai.evidence.join('\n')} mono />}
      {ai.checklist.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 9.5, color: '#7e93ad', textTransform: 'uppercase', letterSpacing: 1 }}>Checklist</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11, color: '#cfe0f0' }}>{ai.checklist.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}
      <AiBlock label="Mensaje a mantenimiento" text={ai.maintenanceMessage} mono />
    </div>
  );
}

function AiBlock({ label, text, mono }: { label: string; text: string; mono?: boolean }) {
  if (!text) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 9.5, color: '#7e93ad', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 11, color: '#dbe7f3', whiteSpace: 'pre-wrap', fontFamily: mono ? MONO : SANS }}>{text}</div>
    </div>
  );
}

// ── Trend history hook ───────────────────────────────────────────────────────
interface TrendHistory { duty: number[]; ctrlTemp: number[]; cycle: number[]; }
function useTrendHistory(s: ScadaSnapshot): TrendHistory {
  const ref = useRef<TrendHistory>({ duty: [], ctrlTemp: [], cycle: [] });
  const [, force] = useState(0);
  useEffect(() => {
    const h = ref.current;
    const push = (arr: number[], v: number) => { arr.push(v); if (arr.length > 60) arr.shift(); };
    push(h.duty, s.conveyor.dutyCycle5minPct);
    push(h.ctrlTemp, s.cobot.controllerTempC);
    push(h.cycle, s.overview.cycleTimeS);
    force((n) => n + 1);
  }, [s.ts]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref.current;
}

// ── Primitivos UI ────────────────────────────────────────────────────────────
const cardBox: React.CSSProperties = { background: '#0c1828', border: '1px solid #16263c', borderRadius: 8, padding: 12 };

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>{children}</div>;
}
function Card({ title, span = 1, children }: { title: string; span?: number; children: React.ReactNode }) {
  return (
    <div style={{ ...cardBox, gridColumn: `span ${span}` }}>
      <div style={{ fontSize: 10.5, color: '#7e93ad', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 10, fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, color: '#7e93ad', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 8, fontWeight: 600 }}>{children}</div>;
}
function Stat({ label, value, accent, big }: { label: string; value: React.ReactNode; accent?: string; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, color: '#7e93ad', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 16, fontWeight: 700, color: accent ?? '#f1f5f9', fontFamily: MONO }}>{value}</div>
    </div>
  );
}
function KV({ k, v, src }: { k: string; v: React.ReactNode; src?: DataSource }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #0f1d2e' }}>
      <span style={{ fontSize: 11, color: '#9fb3c8' }}>{k}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontFamily: MONO, color: '#dbe7f3' }}>{v}</span>
        {src && <span style={{ ...badge(SRC_COLOR[src]), fontSize: 8 }}>{src}</span>}
      </span>
    </div>
  );
}
function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #0f1d2e' }}>
      <span style={{ fontSize: 10.5, fontFamily: MONO, color: '#9fb3c8' }}>{k}</span>
      <span style={{ display: 'flex', alignItems: 'center' }}>{children}</span>
    </div>
  );
}
function IoRow({ t }: { t: Tag }) {
  const on = t.value === true;
  return (
    <Row k={t.name}>
      <Led on={on} />
      <span style={{ ...badge(SRC_COLOR[t.source]), fontSize: 8, marginLeft: 8 }}>{t.source}</span>
    </Row>
  );
}
function Led({ on }: { on: boolean }) {
  return <span style={{ width: 12, height: 12, borderRadius: 12, display: 'inline-block', background: on ? '#22c55e' : '#334155', boxShadow: on ? '0 0 8px #22c55e' : 'none' }} />;
}
function AlarmRow({ a }: { a: Alarm }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid #0f1d2e' }}>
      <span style={{ ...badge(SEV_COLOR[a.severity]), fontSize: 9 }}>{a.severity}</span>
      <span style={{ fontSize: 11, color: '#dbe7f3', flex: 1 }}>{a.message}</span>
      <span style={{ fontSize: 10, color: '#7e93ad' }}>{a.station}</span>
    </div>
  );
}
function MaintBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  const col = pct > 90 ? '#ef4444' : pct > 70 ? '#fbbf24' : '#22c55e';
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: '#7e93ad' }}><span>{label}</span><span>{value}/{max}</span></div>
      <div style={{ height: 5, background: '#0f1d2e', borderRadius: 3, marginTop: 2 }}><div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 3 }} /></div>
    </div>
  );
}
function Spark({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div style={{ height: 30 }} />;
  const w = 220, h = 30, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / rng) * h}`).join(' ');
  return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ marginTop: 6 }}><polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} /></svg>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#5e7088', padding: '8px 0' }}>{children}</div>;
}
function StatusPill({ overall }: { overall: string }) {
  const c = overall === 'CRITICAL' ? '#ef4444' : overall === 'ALARM' ? '#fb7185' : overall === 'WARNING' ? '#fbbf24' : '#22c55e';
  return <span style={{ ...badge(c), fontSize: 11, fontWeight: 700 }}>● {overall === 'OK' ? 'NOMINAL' : overall}</span>;
}

function badge(color: string): React.CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 4, background: `${color}22`, color, border: `1px solid ${color}55`, borderRadius: 5, padding: '2px 7px', fontWeight: 600, letterSpacing: 0.4 };
}
function tabBtn(active: boolean): React.CSSProperties {
  return { background: active ? 'rgba(184,115,51,0.14)' : 'transparent', color: active ? '#f1f5f9' : '#7e93ad', border: 'none', borderBottom: active ? '2px solid #d97740' : '2px solid transparent', padding: '7px 14px', fontSize: 11, fontWeight: active ? 600 : 500, letterSpacing: 0.8, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
}
function aiBtn(loading: boolean): React.CSSProperties {
  return { background: loading ? '#1c2c3e' : 'linear-gradient(180deg,#7c3aed,#6d28d9)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: loading ? 'default' : 'pointer', fontFamily: 'inherit' };
}
function smallBtn(bg: string): React.CSSProperties {
  return { background: bg, color: '#cfe0f0', border: '1px solid #ffffff18', borderRadius: 5, padding: '5px 9px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit' };
}
function fmtVal(v: number | boolean | string): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
