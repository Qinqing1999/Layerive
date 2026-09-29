import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeColors = {
  accent: string;
  accentLight: string;
  bg: string;
  canvasBg: string;
  card: string;
  input: string;
  text: string;
  textSecondary: string;
  muted: string;
  border: string;
  danger: string;
  success: string;
  warning: string;
};

export const palettes: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    accent: '#6d55f7',
    accentLight: '#e8e4ff',
    bg: '#f4f4f6',
    canvasBg: '#ececf0',
    card: '#ffffff',
    input: '#fafafa',
    text: '#1a1c22',
    textSecondary: '#5a5e68',
    muted: '#8b909b',
    border: '#e4e6eb',
    danger: '#e5484d',
    success: '#16a34a',
    warning: '#d97706',
  },
  dark: {
    accent: '#7c66ff',
    accentLight: '#2c2750',
    bg: '#121418',
    canvasBg: '#0d0f12',
    card: '#1b1e25',
    input: '#22262f',
    text: '#f0f1f3',
    textSecondary: '#b3b7c0',
    muted: '#7d828d',
    border: '#2a2d36',
    danger: '#ff6369',
    success: '#3dd68c',
    warning: '#f5a623',
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
};

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
};

// Shared text color that never changes with the theme (on accent / on danger).
export const onAccent = '#ffffff';

export type ThemeMode = 'light' | 'dark';

type ThemeContextValue = {
  colors: ThemeColors;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: palettes.light,
  mode: 'light',
  setMode: () => {},
  toggle: () => {},
});

const STORAGE_KEY = 'pixelforge-theme-mode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(systemScheme === 'dark' ? 'dark' : 'light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark') setModeState(saved);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode = prev === 'dark' ? 'light' : 'dark';
      void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ colors: palettes[mode], mode, setMode, toggle }),
    [mode, setMode, toggle],
  );

  if (!ready) return null;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
