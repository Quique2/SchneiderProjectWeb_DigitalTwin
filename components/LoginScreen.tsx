import React, { useState } from 'react';
import { useThemeCtx } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { LANG_LABELS, Lang } from '../translations';

const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

export default function LoginScreen() {
  const { T, isDark, toggle } = useThemeCtx();
  const { login } = useAuth();
  const { lang, setLang } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const ok = login(email.trim(), password);
    if (!ok) setError('Credenciales incorrectas / Wrong credentials');
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 10,
    color: T.text, fontSize: 13, fontFamily: SANS,
    padding: '11px 14px', outline: 'none', transition: 'border-color 0.15s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: T.bg, fontFamily: SANS,
    }}>
      {/* Subtle grid backdrop */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.03, pointerEvents: 'none',
        backgroundImage: 'linear-gradient(#22c55e 1px, transparent 1px), linear-gradient(90deg, #22c55e 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }} />

      {/* Top-right controls */}
      <div style={{
        position: 'absolute', top: 16, right: 20,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {/* Language selector */}
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          style={{
            background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 6,
            color: T.text, fontSize: 11, fontWeight: 600, padding: '5px 6px',
            cursor: 'pointer', fontFamily: SANS, outline: 'none',
          }}
        >
          {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
            <option key={l} value={l}>{LANG_LABELS[l]}</option>
          ))}
        </select>

        {/* Light / Dark toggle */}
        <div style={{
          display: 'flex', gap: 2,
          background: T.panel2, border: `1px solid ${T.border}`,
          borderRadius: 6, padding: 2,
        }}>
          <button
            onClick={() => isDark && toggle()}
            style={{
              padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 600, fontFamily: SANS,
              background: !isDark ? '#3b82f6' : 'transparent',
              color: !isDark ? '#fff' : T.muted,
              transition: 'all 0.15s',
            }}
          >☀ Light</button>
          <button
            onClick={() => !isDark && toggle()}
            style={{
              padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 600, fontFamily: SANS,
              background: isDark ? T.panel : 'transparent',
              color: isDark ? '#7ab4f0' : T.muted,
              transition: 'all 0.15s',
            }}
          >☽ Dark</button>
        </div>
      </div>

      <div style={{
        position: 'relative', width: '100%', maxWidth: 400,
        background: T.panel, border: `1px solid ${T.border}`,
        borderRadius: 20, overflow: 'hidden',
        boxShadow: T.dark ? '0 28px 64px rgba(0,0,0,0.65)' : '0 12px 40px rgba(0,0,0,0.14)',
      }}>
        {/* Top stripe */}
        <div style={{ height: 4, background: 'linear-gradient(90deg,#22c55e 0%,#16a34a 55%,#d97740 100%)' }} />

        {/* Header */}
        <div style={{ padding: '28px 36px 22px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg,#22c55e 0%,#16a34a 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 800, color: '#fff', flexShrink: 0,
            }}>SE</div>
            <div>
              <div style={{ fontSize: 9, letterSpacing: 3, color: '#22c55e', textTransform: 'uppercase', fontWeight: 700 }}>
                Schneider Electric · Challenge 2026
              </div>
              <div style={{ fontSize: 19, fontWeight: 700, color: T.text, letterSpacing: -0.3, lineHeight: 1.2 }}>
                Digital Twin
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 10 }}>
            Ingrese sus credenciales para continuar
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '24px 36px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700, color: T.muted, marginBottom: 7 }}>
              Correo electrónico
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="usuario@ejemplo.com"
              required
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#22c55e')}
              onBlur={(e) => (e.currentTarget.style.borderColor = T.border)}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700, color: T.muted, marginBottom: 7 }}>
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              required
              style={inputStyle}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#22c55e')}
              onBlur={(e) => (e.currentTarget.style.borderColor = T.border)}
            />
          </div>

          {error && (
            <div style={{
              background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
              borderRadius: 9, padding: '9px 13px', fontSize: 12.5, color: '#f87171',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            style={{
              marginTop: 2, width: '100%', padding: '12px', border: 'none', borderRadius: 10,
              background: 'linear-gradient(180deg,#22c55e 0%,#15803d 100%)',
              color: '#fff', fontSize: 13.5, fontWeight: 700, letterSpacing: 0.3,
              cursor: 'pointer', fontFamily: SANS, transition: 'opacity 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
          >
            Ingresar
          </button>
        </form>
      </div>
    </div>
  );
}
