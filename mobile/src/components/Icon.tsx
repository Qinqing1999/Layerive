import React from 'react';
import { Text } from 'react-native';

type IconProps = {
  name: string;
  size?: number;
  color?: string;
};

const ICONS: Record<string, string> = {
  plus: '+',
  search: '🔍',
  menu: '≡',
  close: '✕',
  back: '←',
  copy: '⎘',
  upload: '⇪',
  image: '🖼',
  models: '⚙',
  data: '💾',
  download: '↓',
  trash: '🗑',
  edit: '✎',
  check: '✓',
  image2: '🖼',
  settings: '⚙',
  logout: '⇤',
  heart: '♥',
  send: '➤',
  stop: '■',
  history: '🕘',
  compare: '⇋',
  star: '☆',
  starFilled: '★',
  text: 'T',
  region: '⬚',
  expand: '⤢',
  enhance: '✦',
  droplet: '💧',
  crop: '✂',
  batch: '≣',
  gallery: '✨',
  share: '⇱',
  moon: '🌙',
  sun: '☀️',
  import: '⇩',
  rename: '✏️',
  folder: '📁',
  zip: '📦',
};

export function Icon({ name, size = 18, color = '#8b909b' }: IconProps) {
  const icon = ICONS[name] || name;
  return <Text style={{ fontSize: size, color }} allowFontScaling={false}>{icon}</Text>;
}
