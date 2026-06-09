import React, { createContext, useContext, useState } from 'react';

export interface Theme {
  dark: boolean;
  bg: string;
  bgGrad: string;
  panel: string;
  panel2: string;
  border: string;
  borderSoft: string;
  text: string;
  muted: string;
  dim: string;
  topbar: string;
  topbarBorder: string;
  // SVG diagram node tokens
  nodeBg: string;
  nodeBgDim: string;
  nodeBorder: string;
  nodeBorderDim: string;
  nodeText: string;
  nodeTextDim: string;
  nodeSublabel: string;
  nodeSublabelDim: string;
  connLine: string;
  connLabel: string;
}

const DARK: Theme = {
  dark: true,
  bg: '#06101c',
  bgGrad: 'linear-gradient(160deg,#06101c 0%,#0b1829 60%,#040c14 100%)',
  panel: '#0b1828',
  panel2: '#07101c',
  border: '#1a3550',
  borderSoft: '#0d1e30',
  text: '#f1f5f9',
  muted: '#7a9ab8',
  dim: '#2a4060',
  topbar: 'linear-gradient(180deg,#0c1a2c 0%,#070f1a 100%)',
  topbarBorder: '#1a2c44',
  nodeBg: '#0b1828',
  nodeBgDim: '#050d18',
  nodeBorder: '#1e3a5f',
  nodeBorderDim: '#080f1c',
  nodeText: '#7a9ab8',
  nodeTextDim: '#151f2b',
  nodeSublabel: '#2a4560',
  nodeSublabelDim: '#0d1824',
  connLine: '#1e3d60',
  connLabel: '#2a4f78',
};

const LIGHT: Theme = {
  dark: false,
  bg: '#f0f4f8',
  bgGrad: 'linear-gradient(160deg,#e8f0f8 0%,#f0f4f8 60%,#dce6f0 100%)',
  panel: '#ffffff',
  panel2: '#f8fafc',
  border: '#cbd5e1',
  borderSoft: '#e2e8f0',
  text: '#0f172a',
  muted: '#475569',
  dim: '#94a3b8',
  topbar: 'linear-gradient(180deg,#ffffff 0%,#f8fafc 100%)',
  topbarBorder: '#e2e8f0',
  nodeBg: '#ffffff',
  nodeBgDim: '#f8fafc',
  nodeBorder: '#94a3b8',
  nodeBorderDim: '#cbd5e1',
  nodeText: '#475569',
  nodeTextDim: '#c0ccda',
  nodeSublabel: '#64748b',
  nodeSublabelDim: '#d1d5db',
  connLine: '#94a3b8',
  connLabel: '#64748b',
};

interface ThemeCtx { T: Theme; isDark: boolean; toggle: () => void }
const Ctx = createContext<ThemeCtx>({ T: DARK, isDark: true, toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);
  const T = isDark ? DARK : LIGHT;
  return (
    <Ctx.Provider value={{ T, isDark, toggle: () => setIsDark((v) => !v) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(Ctx).T;
}

export function useThemeCtx(): ThemeCtx {
  return useContext(Ctx);
}
