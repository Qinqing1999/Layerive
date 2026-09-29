import React from 'react';
import { Ionicons } from '@expo/vector-icons';

export type IconName =
  | 'plus'
  | 'search'
  | 'menu'
  | 'close'
  | 'back'
  | 'copy'
  | 'upload'
  | 'image'
  | 'models'
  | 'data'
  | 'download'
  | 'trash'
  | 'edit'
  | 'check'
  | 'settings'
  | 'logout'
  | 'heart'
  | 'send'
  | 'stop'
  | 'history'
  | 'compare'
  | 'star'
  | 'starFilled'
  | 'text'
  | 'region'
  | 'expand'
  | 'enhance'
  | 'droplet'
  | 'crop'
  | 'batch'
  | 'gallery'
  | 'share'
  | 'moon'
  | 'sun'
  | 'import'
  | 'rename'
  | 'folder'
  | 'zip'
  | 'chevronRight'
  | 'chevronDown';

type IconProps = {
  name: IconName | string;
  size?: number;
  color?: string;
};

// 把业务图标名映射到 Ionicons 的图标名（iOS 风格）
const ICON_MAP: Record<string, keyof typeof Ionicons.glyphMap> = {
  plus: 'add',
  search: 'search',
  menu: 'menu',
  close: 'close',
  back: 'arrow-back',
  copy: 'copy',
  upload: 'cloud-upload',
  image: 'image',
  models: 'cube',
  data: 'server',
  download: 'cloud-download',
  trash: 'trash',
  edit: 'create',
  check: 'checkmark',
  settings: 'settings',
  logout: 'log-out',
  heart: 'heart',
  send: 'send',
  stop: 'stop',
  history: 'time',
  compare: 'swap-horizontal',
  star: 'star-outline',
  starFilled: 'star',
  text: 'text',
  region: 'scan',
  expand: 'expand',
  enhance: 'sparkles',
  droplet: 'water',
  crop: 'crop',
  batch: 'layers',
  gallery: 'images',
  share: 'share',
  moon: 'moon',
  sun: 'sunny',
  import: 'download',
  rename: 'create',
  folder: 'folder',
  zip: 'file-tray',
  chevronRight: 'chevron-forward',
  chevronDown: 'chevron-down',
};

export function Icon({ name, size = 18, color = '#8b909b' }: IconProps) {
  const glyph = ICON_MAP[name] || (name as keyof typeof Ionicons.glyphMap);
  return <Ionicons name={glyph} size={size} color={color} />;
}
