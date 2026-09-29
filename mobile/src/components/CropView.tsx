import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTheme } from '../theme';

type CropAsset = {
  data: string;
  mimeType: string;
  name: string;
};

type Props = {
  visible: boolean;
  uri: string;
  /** 依据 EXIF 计算的顺时针旋转角度（Android 原生裁剪不自动烘焙 EXIF 方向，需先旋转再裁剪） */
  rotation?: number;
  onCancel: () => void;
  onUseOriginal: (asset: CropAsset) => void;
  onConfirm: (asset: CropAsset) => void;
};

type DragRect = { x: number; y: number; width: number; height: number };

/** 选区有效性阈值：与工作台「局部」框选一致（占比 ≥2%） */
const MIN_PERCENT = 2;

/**
 * 上传裁剪：与工作台「局部」框选同款交互——
 * 在图片上拖拽画出选区（松手保持，可重新拖拽改选），确认后按选区裁剪导入。
 */
export function CropView({ visible, uri, rotation = 0, onCancel, onUseOriginal, onConfirm }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [busy, setBusy] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<View | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  // 手势回调经 ref 读取最新显示区，保证 PanResponder 只创建一次（拖动中不替换 panHandlers）
  const displayRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDragRect(null);
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => alive && setImgSize({ w, h }),
      () => alive && setImgSize({ w: 1000, h: 1000 })
    );
    return () => {
      alive = false;
    };
  }, [visible, uri]);

  // contain 适配后的图片显示区（相对容器），与「局部」的 imageDisplay 同一算法
  const display = useMemo(() => {
    if (!imgSize || !box.w || !box.h) return null;
    const s = Math.min(box.w / imgSize.w, box.h / imgSize.h);
    const w = imgSize.w * s;
    const h = imgSize.h * s;
    return { w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 };
  }, [imgSize, box]);
  displayRef.current = display;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const d = displayRef.current;
          if (!d) return;
          // Android 上 locationX 会随子 View 边界跳变，统一用 pageX 减容器原点
          const px = e.nativeEvent.pageX - originRef.current.x;
          const py = e.nativeEvent.pageY - originRef.current.y;
          const p = {
            x: Math.max(d.x, Math.min(d.x + d.w, px)),
            y: Math.max(d.y, Math.min(d.y + d.h, py)),
          };
          dragStartRef.current = p;
          setDragRect({ x: p.x, y: p.y, width: 0, height: 0 });
        },
        onPanResponderMove: (e) => {
          const start = dragStartRef.current;
          const d = displayRef.current;
          if (!start || !d) return;
          const px = e.nativeEvent.pageX - originRef.current.x;
          const py = e.nativeEvent.pageY - originRef.current.y;
          const left = Math.max(d.x, Math.min(start.x, px));
          const right = Math.min(d.x + d.w, Math.max(start.x, px));
          const top = Math.max(d.y, Math.min(start.y, py));
          const bottom = Math.min(d.y + d.h, Math.max(start.y, py));
          setDragRect({ x: left, y: top, width: right - left, height: bottom - top });
        },
        onPanResponderRelease: () => { dragStartRef.current = null; },
      }),
    []
  );

  function handleLayout(e: { nativeEvent: { layout: { width: number; height: number } } }) {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
    containerRef.current?.measureInWindow((x, y) => {
      originRef.current = { x, y };
    });
  }

  // 选区有效性（与「局部」一致：≥2% × ≥2%）
  const percent = useMemo(() => {
    if (!dragRect || !display || display.w < 1 || display.h < 1) return null;
    return {
      w: (dragRect.width / display.w) * 100,
      h: (dragRect.height / display.h) * 100,
    };
  }, [dragRect, display]);
  const valid = !!percent && percent.w >= MIN_PERCENT && percent.h >= MIN_PERCENT;

  async function confirmCrop() {
    if (!imgSize || !display || !dragRect || !valid || busy) return;
    setBusy(true);
    try {
      const cropX = Math.round(((dragRect.x - display.x) / display.w) * imgSize.w);
      const cropY = Math.round(((dragRect.y - display.y) / display.h) * imgSize.h);
      const cropW = Math.max(1, Math.round((dragRect.width / display.w) * imgSize.w));
      const cropH = Math.max(1, Math.round((dragRect.height / display.h) * imgSize.h));
      // Android 原生裁剪不烘焙 EXIF：显示时已按 EXIF 转向，先旋转到显示方向再裁剪，
      // 否则带 EXIF 的照片裁出来区域和看到的不一致
      const actions: ImageManipulator.Action[] = [];
      if (rotation) actions.push({ rotate: rotation });
      actions.push({ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } });
      const out = await ImageManipulator.manipulateAsync(
        uri,
        actions,
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      if (!out.base64) throw new Error('裁剪失败，请重试');
      onConfirm({ data: out.base64, mimeType: 'image/jpeg', name: `crop-${Date.now()}.jpg` });
    } catch {
      // 保留裁剪界面，用户可重试或取消
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={8} disabled={busy}>
            <Text style={styles.headerBtn}>取消</Text>
          </Pressable>
          <Text style={styles.headerTitle}>裁剪图片</Text>
          <View style={{ width: 44 }} />
        </View>

        <View style={styles.canvas}>
          <View ref={containerRef} style={styles.canvasInner} onLayout={handleLayout} {...pan.panHandlers}>
            {display && (
              <>
                <Image
                  source={{ uri }}
                  style={{
                    position: 'absolute',
                    left: display.x,
                    top: display.y,
                    width: display.w,
                    height: display.h,
                  }}
                  resizeMode="stretch"
                />
                {/* 选区外四块半透明遮罩 + 边框 + 四角指示点（与「局部」蒙版一致） */}
                {dragRect ? (
                  <View pointerEvents="none" style={styles.maskLayer}>
                    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: Math.max(0, dragRect.y), backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: 0, right: 0, top: dragRect.y + dragRect.height, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: 0, top: dragRect.y, width: Math.max(0, dragRect.x), height: dragRect.height, backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: dragRect.x + dragRect.width, right: 0, top: dragRect.y, height: dragRect.height, backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: dragRect.x, top: dragRect.y, width: dragRect.width, height: dragRect.height, borderWidth: 2, borderColor: colors.accent, borderRadius: 8 }} />
                    <View style={[styles.cornerDot, { left: dragRect.x - 4, top: dragRect.y - 4 }]} />
                    <View style={[styles.cornerDot, { left: dragRect.x + dragRect.width - 4, top: dragRect.y - 4 }]} />
                    <View style={[styles.cornerDot, { left: dragRect.x - 4, top: dragRect.y + dragRect.height - 4 }]} />
                    <View style={[styles.cornerDot, { left: dragRect.x + dragRect.width - 4, top: dragRect.y + dragRect.height - 4 }]} />
                  </View>
                ) : null}
              </>
            )}
          </View>
        </View>

        <View style={styles.footer}>
          <Pressable
            style={[styles.footerBtn, { backgroundColor: 'transparent' }]}
            onPress={() => onUseOriginal({ data: '', mimeType: '', name: '' })}
            disabled={busy}
          >
            <Text style={styles.footerGhost}>使用原图</Text>
          </Pressable>
          <Text style={styles.sizeText}>
            {valid && percent ? `${percent.w.toFixed(0)}% × ${percent.h.toFixed(0)}%` : '拖拽框选裁剪范围'}
          </Text>
          <Pressable
            style={[styles.footerBtn, (!valid || busy) && { opacity: 0.4 }]}
            onPress={confirmCrop}
            disabled={!valid || busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.footerPrimary}>裁剪导入</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: '#000' },
    header: {
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'rgba(255,255,255,0.15)',
    },
    headerBtn: { color: '#fff', fontSize: 15, width: 44 },
    headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
    canvas: { flex: 1, paddingHorizontal: 32 },
    canvasInner: { flex: 1 },
    maskLayer: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
    cornerDot: {
      position: 'absolute',
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.accent,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 16,
      paddingBottom: 28,
    },
    footerBtn: {
      backgroundColor: c.accent,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    footerGhost: { color: '#fff', fontSize: 15, fontWeight: '500' },
    footerPrimary: { color: '#fff', fontSize: 15, fontWeight: '600' },
    sizeText: { flex: 1, color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center' },
  });
