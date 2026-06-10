import React from 'react';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

export default function Footer() {
  const T = useTheme();
  const { t } = useLanguage();
  return (
    <div style={{
      borderTop: `1px solid ${T.border}`,
      padding: '28px 24px',
      background: T.dark ? 'rgba(0,0,0,0.3)' : T.panel2,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 4, height: 24, background: 'linear-gradient(180deg,#22c55e,#0ea5e9)', borderRadius: 2 }} />
        <div>
          <div style={{ fontSize: 10, letterSpacing: 3, color: '#22c55e', textTransform: 'uppercase' }}>
            {t('footer.challenge')}
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
            {t('footer.team')}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: T.dim }}>
        {t('footer.generated')}
      </div>
    </div>
  );
}
