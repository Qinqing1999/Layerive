// Mirrors the desktop size catalogue (src/sizes.ts): providers only accept a
// fixed set of canvas sizes, and the outpaint sheet maps mainstream ratios
// onto them, preferring the original image's own ratio first.
export type SizeOption = { value: string; ratio: string; label: string };

export const SENSENOVA_SIZES: SizeOption[] = [
  { value: '1664x2496', ratio: '2:3', label: '竖版' },
  { value: '2496x1664', ratio: '3:2', label: '横版' },
  { value: '1760x2368', ratio: '3:4', label: '竖版' },
  { value: '2368x1760', ratio: '4:3', label: '横版' },
  { value: '1824x2272', ratio: '4:5', label: '竖版' },
  { value: '2272x1824', ratio: '5:4', label: '横版' },
  { value: '2048x2048', ratio: '1:1', label: '方形' },
  { value: '2752x1536', ratio: '16:9', label: '横版' },
  { value: '1536x2752', ratio: '9:16', label: '竖版' },
  { value: '3072x1376', ratio: '21:9', label: '超宽' },
  { value: '1344x3136', ratio: '9:21', label: '超长' },
];

export const OPENAI_SIZES: SizeOption[] = [
  { value: '1024x1024', ratio: '1:1', label: '方形' },
  { value: '1536x1024', ratio: '3:2', label: '横版' },
  { value: '1024x1536', ratio: '2:3', label: '竖版' },
];

export function sizesForProvider(provider: string | undefined): SizeOption[] {
  return provider === 'sensenova' ? SENSENOVA_SIZES : OPENAI_SIZES;
}

const MAINSTREAM_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

function optionRatio(option: SizeOption): number {
  const [width, height] = option.value.split('x').map(Number);
  return width / height;
}

function logRatioGap(ratioA: number, ratioB: number): number {
  return Math.abs(Math.log(ratioA / ratioB));
}

export function closestSizeForDimensions(provider: string | undefined, width?: number | null, height?: number | null): string {
  const sizes = sizesForProvider(provider);
  if (!width || !height || width <= 0 || height <= 0) return sizes[0].value;
  const ratio = width / height;
  return sizes.reduce((closest, option) =>
    logRatioGap(optionRatio(option), ratio) < logRatioGap(optionRatio(closest), ratio) ? option : closest).value;
}

export type OutpaintPreset = { size: string; label: string; original?: boolean };

// Outpaint presets: the original image ratio first (mapped to the closest
// supported size), then mainstream ratios deduplicated by mapped size.
export function outpaintPresets(provider: string | undefined, width?: number | null, height?: number | null): OutpaintPreset[] {
  const presets: OutpaintPreset[] = [];
  if (width && height && width > 0 && height > 0) {
    presets.push({ size: closestSizeForDimensions(provider, width, height), label: '原比例', original: true });
  }
  const seen = new Set(presets.map((preset) => preset.size));
  for (const ratio of MAINSTREAM_RATIOS) {
    const mapped = sizesForProvider(provider).reduce((closest, option) =>
      logRatioGap(optionRatio(option), Number(ratio.split(':')[0]) / Number(ratio.split(':')[1])) < logRatioGap(optionRatio(closest), Number(ratio.split(':')[0]) / Number(ratio.split(':')[1])) ? option : closest);
    if (seen.has(mapped.value)) continue;
    seen.add(mapped.value);
    presets.push({ size: mapped.value, label: ratio });
  }
  return presets;
}
