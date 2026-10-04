import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';

type CropAsset = {
  data: string;
  mimeType: string;
  name: string;
};

type Props = {
  visible: boolean;
  uri: string;
  /** 依据 EXIF 计算的顺时针旋转角度（Android 原生裁剪不自动烘焙 EXIF，需先旋转再裁剪） */
  rotation?: number;
  onCancel: () => void;
  onUseOriginal: (asset: CropAsset) => void;
  onConfirm: (asset: CropAsset) => void;
};

type DragRect = { x: number; y: number; width: number; height: number };

/** 选区有效性阈值：与工作台「局部」框选一致（占比 ≥2%） */
const MIN_PERCENT = 2;
/** 缩放范围 */
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

/**
 * 上传裁剪：与工作台「局部」框选同款交互——
 * 在图片上拖拽画出选区（松手保持，可重新拖拽改选），确认后按选区裁剪导入。
 *
 * 关键：进入裁剪前先烘焙 EXIF 旋转，得到 normalized uri，
 * 后续显示和裁剪都基于 normalized 尺寸，避免坐标空间不一致。
 */
export function CropView({ visible, uri, rotation = 0, onCancel, onUseOriginal, onConfirm }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [normalizing, setNormalizing] = useState(false);
  /** 双指缩放进行中标记（防止 PanResponder 同时画选区） */
  const isPinchingRef = useRef(false);
  // 烘焙 EXIF 后的 uri（已旋转到正确方向，后续显示和裁剪都基于它）
  const [normalizedUri, setNormalizedUri] = useState<string | null>(null);
  const normalizedUriRef = useRef<string | null>(null);
  normalizedUriRef.current = normalizedUri;
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<View | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  // 手势回调经 ref 读取最新显示区，保证 PanResponder 只创建一次（拖动中不替换 panHandlers）
  const displayRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // ---- 缩放状态 ----
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const lastPinchDistRef = useRef(0);
  const pinchCenterRef = useRef({ x: 0, y: 0 });

  // 双指捏合手势（使用 onTouch 事件）
  function handleTouchStart(e: any) {
    const touches = e.nativeEvent.touches || [];
    if (touches.length === 2) {
      isPinchingRef.current = true;
      const t = touches as Array<{ pageX: number; pageY: number }>;
      const dx = t[0].pageX - t[1].pageX;
      const dy = t[0].pageY - t[1].pageY;
      lastPinchDistRef.current = Math.sqrt(dx * dx + dy * dy);
      pinchCenterRef.current = {
        x: (t[0].pageX + t[1].pageX) / 2,
        y: (t[0].pageY + t[1].pageY) / 2,
      };
    }
  }

  function handleTouchMove(e: any) {
    const touches = e.nativeEvent.touches || [];
    if (touches.length !== 2) return;
    const t = touches as Array<{ pageX: number; pageY: number }>;
    const dx = t[0].pageX - t[1].pageX;
    const dy = t[0].pageY - t[1].pageY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;
    const prev = lastPinchDistRef.current;
    if (prev === 0) { lastPinchDistRef.current = dist; return; }
    const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scaleRef.current * (dist / prev)));
    const cx = (t[0].pageX + t[1].pageX) / 2 - originRef.current.x;
    const cy = (t[0].pageY + t[1].pageY) / 2 - originRef.current.y;
    const d = displayRef.current;
    if (!d) return;
    const ratio = newScale / scaleRef.current;
    setOffset({
      x: offsetRef.current.x - (cx - d.x - d.w / 2) * (ratio - 1),
      y: offsetRef.current.y - (cy - d.y - d.h / 2) * (ratio - 1),
    });
    setScale(newScale);
    scaleRef.current = newScale;
    offsetRef.current = { x: offsetRef.current.x - (cx - d.x - d.w / 2) * (ratio - 1), y: offsetRef.current.y - (cy - d.y - d.h / 2) * (ratio - 1) };
    lastPinchDistRef.current = dist;
  }

  function handleTouchEnd() {
    lastPinchDistRef.current = 0;
    isPinchingRef.current = false;
  }

  // 进入裁剪界面时先烘焙 EXIF，得到 normalized uri
  // 这样 <Image> 显示的尺寸和 ImageManipulator 裁剪的尺寸就一致了
  useEffect(() => {
    if (!visible) return;
    setDragRect(null);
    setImgSize(null);
    setNormalizedUri(null);
    let alive = true;

    (async () => {
      let workUri = uri;
      if (rotation) {
        setNormalizing(true);
        try {
          const out = await ImageManipulator.manipulateAsync(
            uri,
            [{ rotate: rotation }],
            { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
          );
          if (!alive) return;
          workUri = out.uri;
        } catch {
          // 烘焙失败则退回原图（显示可能不对但至少不崩溃）
        } finally {
          if (alive) setNormalizing(false);
        }
      }
      if (!alive) return;
      setNormalizedUri(workUri);
      Image.getSize(
        workUri,
        (w, h) => alive && setImgSize({ w, h }),
        () => alive && setImgSize({ w: 1000, h: 1000 })
      );
    })();

    return () => {
      alive = false;
      // 清理临时文件
      const tmpUri = normalizedUriRef.current;
      if (tmpUri && tmpUri !== uri) {
        FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, uri, rotation]);

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
        onStartShouldSetPanResponder: () => !isPinchingRef.current,
      onMoveShouldSetPanResponder: () => !isPinchingRef.current,
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

  // 重置缩放
  function resetZoom() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
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
    if (!imgSize || !display || !dragRect || !valid || busy || !normalizedUri) return;
    setBusy(true);
    try {
      // normalizedUri 已经烘焙过 EXIF，直接按显示坐标映射裁剪即可
      const cropX = Math.round(((dragRect.x - display.x) / display.w) * imgSize.w);
      const cropY = Math.round(((dragRect.y - display.y) / display.h) * imgSize.h);
      const cropW = Math.max(1, Math.round((dragRect.width / display.w) * imgSize.w));
      const cropH = Math.max(1, Math.round((dragRect.height / display.h) * imgSize.h));
      const out = await ImageManipulator.manipulateAsync(
        normalizedUri,
        [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }],
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

  const showUri = normalizedUri || uri;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={8} disabled={busy}>
            <Text style={styles.headerBtn}>取消</Text>
          </Pressable>
          <Text style={styles.headerTitle}>裁剪图片</Text>
          <View style={{ width: 44 }} />
        </View>

        <View style={styles.canvas}>
          <View ref={containerRef} style={styles.canvasInner} onLayout={handleLayout} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} {...pan.panHandlers}>
            {normalizing ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loadingText}>正在处理图片…</Text>
              </View>
            ) : display && showUri ? (
              <>
                {/* 缩放后的图片容器 */}
                <View style={{
                  position: 'absolute',
                  left: display.x + offset.x,
                  top: display.y + offset.y,
                  width: display.w * scale,
                  height: display.h * scale,
                }}>
                  <Image
                    source={{ uri: showUri }}
                    style={{ width: display.w * scale, height: display.h * scale }}
                    resizeMode="stretch"
                  />
                </View>
                {/* 选区外四块半透明遮罩 + 边框 + 四角指示点（与「局部」蒙版一致） */}
                {/* 遮罩位置需要根据缩放调整 */}
                {dragRect ? (
                  <View pointerEvents="none" style={styles.maskLayer}>
                    <View style={{
                      position: 'absolute',
                      left: display.x + offset.x,
                      top: display.y + offset.y,
                      width: display.w * scale,
                      height: display.h * scale,
                    }}>
                      {/* 上方遮罩 */}
                      <View style={{
                        position: 'absolute', left: 0, right: 0, top: 0,
                        height: Math.max(0, ((dragRect.y - display.y - offset.y) / scale)),
                        backgroundColor: 'rgba(0,0,0,0.55)',
                      }} />
                      {/* 下方遮罩 */}
                      <View style={{
                        position: 'absolute', left: 0, right: 0,
                        top: ((dragRect.y - display.y - offset.y) / scale) + (dragRect.height / scale),
                        bottom: 0,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                      }} />
                      {/* 左方遮罩 */}
                      <View style={{
                        position: 'absolute', left: 0, top: (dragRect.y - display.y - offset.y) / scale,
                        width: Math.max(0, (dragRect.x - display.x - offset.x) / scale),
                        height: dragRect.height / scale,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                      }} />
                      {/* 右方遮罩 */}
                      <View style={{
                        position: 'absolute', right: 0, top: (dragRect.y - display.y - offset.y) / scale,
                        width: Math.max(0, (display.x + offset.x + display.w * scale - dragRect.x - dragRect.width - offset.x) / scale),
                        height: dragRect.height / scale,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                      }} />
                      {/* 选区边框 */}
                      <View style={{
                        position: 'absolute',
                        left: (dragRect.x - display.x - offset.x) / scale,
                        top: (dragRect.y - display.y - offset.y) / scale,
                        width: dragRect.width / scale,
                        height: dragRect.height / scale,
                        borderWidth: 2 / scale,
                        borderColor: colors.accent,
                        borderRadius: 8 / scale,
                      }} />
                      {/* 四角指示点 */}
                      {[
                        { l: dragRect.x, t: dragRect.y },
                        { l: dragRect.x + dragRect.width, t: dragRect.y },
                        { l: dragRect.x, t: dragRect.y + dragRect.height },
                        { l: dragRect.x + dragRect.width, t: dragRect.y + dragRect.height },
                      ].map((corner, i) => (
                        <View key={i} style={[
                          styles.cornerDot,
                          {
                            left: (corner.l - display.x - offset.x) / scale - 4 / scale,
                            top: (corner.t - display.y - offset.y) / scale - 4 / scale,
                            width: 8 / scale,
                            height: 8 / scale,
                          }
                        ]} />
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        </View>

        <View style={[styles.footer, { paddingBottom: 28 + (insets.bottom || 0) }]}>
          <Pressable
            style={[styles.footerBtn, { backgroundColor: 'transparent' }]}
            onPress={() => onUseOriginal({ data: '', mimeType: '', name: '' })}
            disabled={busy}
          >
            <Text style={styles.footerGhost}>使用原图</Text>
          </Pressable>
          {/* 缩放控制 */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              style={[styles.zoomBtn, { opacity: scale <= ZOOM_MIN ? 0.3 : 1 }]}
              onPress={() => {
                const newScale = Math.max(ZOOM_MIN, scale / 1.5);
                setScale(newScale);
                scaleRef.current = newScale;
              }}
              disabled={scale <= ZOOM_MIN}
            >
              <Text style={styles.zoomText}>−</Text>
            </Pressable>
            <Pressable
              style={styles.zoomBtn}
              onPress={resetZoom}
            >
              <Text style={styles.zoomText}>1×</Text>
            </Pressable>
            <Pressable
              style={[styles.zoomBtn, { opacity: scale >= ZOOM_MAX ? 0.3 : 1 }]}
              onPress={() => {
                const newScale = Math.min(ZOOM_MAX, scale * 1.5);
                setScale(newScale);
                scaleRef.current = newScale;
              }}
              disabled={scale >= ZOOM_MAX}
            >
              <Text style={styles.zoomText}>+</Text>
            </Pressable>
          </View>
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
    loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    loadingText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 8 },
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
    zoomBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  });
