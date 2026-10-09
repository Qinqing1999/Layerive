import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type ImageResizeMode, type ImageSourcePropType, type ImageStyle } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import { useTheme } from '../theme';
import type { WatermarkConfig } from '../types';

/** RN resizeMode → expo-image contentFit 映射 */
const CONTENT_FIT: Partial<Record<ImageResizeMode, NonNullable<ImageProps['contentFit']>>> = {
  cover: 'cover',
  contain: 'contain',
  stretch: 'fill',
  center: 'none',
};

type Props = {
  source: ImageSourcePropType | undefined;
  style?: ImageStyle | ImageStyle[];
  resizeMode?: ImageResizeMode;
  /** 加载/失败占位提示文案 */
  fallbackLabel?: string;
  /** 水印配置：非 null 时叠加平铺水印层 */
  watermark?: WatermarkConfig | null;
};

/**
 * expo-image 封装：自带磁盘+内存缓存与渐进加载（画廊长列表重复加载明显减少），
 * 网络异常或 URL 失效时显示占位提示，避免空白或闪烁。其余使用方式与 RN Image 一致。
 */
export function RemoteImage({ source, style, resizeMode = 'cover', fallbackLabel = '图片加载失败', watermark }: Props) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const [layoutSize, setLayoutSize] = useState({ w: 0, h: 0 });
  const handleError = useCallback(() => setFailed(true), []);

  if (!source || failed) {
    return (
      <View style={[styles.fallback, { backgroundColor: colors.border }, style as any]}>
        <Text style={[styles.fallbackText, { color: colors.muted }]} numberOfLines={2}>{fallbackLabel}</Text>
      </View>
    );
  }
  return (
    <View
      style={style as any}
      onLayout={(e) => setLayoutSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <Image
        source={source as ImageProps['source']}
        style={StyleSheet.absoluteFill}
        contentFit={CONTENT_FIT[resizeMode] ?? 'cover'}
        transition={120}
        onError={handleError}
      />
      {watermark?.enabled && layoutSize.w > 0 && (
        <WatermarkLayer config={watermark} width={layoutSize.w} height={layoutSize.h} />
      )}
    </View>
  );
}

// 内联水印层（避免 WatermarkOverlay 循环依赖）
function WatermarkLayer({ config, width, height }: { config: WatermarkConfig; width: number; height: number }) {
  const cols = Math.ceil(width / config.spacing) + 2;
  const rows = Math.ceil(height / config.spacing) + 2;
  const items: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const offsetX = (r % 2) * (config.spacing / 2);
      items.push(
        <Text
          key={`${r}-${c}`}
          style={{
            position: 'absolute',
            left: c * config.spacing + offsetX,
            top: r * config.spacing,
            fontSize: config.fontSize,
            color: config.color,
            opacity: config.opacity,
            transform: [{ rotate: `${config.rotation}deg` }],
          }}
        >
          {config.text}
        </Text>
      );
    }
  }
  return <View style={StyleSheet.absoluteFill} pointerEvents="none">{items}</View>;
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  fallbackText: { fontSize: 12, textAlign: 'center' },
});
