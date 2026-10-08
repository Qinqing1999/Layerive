import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type ImageResizeMode, type ImageSourcePropType, type ImageStyle } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import { useTheme } from '../theme';

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
};

/**
 * expo-image 封装：自带磁盘+内存缓存与渐进加载（画廊长列表重复加载明显减少），
 * 网络异常或 URL 失效时显示占位提示，避免空白或闪烁。其余使用方式与 RN Image 一致。
 */
export function RemoteImage({ source, style, resizeMode = 'cover', fallbackLabel = '图片加载失败' }: Props) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const handleError = useCallback(() => setFailed(true), []);

  if (!source || failed) {
    return (
      <View style={[styles.fallback, { backgroundColor: colors.border }, style as any]}>
        <Text style={[styles.fallbackText, { color: colors.muted }]} numberOfLines={2}>{fallbackLabel}</Text>
      </View>
    );
  }
  return (
    <Image
      source={source as ImageProps['source']}
      style={style}
      contentFit={CONTENT_FIT[resizeMode] ?? 'cover'}
      transition={120}
      onError={handleError}
    />
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  fallbackText: { fontSize: 12, textAlign: 'center' },
});
