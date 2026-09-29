import React, { useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { imageSource } from '../api';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import { Icon } from './Icon';

export type PercentRect = { x: number; y: number; width: number; height: number };

type Props = {
  imageUrl: string;
  imageWidth: number | null;
  imageHeight: number | null;
  title: string;
  hint: string;
  confirmLabel: string;
  onConfirm: (rect: PercentRect) => void;
  onCancel: () => void;
};

/**
 * Full-screen drag-to-select overlay. The image is letterboxed (aspect fit)
 * inside the content area; dragging anywhere draws a rectangle that is clamped
 * to the displayed image and reported in image percentages.
 */
export function RectSelector({ imageUrl, imageWidth, imageHeight, title, hint, confirmLabel, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [rect, setRect] = useState<PercentRect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const rectRef = useRef<PercentRect | null>(null);
  rectRef.current = rect;

  // Displayed image rect (aspect fit) inside the container.
  const display = useMemo(() => {
    const cw = containerSize.w;
    const ch = containerSize.h;
    if (!cw || !ch || !imageWidth || !imageHeight) return null;
    const scale = Math.min(cw / imageWidth, ch / imageHeight);
    const w = imageWidth * scale;
    const h = imageHeight * scale;
    return { left: (cw - w) / 2, top: (ch - h) / 2, w, h };
  }, [containerSize, imageWidth, imageHeight]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      startRef.current = { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
    },
    onPanResponderMove: (evt) => {
      const start = startRef.current;
      if (!start || !display) return;
      const x = evt.nativeEvent.locationX;
      const y = evt.nativeEvent.locationY;
      const left = Math.max(display.left, Math.min(start.x, x));
      const right = Math.min(display.left + display.w, Math.max(start.x, x));
      const top = Math.max(display.top, Math.min(start.y, y));
      const bottom = Math.min(display.top + display.h, Math.max(start.y, y));
      setRect({ x: left, y: top, width: right - left, height: bottom - top });
    },
    onPanResponderRelease: () => { startRef.current = null; },
  }), [display]);

  const percent = useMemo<PercentRect | null>(() => {
    if (!rect || !display || display.w < 1 || display.h < 1) return null;
    const x = ((rect.x - display.left) / display.w) * 100;
    const y = ((rect.y - display.top) / display.h) * 100;
    return {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
      width: Math.max(0, Math.min(100 - Math.max(0, x), (rect.width / display.w) * 100)),
      height: Math.max(0, Math.min(100 - Math.max(0, y), (rect.height / display.h) * 100)),
    };
  }, [rect, display]);

  const valid = !!percent && percent.width >= 2 && percent.height >= 2;

  return (
    <View style={styles.overlay}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={8} style={styles.closeBtn}>
          <Icon name="close" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={{ width: 28 }} />
      </View>
      <Text style={styles.hint}>{hint}</Text>
      <View
        style={styles.stage}
        onLayout={(e) => setContainerSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        {...panResponder.panHandlers}
      >
        <Image
          source={imageSource(imageUrl, 1280)}
          style={display ? { position: 'absolute', left: display.left, top: display.top, width: display.w, height: display.h } : styles.hiddenImage}
          resizeMode="stretch"
        />
        {rect && display && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height,
              borderWidth: 2, borderColor: colors.accent, backgroundColor: 'rgba(109,85,247,0.18)',
              borderRadius: radius.sm,
            }}
          />
        )}
      </View>
      <View style={styles.footer}>
        <Text style={styles.percentText}>
          {percent && valid
            ? `选区 x ${percent.x.toFixed(1)}% · y ${percent.y.toFixed(1)}% · ${percent.width.toFixed(1)}% × ${percent.height.toFixed(1)}%`
            : '在图片上拖拽框选一个区域'}
        </Text>
        <Pressable
          style={[styles.confirmBtn, !valid && { opacity: 0.4 }]}
          disabled={!valid}
          onPress={() => percent && valid && onConfirm(percent)}
        >
          <Text style={styles.confirmText}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    overlay: { flex: 1, backgroundColor: '#101114' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingTop: spacing.xl, paddingBottom: spacing.sm },
    closeBtn: { padding: spacing.xs },
    title: { flex: 1, textAlign: 'center', fontSize: fontSize.lg, fontWeight: '700', color: '#fff' },
    hint: { textAlign: 'center', fontSize: fontSize.sm, color: '#9aa0ab', paddingBottom: spacing.sm },
    stage: { flex: 1, margin: spacing.md, borderRadius: radius.md, overflow: 'hidden' },
    hiddenImage: { width: '100%', height: '100%' },
    footer: { padding: spacing.md, paddingBottom: spacing.xl },
    percentText: { textAlign: 'center', fontSize: fontSize.sm, color: '#c6cad2', marginBottom: spacing.md },
    confirmBtn: { height: 46, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    confirmText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
