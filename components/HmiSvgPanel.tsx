// Operator HMI — Celda de Remachado
// SVG rendered as inline JSX so all 19 tags + 6 buttons bind directly to React state.
// Source SVG: public/hmi/OperatorHMI_RemachadoCell.svg (480×272 viewBox).
// Data source: telemetry.hmi block from /ws/cobot WebSocket.
// Pipeline actions: POST to /api/pipeline/* endpoints.

import React, { useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';

// ── Block types (mirrors the gateway WS payload) ────────────────────────────

export interface HmiBlock {
  I_CONVEYOR_PHOTOEYE: boolean;
  I_FIXTURE_1_PRESENT: boolean;
  I_FIXTURE_2_PRESENT: boolean;
  I_COBOT_MOVING: boolean;
  I_COBOT_READY: boolean;
  I_GRIPPER_OPEN: boolean;
  I_GRIPPER_CLOSED: boolean;
  O_CONVEYOR_MOTOR: boolean;
  O_CAMERA_TRIGGER: boolean;
  O_TABLE_NEMA_MOVING: boolean;
  O_RIVET_ACTIVE: boolean;
  O_STACKLIGHT_RED: boolean;
  O_STACKLIGHT_YELLOW: boolean;
  O_STACKLIGHT_GREEN: boolean;
  CAMERA_STATUS: string;
  'COUNT.total': number;
  'COUNT.accepted': number;
  'COUNT.rejected': number;
}

export interface PipelineBlock {
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'alarm' | 'done';
  paused: boolean;
  finalizing: boolean;
  needs_clean: boolean;
  label: string;
  speed: number;
}

interface Props {
  hmi?: HmiBlock;
  pipeline?: PipelineBlock;
  lastFrameTs: number;      // ms epoch of last WS frame; 0 = never received
  apiBase: string;          // HTTP base, e.g. "https://unmoral-shrink-cavalry.ngrok-free.dev"
  controlEnabled: boolean;  // true only when mode === 'live'
}

// ── Constants ────────────────────────────────────────────────────────────────

const OFF      = '#40566F';   // LED off / not connected
const STALE_MS = 3000;        // > 3 s without frame → stale

// ── Component ────────────────────────────────────────────────────────────────

export default function HmiSvgPanel({ hmi, pipeline, lastFrameTs, apiBase, controlEnabled }: Props) {
  const { t } = useLanguage();
  // Tick every second to keep stale detection live even with no new frames
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const connected = lastFrameTs > 0;
  const stale     = connected && (Date.now() - lastFrameTs) > STALE_MS;

  // ── LED fill ─────────────────────────────────────────────────────────────

  const led = (tag: keyof HmiBlock, onColor: string): string => {
    if (!hmi || !connected || stale) return OFF;
    return (hmi[tag] as boolean) ? onColor : OFF;
  };

  // ── Camera ───────────────────────────────────────────────────────────────

  const camText = (): string => {
    if (!hmi || !connected) return '—';
    return hmi.CAMERA_STATUS || 'READY';
  };
  const camFill = (): string => {
    if (!hmi || !connected || stale) return '#6FA8FF';
    switch (hmi.CAMERA_STATUS) {
      case 'PASS':    return '#22FF66';
      case 'FAIL':
      case 'ERROR':   return '#FF5566';
      case 'NO_READ': return '#FBBF24';
      default:        return '#6FA8FF';
    }
  };

  // ── Counters ─────────────────────────────────────────────────────────────

  const cnt = (tag: 'COUNT.total' | 'COUNT.accepted' | 'COUNT.rejected'): string =>
    hmi ? String(hmi[tag] ?? 0) : '0';

  // ── Pipeline state ───────────────────────────────────────────────────────

  const pst        = pipeline?.state        ?? 'idle';
  const isPaused   = pipeline?.paused       ?? false;
  const needsClean = pipeline?.needs_clean  ?? false;

  const btnOk = (btn: string): boolean => {
    if (!controlEnabled) return false;
    switch (btn) {
      case 'START':         return pst === 'idle' || pst === 'done';
      case 'STOP':          return pst === 'running' && !isPaused;
      case 'RESUME':        return isPaused;
      case 'RESTART':       return true;
      case 'CONFIRM_CLEAN': return needsClean;
      case 'FINALIZE':      return pst === 'running';
      default:              return false;
    }
  };

  const btnFill = (btn: string): string => {
    if (!btnOk(btn)) return '#3C4656';
    switch (btn) {
      case 'START':         return '#16A34A';
      case 'STOP':          return '#DC2626';
      case 'RESUME':        return '#2563EB';
      case 'RESTART':       return '#57534E';
      case 'CONFIRM_CLEAN': return '#D97706';
      case 'FINALIZE':      return '#7C3AED';
      default:              return '#3C4656';
    }
  };
  const btnTxt = (btn: string) => btnOk(btn) ? '#FFFFFF' : '#AAB8C8';
  const btnCur = (btn: string): React.CSSProperties['cursor'] =>
    btnOk(btn) ? 'pointer' : 'not-allowed';

  // ── Pipeline POST ────────────────────────────────────────────────────────

  const post = (path: string, body?: object) => {
    if (!controlEnabled) return;
    fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(e => console.warn('[HMI pipeline]', path, e));
  };

  const onBtn = (event: string) => {
    switch (event) {
      case 'START':         post('/api/pipeline/start', { cafi_count: 8, dry_run: false, stack_mode: true }); break;
      case 'STOP':          post('/api/pipeline/pause'); break;
      case 'RESUME':        post('/api/pipeline/resume'); break;
      case 'RESTART':       post('/api/pipeline/reset'); break;
      case 'CONFIRM_CLEAN': post('/api/pipeline/confirm_clean'); break;
      case 'FINALIZE':      post('/api/pipeline/finalize'); break;
    }
  };

  // ── Derived rendering values ─────────────────────────────────────────────

  const svgOpacity = stale ? 0.45 : 1;
  const readyOn    = connected && !stale && hmi?.I_COBOT_READY === true;

  const statusColor =
    stale         ? '#FBBF24' :
    pst === 'alarm'   ? '#FF5566' :
    pst === 'running' ? '#22FF66' :
    pst === 'paused'  ? '#FBBF24' : '#8AA7C7';

  const statusText =
    stale      ? t('hmi.stale') :
    !connected ? t('hmi.noConn')  :
    pipeline?.label ? pipeline.label          :
    `● ${pst.toUpperCase()}`;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#06101c' }}>
      {/* Pipeline status label */}
      <div style={{
        flexShrink: 0,
        fontSize: 10,
        fontFamily: '"JetBrains Mono","Roboto Mono","Courier New",monospace',
        color: statusColor,
        background: '#0B1726',
        borderBottom: '1px solid #1E3A5F',
        padding: '4px 12px',
        textAlign: 'center',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {statusText}
      </div>

      {/* SVG — fills remaining height, maintains 480:272 aspect ratio */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
        <svg
          viewBox="0 0 480 272"
          style={{ width: '100%', height: '100%', maxWidth: '100%', opacity: svgOpacity }}
          fontFamily="'JetBrains Mono','Roboto Mono','Courier New',monospace"
        >
          <defs>
            <filter id="hmiShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.45"/>
            </filter>
            <filter id="hmiGlow" x="-150%" y="-150%" width="400%" height="400%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>

          {/* Background */}
          <rect x="0" y="0" width="480" height="272" fill="#071321"/>
          <rect x="1" y="1" width="478" height="270" rx="5" fill="none" stroke="#1E3A5F" strokeWidth="2"/>
          <text x="10" y="15" fill="#DDEEFF" fontSize="12" fontWeight="700" letterSpacing="0.3">
            {t('hmi.svgTitle')}
          </text>
          <line x1="10" y1="20" x2="470" y2="20" stroke="#1E3A5F" strokeWidth="1"/>

          {/* ── BUTTONS ── */}
          <g style={{ cursor: btnCur('START') }} onClick={() => onBtn('START')}>
            <rect x="10" y="24" width="226" height="22" rx="5" fill={btnFill('START')}/>
            <text x="123" y="35" fill={btnTxt('START')} fontSize="11" fontWeight="700" letterSpacing="1"
              textAnchor="middle" dominantBaseline="central">START</text>
          </g>
          <g style={{ cursor: btnCur('STOP') }} onClick={() => onBtn('STOP')}>
            <rect x="244" y="24" width="226" height="22" rx="5" fill={btnFill('STOP')}/>
            <text x="357" y="35" fill={btnTxt('STOP')} fontSize="11" fontWeight="600" letterSpacing="1"
              textAnchor="middle" dominantBaseline="central">STOP</text>
          </g>
          <g style={{ cursor: btnCur('RESUME') }} onClick={() => onBtn('RESUME')}>
            <rect x="10" y="50" width="226" height="22" rx="5" fill={btnFill('RESUME')}/>
            <text x="123" y="61" fill={btnTxt('RESUME')} fontSize="10.5" fontWeight="600"
              textAnchor="middle" dominantBaseline="central">RESUME</text>
          </g>
          <g style={{ cursor: btnCur('RESTART') }} onClick={() => onBtn('RESTART')}>
            <rect x="244" y="50" width="226" height="22" rx="5" fill={btnFill('RESTART')}/>
            <text x="357" y="61" fill={btnTxt('RESTART')} fontSize="10.5" fontWeight="600"
              textAnchor="middle" dominantBaseline="central">RESTART</text>
          </g>
          <g style={{ cursor: btnCur('CONFIRM_CLEAN') }} onClick={() => onBtn('CONFIRM_CLEAN')}>
            <rect x="10" y="76" width="226" height="22" rx="5" fill={btnFill('CONFIRM_CLEAN')}/>
            <text x="123" y="87" fill={btnTxt('CONFIRM_CLEAN')} fontSize="9.5" fontWeight="600"
              textAnchor="middle" dominantBaseline="central">{t('hmi.btn.clean').toUpperCase()}</text>
          </g>
          <g style={{ cursor: btnCur('FINALIZE') }} onClick={() => onBtn('FINALIZE')}>
            <rect x="244" y="76" width="226" height="22" rx="5" fill={btnFill('FINALIZE')}/>
            <text x="357" y="87" fill={btnTxt('FINALIZE')} fontSize="10.5" fontWeight="600" letterSpacing="1"
              textAnchor="middle" dominantBaseline="central">{t('hmi.btn.finalize').toUpperCase()}</text>
          </g>

          {/* ── DIGITAL INPUTS ── */}
          <rect x="10" y="100" width="460" height="58" rx="6" fill="#0B1726" stroke="#1E3A5F"
            strokeWidth="1.5" filter="url(#hmiShadow)"/>
          <text x="18" y="113" fill="#6FA8FF" fontSize="8" fontWeight="700" letterSpacing="2">DIGITAL INPUTS</text>

          <circle cx="35.6"  cy="132" r="5" fill={led('I_CONVEYOR_PHOTOEYE', '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="35.6"  y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Conveyor</text>

          <circle cx="86.7"  cy="132" r="5" fill={led('I_FIXTURE_1_PRESENT', '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="86.7"  y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Fixture 1</text>

          <circle cx="137.8" cy="132" r="5" fill={led('I_FIXTURE_2_PRESENT', '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="137.8" y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Fixture 2</text>

          <circle cx="188.9" cy="132" r="5" fill={led('I_COBOT_MOVING', '#3B8BFF')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="188.9" y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Cobot Mov</text>

          {/* I_COBOT_READY — glow halo when ON */}
          {readyOn && <circle cx="240" cy="132" r="7" fill="#22FF66" opacity="0.28" filter="url(#hmiGlow)"/>}
          <circle cx="240" cy="132" r="5"
            fill={led('I_COBOT_READY', '#22FF66')}
            stroke={readyOn ? '#0AE05A' : '#1E3A5F'} strokeWidth="1"
            filter={readyOn ? 'url(#hmiGlow)' : undefined}/>
          <text x="240" y="145" fill={readyOn ? '#DDEEFF' : '#8AA7C7'} fontSize="6" textAnchor="middle">Cobot Rdy</text>

          <circle cx="291.1" cy="132" r="5" fill={led('I_GRIPPER_OPEN',   '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="291.1" y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Grip Open</text>

          <circle cx="342.2" cy="132" r="5" fill={led('I_GRIPPER_CLOSED', '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="342.2" y="145" fill="#8AA7C7" fontSize="6" textAnchor="middle">Grip Clsd</text>

          {/* ── CAMERA ── */}
          <rect x="10" y="162" width="296" height="42" rx="6" fill="#0B1726" stroke="#1E3A5F"
            strokeWidth="1.5" filter="url(#hmiShadow)"/>
          <text x="18" y="175" fill="#6FA8FF" fontSize="8" fontWeight="700" letterSpacing="2">CAMERA</text>
          <rect x="64" y="180" width="232" height="18" rx="3" fill="#06101C" stroke="#1E3A5F" strokeWidth="1"/>
          <text x="18" y="190" fill="#8AA7C7" fontSize="7" dominantBaseline="central">{t('hmi.camLabel')}</text>
          <text x="72" y="190" fill={camFill()} fontSize="11" fontWeight="700" dominantBaseline="central">
            {camText()}
          </text>

          {/* ── DIGITAL OUTPUTS ── */}
          <rect x="10" y="210" width="296" height="54" rx="6" fill="#0B1726" stroke="#1E3A5F"
            strokeWidth="1.5" filter="url(#hmiShadow)"/>
          <text x="18" y="223" fill="#6FA8FF" fontSize="8" fontWeight="700" letterSpacing="2">DIGITAL OUTPUTS</text>

          <circle cx="98.8"  cy="242" r="6" fill={led('O_CONVEYOR_MOTOR',   '#22FF66')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="98.8"  y="257" fill="#8AA7C7" fontSize="6.5" textAnchor="middle">Conv Motor</text>

          <circle cx="158"   cy="242" r="6" fill={led('O_CAMERA_TRIGGER',   '#3B8BFF')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="158"   y="257" fill="#8AA7C7" fontSize="6.5" textAnchor="middle">Cam Trig</text>

          <circle cx="217.2" cy="242" r="6" fill={led('O_TABLE_NEMA_MOVING','#3B8BFF')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="217.2" y="257" fill="#8AA7C7" fontSize="6.5" textAnchor="middle">Disco</text>

          <circle cx="276.4" cy="242" r="6" fill={led('O_RIVET_ACTIVE',     '#F97316')} stroke="#1E3A5F" strokeWidth="1"/>
          <text x="276.4" y="257" fill="#8AA7C7" fontSize="6.5" textAnchor="middle">Rivet</text>

          {/* ── PRODUCTION COUNTERS ── */}
          <rect x="312" y="162" width="98" height="102" rx="6" fill="#0B1726" stroke="#1E3A5F"
            strokeWidth="1.5" filter="url(#hmiShadow)"/>
          <text x="320" y="175" fill="#6FA8FF" fontSize="8" fontWeight="700" letterSpacing="1.5">{t('hmi.production')}</text>
          <text x="320" y="197" fill="#8AA7C7" fontSize="7.5" dominantBaseline="central">{t('hmi.total')}</text>
          <text x="402" y="197" fill="#DDEEFF" fontSize="15" fontWeight="700" textAnchor="end" dominantBaseline="central">
            {cnt('COUNT.total')}
          </text>
          <text x="320" y="223" fill="#8AA7C7" fontSize="7.5" dominantBaseline="central">{t('hmi.accepted')}</text>
          <text x="402" y="223" fill="#22FF66" fontSize="15" fontWeight="700" textAnchor="end" dominantBaseline="central">
            {cnt('COUNT.accepted')}
          </text>
          <text x="320" y="249" fill="#8AA7C7" fontSize="7.5" dominantBaseline="central">{t('hmi.rejected')}</text>
          <text x="402" y="249" fill="#FF5566" fontSize="15" fontWeight="700" textAnchor="end" dominantBaseline="central">
            {cnt('COUNT.rejected')}
          </text>

          {/* ── STACKLIGHT ── */}
          <text x="440" y="170" fill="#6FA8FF" fontSize="7.5" fontWeight="700" letterSpacing="1" textAnchor="middle">
            STACKLIGHT
          </text>
          <rect x="418" y="176" width="44" height="84" rx="9" fill="#0A0F17" stroke="#1E3A5F" strokeWidth="1.5"/>
          <circle cx="440" cy="196" r="11" fill={led('O_STACKLIGHT_RED',    '#FF3B3B')} stroke="#1E3A5F" strokeWidth="1.5"/>
          <circle cx="440" cy="218" r="11" fill={led('O_STACKLIGHT_YELLOW', '#FBBF24')} stroke="#1E3A5F" strokeWidth="1.5"/>
          <circle cx="440" cy="240" r="11" fill={led('O_STACKLIGHT_GREEN',  '#22FF66')} stroke="#1E3A5F" strokeWidth="1.5"/>
        </svg>
      </div>
    </div>
  );
}
