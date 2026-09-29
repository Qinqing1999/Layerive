/**
 * 生成 Android 启动图标全套资源：
 * - 自适应图标前景（ic_launcher_foreground.webp，5 个密度）
 * - 传统方形/圆形图标（ic_launcher.webp / ic_launcher_round.webp，5 个密度）
 * - 自适应图标背景渐变 drawable + 预览图
 * 用法：node scripts/make-icon.mjs
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const resDir = path.join(mobileRoot, 'android', 'app', 'src', 'main', 'res');

// —— 主视觉：层叠照片卡 + 星光（Layerive = 图层 + 生成） ——
// viewBox 1024。前景图内容控制在中央 ~62% 安全区内（自适应图标遮罩要求）。
const CARD_ART = `
  <!-- 后层卡片：旋转错位，四角露出形成层叠感 -->
  <g transform="translate(512 532)">
    <rect x="-236" y="-236" width="472" height="472" rx="72" fill="#ffffff" opacity="0.28" transform="rotate(-13)"/>
    <rect x="-236" y="-236" width="472" height="472" rx="72" fill="#ffffff" opacity="0.5" transform="rotate(8)"/>
  </g>
  <!-- 前层卡片：照片 -->
  <g transform="translate(512 516)">
    <rect x="-236" y="-236" width="472" height="472" rx="72" fill="#ffffff"/>
    <clipPath id="photo"><rect x="-188" y="-188" width="376" height="376" rx="48"/></clipPath>
    <g clip-path="url(#photo)">
      <rect x="-188" y="-188" width="376" height="376" fill="url(#sky)"/>
      <circle cx="76" cy="-58" r="54" fill="#ffd166"/>
      <path d="M -188 148 L -84 20 L -8 118 L 52 44 L 188 188 L 188 188 L -188 188 Z" fill="#7c5cff"/>
      <path d="M -8 118 L 52 44 L 188 188 L -60 188 Z" fill="#5a3fe0"/>
    </g>
    <!-- 星光：位于卡片右上方渐变区 -->
    <path d="M 262 -266 l 22 58 58 22 -58 22 -22 58 -22 -58 -58 -22 58 -22 Z" fill="#ffffff"/>
    <circle cx="330" cy="-150" r="12" fill="#ffffff" opacity="0.85"/>
  </g>`;

const DEFS = `
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#e9e4ff"/>
    <stop offset="1" stop-color="#c9baff"/>
  </linearGradient>`;

// 传统方形图标：整卡带圆角渐变底
const LEGACY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${DEFS}
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/>
      <stop offset="0.55" stop-color="#6d55f7"/>
      <stop offset="1" stop-color="#4b2fd6"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="216" fill="url(#bg)"/>
  ${CARD_ART}
</svg>`;

// 圆形图标：圆形渐变底
const ROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${DEFS}
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/>
      <stop offset="0.55" stop-color="#6d55f7"/>
      <stop offset="1" stop-color="#4b2fd6"/>
    </linearGradient>
  </defs>
  <circle cx="512" cy="512" r="512" fill="url(#bg)"/>
  ${CARD_ART}
</svg>`;

// 自适应前景：透明底，仅主视觉（整体再缩小到安全区）
const FOREGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${DEFS}</defs>
  <g transform="translate(512 512) scale(0.78) translate(-512 -512)">${CARD_ART}</g>
</svg>`;

const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

async function main() {
  await mkdir(path.join(mobileRoot, 'assets'), { recursive: true });

  // 预览图（给人看的）
  await sharp(Buffer.from(LEGACY_SVG)).png().toFile(path.join(mobileRoot, 'assets', 'icon-preview.png'));

  const legacyBuf = await sharp(Buffer.from(LEGACY_SVG)).resize(1024, 1024).png().toBuffer();
  const roundBuf = await sharp(Buffer.from(ROUND_SVG)).resize(1024, 1024).png().toBuffer();
  const fgBuf = await sharp(Buffer.from(FOREGROUND_SVG)).resize(1024, 1024).png().toBuffer();

  for (const [density, size, fgSize] of DENSITIES) {
    const dir = path.join(resDir, `mipmap-${density}`);
    await mkdir(dir, { recursive: true });
    await sharp(legacyBuf).resize(size, size).webp({ quality: 90 }).toFile(path.join(dir, 'ic_launcher.webp'));
    await sharp(roundBuf).resize(size, size).webp({ quality: 90 }).toFile(path.join(dir, 'ic_launcher_round.webp'));
    await sharp(fgBuf).resize(fgSize, fgSize).webp({ quality: 90 }).toFile(path.join(dir, 'ic_launcher_foreground.webp'));
  }

  // 自适应背景：品牌紫渐变
  const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <gradient android:angle="315" android:startColor="#7c5cff" android:centerColor="#6d55f7" android:endColor="#4b2fd6" android:type="linear"/>
</shape>
`;
  await mkdir(path.join(resDir, 'drawable'), { recursive: true });
  await writeFile(path.join(resDir, 'drawable', 'icon_background.xml'), bgXml, 'utf8');

  // anydpi-v26 指向渐变 drawable
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/icon_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
  await writeFile(path.join(resDir, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveXml, 'utf8');

  console.log('icon assets generated ✔');
}

main().catch((err) => { console.error(err); process.exit(1); });
