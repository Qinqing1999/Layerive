import React, { useCallback, useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageResizeMode, type ImageStyle, type ImageSourcePropType } from 'react-native';
import { useTheme } from '../theme';

type Props = {
  source: ImageSourcePropType | undefined;
  style?: ImageStyle | ImageStyle[];
  resizeMode?: ImageResizeMode;
  /** 加载/失败占位提示文案 */
  fallbackLabel?: string;
};

/**
 * 带加载失败兜底的远程图片组件：网络异常或 URL 失效时显示占位图，
 * 避免出现空白或闪烁。其它使用方式与 RN Image 一致。
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
  return <Image source={source} style={style} resizeMode={resizeMode} onError={handleError} />;
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center', padding: 8 },
  fallbackText: { fontSize: 12, textAlign: 'center' },
});
