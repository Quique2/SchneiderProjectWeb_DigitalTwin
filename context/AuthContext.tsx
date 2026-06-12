import React, { createContext, useContext, useState } from 'react';

export type UserRole = 'ADMIN' | 'DEMO' | 'OPERATOR';

export interface AuthUser {
  email: string;
  role: UserRole;
}

interface AuthCtxValue {
  user: AuthUser | null;
  login: (email: string, password: string) => boolean;
  logout: () => void;
}

const USERS: Array<{ email: string; password: string; role: UserRole }> = [
  { email: 'kiki7o@outlook.es',  password: 'Loteria6677-', role: 'ADMIN' },
  { email: 'kiko67ui@gmail.com', password: '12345678',     role: 'DEMO' },
  { email: 'kiko11@live.com.mx', password: '12345678',     role: 'OPERATOR' },
];

export const ROLE_TABS: Record<UserRole, string[]> = {
  ADMIN:    ['inicio', 'wiring', 'cell', 'live', 'logic', 'scada', 'scadasim'],
  DEMO:     ['inicio', 'wiring', 'cell', 'live', 'logic', 'scada', 'scadasim'],
  OPERATOR: ['inicio', 'wiring', 'live', 'logic', 'scada'],
};

const STORAGE_KEY = 'schneider_auth_user';

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed?.email && parsed?.role) return parsed;
    return null;
  } catch {
    return null;
  }
}

const AuthCtx = createContext<AuthCtxValue>({
  user: null,
  login: () => false,
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(loadUser);

  const login = (email: string, password: string): boolean => {
    const found = USERS.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
    );
    if (!found) return false;
    const authUser: AuthUser = { email: found.email, role: found.role };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
    setUser(authUser);
    return true;
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthCtxValue {
  return useContext(AuthCtx);
}
