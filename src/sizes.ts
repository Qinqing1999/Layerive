// Image size options differ per provider. SenseNova exposes eleven 2K
// constants, while OpenAI's image API accepts only three fixed sizes plus an
// `auto` default. The workspace picker filters this list by the active
// model's provider so users can only choose sizes the provider supports.
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

export const DEFAULT_SENSENOVA_SIZE = '2048x2048';
export const DEFAULT_OPENAI_SIZE = '1024x1024';

export function sizesForProvider(provider: string | undefined): SizeOption[] {
  return provider === 'sensenova' ? SENSENOVA_SIZES : OPENAI_SIZES;
}

export function defaultSizeForProvider(provider: string | undefined): string {
  return provider === 'sensenova' ? DEFAULT_SENSENOVA_SIZE : DEFAULT_OPENAI_SIZE;
}

export function isValidSizeForProvider(provider: string | undefined, size: string): boolean {
  return sizesForProvider(provider).some((option) => option.value === size);
}

function optionRatio(option: SizeOption): number {
  const [width, height] = option.value.split('x').map(Number);
  return width / height;
}

function logRatioGap(ratioA: number, ratioB: number): number {
  return Math.abs(Math.log(ratioA / ratioB));
}

// Mainstream canvas ratios, ordered by how commonly they are used. The
// outpaint panel maps these onto each provider's supported sizes so users
// pick a familiar ratio instead of raw pixel dimensions.
export const MAINSTREAM_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;

// Map a mainstream ratio onto the provider size whose aspect ratio is closest.
function sizeOptionForRatio(provider: string | undefined, ratio: string): SizeOption {
  const target = Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]);
  return sizesForProvider(provider).reduce((closest, option) =>
    logRatioGap(optionRatio(option), target) < logRatioGap(optionRatio(closest), target) ? option : closest);
}

// Mainstream ratio presets, deduplicated by mapped size so every button is a
// distinct choice; the chip keeps the requested ratio plus the real size.
export function mainstreamSizeOptions(provider: string | undefined): SizeOption[] {
  const seen = new Set<string>();
  const options: SizeOption[] = [];
  for (const ratio of MAINSTREAM_RATIOS) {
    const mapped = sizeOptionForRatio(provider, ratio);
    if (seen.has(mapped.value)) continue;
    seen.add(mapped.value);
    options.push({ value: mapped.value, ratio, label: mapped.label });
  }
  return options;
}

// Providers accept a small set of canvas sizes. For uploaded source images,
// choose the option whose aspect ratio is closest on a logarithmic scale so
// portrait and landscape mismatches are penalized symmetrically.
export function closestSizeForDimensions(provider: string | undefined, width: number | null, height: number | null): string {
  if (!width || !height || width <= 0 || height <= 0) return defaultSizeForProvider(provider);
  const ratio = width / height;
  return sizesForProvider(provider).reduce((closest, option) =>
    logRatioGap(optionRatio(option), ratio) < logRatioGap(optionRatio(closest), ratio) ? option : closest).value;
}

// Output format and transparent background are OpenAI-only capabilities.
export const OUTPUT_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number]['value'];
