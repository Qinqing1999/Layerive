import React, { useCallback, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View, type ImageResizeMode, type ImageSourcePropType, type ImageStyle } from 'react-native';
import { useTheme } from '../theme';

type Props = {
  source: ImageSourcePropType | undefined;
  style?: ImageStyle | ImageStyle[];
  resizeMode?: ImageResizeMode;
  fallbackLabel?: string;
};

/**
 * 可双指缩放、单指拖动的图片预览组件。
 * 单指始终可拖动；双指捏合可在 1x–5x 之间缩放，缩放回 1x 时自动复位平移。
 */
export function ZoomableImage({ source, style, resizeMode = 'contain', fallbackLabel = '图片加载失败' }: Props) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);

  const scale = useRef(new Animated.Value(1)).current;
  const lastScale = useRef(1);

  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // 上一次提交的平移值
  const lastTranslate = useRef({ x: 0, y: 0 });
  // 单指拖动起始时的基准（lastTranslate + grant 时的 dx/dy=0）
  const dragStart = useRef({ x: 0, y: 0 });
  // 双指初始距离
  const pinchStart = useRef<{ distance: number } | null>(null);
  // 是否正在双指缩放（缩放中禁用单指拖动，避免冲突）
  const isPinching = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, gestureState) => {
        // 任何移动都接管
        return gestureState.dx !== 0 || gestureState.dy !== 0 || gestureState.numberActiveTouches >= 2;
      },
      onPanResponderGrant: (e) => {
        if (e.nativeEvent.touches.length >= 2) {
          // 双指开始：记录初始距离
          const t1 = e.nativeEvent.touches[0];
          const t2 = e.nativeEvent.touches[1];
          const dx = t1.pageX - t2.pageX;
          const dy = t1.pageY - t2.pageY;
          pinchStart.current = { distance: Math.sqrt(dx * dx + dy * dy) };
          isPinching.current = true;
        } else {
          // 单指开始：清掉双指状态，记录拖动基准
          isPinching.current = false;
          pinchStart.current = null;
          dragStart.current = {
            x: (translate.x as any)._value || 0,
            y: (translate.y as any)._value || 0,
          };
        }
      },
      onPanResponderMove: (e, gestureState) => {
        const touches = e.nativeEvent.touches;
        if (touches.length >= 2 && pinchStart.current) {
          // 双指缩放
          const t1 = touches[0];
          const t2 = touches[1];
          const dx = t1.pageX - t2.pageX;
          const dy = t1.pageY - t2.pageY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const ratio = distance / pinchStart.current.distance;
          const newScale = Math.max(1, Math.min(5, lastScale.current * ratio));
          scale.setValue(newScale);
        } else if (touches.length === 1 && !isPinching.current) {
          // 单指拖动：基于 grant 时的基准 + 当前 dx/dy
          translate.setValue({
            x: dragStart.current.x + gestureState.dx,
            y: dragStart.current.y + gestureState.dy,
          });
        }
      },
      onPanResponderRelease: () => {
        // 提交当前 scale
        scale.stopAnimation((v) => {
          lastScale.current = (v as number) || 1;
          // 缩到 1 时复位平移
          if (lastScale.current <= 1.001) {
            translate.setValue({ x: 0, y: 0 });
          }
        });
        // 提交当前平移
        translate.stopAnimation((v) => {
          if (typeof v === 'object' && v !== null && 'x' in v && 'y' in v) {
            lastTranslate.current = { x: (v as any).x, y: (v as any).y };
          }
        });
        isPinching.current = false;
        pinchStart.current = null;
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  const handleError = useCallback(() => setFailed(true), []);

  if (!source || failed) {
    return (
      <View style={[styles.fallback, { backgroundColor: colors.border }, style as any]}>
        <Text style={[styles.fallbackText, { color: colors.muted }]} numberOfLines={2}>{fallbackLabel}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.container, style as any]} {...panResponder.panHandlers}>
      <Animated.Image
        source={source}
        style={[style, { transform: [{ scale }, { translateX: translate.x }, { translateY: translate.y }] }]}
        resizeMode={resizeMode}
        onError={handleError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignSelf: 'stretch' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  fallbackText: { fontSize: 12, textAlign: 'center' },
});
