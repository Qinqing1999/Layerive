import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { imageSource } from '../../api';
import { RemoteImage } from '../../components/RemoteImage';
import { useTheme } from '../../theme';
import { fontSize, spacing } from '../../theme';

type Props = {
  beforeUrl: string | null;
  afterUrl: string | null;
  beforeLabel: string;
  afterLabel: string;
};

/** Side-by-side slider comparison: before image underneath, after image clipped from the left. */
export function CompareModal({ beforeUrl, afterUrl, beforeLabel, afterLabel }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [pos, setPos] = useState(0.5);
  const [width, setWidth] = useState(0);
  const [originX, setOriginX] = useState(0);
  const posRef = useRef(0.5);
  posRef.current = pos;
  const stageRef = useRef<View>(null);

  // 用 measureInWindow 获取屏幕绝对坐标，避免嵌套容器导致 layout.x 不准
  useEffect(() => {
    stageRef.current?.measureInWindow((x, _y, w) => {
      setOriginX(x);
      setWidth(w);
    });
  }, []);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (evt) => {
      if (!width) return;
      // Android: locationX 会随子 View 边界跳变，统一用 pageX 减容器原点
      const x = evt.nativeEvent.pageX - originX;
      setPos(Math.max(0, Math.min(1, x / width)));
    },
  }), [width, originX]);

  const hasBefore = Boolean(beforeUrl);
  const hasAfter = Boolean(afterUrl);

  return (
    <View style={styles.container}>
      {(!hasBefore || !hasAfter) ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>
            {!hasBefore && !hasAfter ? '暂无对比图片' : !hasBefore ? '没有原图可对比' : '没有结果图可对比'}
          </Text>
          <Text style={styles.emptyHint}>先生成或选择版本后再来对比</Text>
        </View>
      ) : (
      <View
        ref={stageRef}
        style={styles.stage}
        {...pan.panHandlers}
      >
        {beforeUrl && <RemoteImage source={imageSource(beforeUrl, 1280)} style={StyleSheet.absoluteFill as any} resizeMode="contain" />}
        {afterUrl && width > 0 && (
          <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: width * pos, overflow: 'hidden' }}>
            <RemoteImage source={imageSource(afterUrl, 1280)} style={{ position: 'absolute', left: 0, top: 0, width, height: '100%' }} resizeMode="contain" />
          </View>
        )}
        {width > 0 && (
          <View pointerEvents="none" style={{ position: 'absolute', left: width * pos - 1, top: 0, bottom: 0, width: 2, backgroundColor: '#fff' }}>
            <View style={styles.knob} />
          </View>
        )}
        <Text style={[styles.tag, styles.tagLeft]}>{beforeLabel}</Text>
        <Text style={[styles.tag, styles.tagRight]}>{afterLabel}</Text>
      </View>
      )}
      {hasBefore && hasAfter ? <Text style={styles.hint}>左右拖动分割线对比前后效果</Text> : null}
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.canvasBg, padding: spacing.md },
    stage: { flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    emptyText: { color: c.text, fontSize: fontSize.lg },
    emptyHint: { color: c.muted, fontSize: fontSize.sm },
    knob: {
      position: 'absolute', top: '50%', left: -14, width: 28, height: 28, borderRadius: 14,
      backgroundColor: 'rgba(255,255,255,0.9)', marginTop: -14,
      alignItems: 'center', justifyContent: 'center',
    },
    tag: {
      position: 'absolute', top: spacing.md, fontSize: fontSize.xs, color: '#fff',
      backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: 6, overflow: 'hidden',
    },
    tagLeft: { left: spacing.md },
    tagRight: { right: spacing.md },
    hint: { textAlign: 'center', color: c.muted, fontSize: fontSize.sm, paddingVertical: spacing.md },
  });
