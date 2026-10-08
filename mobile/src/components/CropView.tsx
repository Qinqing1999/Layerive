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
import * as FileSystem from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { radius } from '../theme';

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
type DragHandle = 'create' | 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** 选区有效性阈值：与工作台「局部」框选一致（占比 ≥2%） */
const MIN_PERCENT = 2;
/** 选区最小像素阈值：避免原图过小时裁剪出几乎无内容的图 */
const MIN_PIXELS = 32;
/** 四角手柄触摸热区半径 */
const CORNER_TOL = 34;
/** 选区最小尺寸（像素，防止缩成不可见） */
const MIN_SIZE = 20;

/**
 * 上传裁剪：复用工作台「局部」框选同款交互——
 * hitTest 判定手柄（四角 resize / 内部 move / 空白新建），
 * clampRect 夹紧到图片显示区，locationX/Y 本地坐标无测量偏移。
 * 图片始终 contain 适配，不缩放，坐标空间稳定。
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
  // 烘焙 EXIF 后的 uri（已旋转到正确方向，后续显示和裁剪都基于它）
  const [normalizedUri, setNormalizedUri] = useState<string | null>(null);
  const normalizedUriRef = useRef<string | null>(null);
  normalizedUriRef.current = normalizedUri;
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragHandleRef = useRef<DragHandle>('create');
  const rectBeforeDragRef = useRef<DragRect | null>(null);
  const dragRectRef = useRef<DragRect | null>(null);
  dragRectRef.current = dragRect;

  // 进入裁剪界面时先烘焙 EXIF，得到 normalized uri 和准确尺寸
  useEffect(() => {
    if (!visible) return;
    setDragRect(null);
    setImgSize(null);
    setNormalizedUri(null);
    let alive = true;

    (async () => {
      // 不管有没有 rotation，都过一遍 ImageManipulator：
      // 1) 烘焙 EXIF rotation（Android 原生裁剪不自动烘焙）
      // 2）返回值 out.width/out.height 是处理后真实尺寸，比 Image.getSize 可靠
      //    （Image.getSize 对 file:// URI 或带 EXIF 的 JPEG 可能返回未旋转尺寸）
      const actions = rotation ? [{ rotate: rotation }] : [];
      try {
        setNormalizing(true);
        const out = await ImageManipulator.manipulateAsync(
          uri,
          actions,
          { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        if (!alive) return;
        setNormalizedUri(out.uri);
        setImgSize({ w: out.width, h: out.height });
      } catch {
        // 处理失败则退回原图，用 Image.getSize 兜底
        if (!alive) return;
        setNormalizedUri(uri);
        Image.getSize(
          uri,
          (w, h) => alive && setImgSize({ w, h }),
          () => alive && setImgSize({ w: 1000, h: 1000 })
        );
      } finally {
        if (alive) setNormalizing(false);
      }
    })();

    return () => {
      alive = false;
      const tmpUri = normalizedUriRef.current;
      if (tmpUri && tmpUri !== uri) {
        FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, uri, rotation]);

  // contain 适配后的图片显示区（相对容器）
  const display = useMemo(() => {
    if (!imgSize || !box.w || !box.h) return null;
    const s = Math.min(box.w / imgSize.w, box.h / imgSize.h);
    const w = imgSize.w * s;
    const h = imgSize.h * s;
    return { w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 };
  }, [imgSize, box]);

  /** 判断触摸点落在已有选区的哪个手柄上（与画布框选同款） */
  function hitTest(p: { x: number; y: number }, rect: DragRect): DragHandle {
    if (!rect || rect.width < 1 || rect.height < 1) return 'create';
    const { x, y, width, height } = rect;
    const left = x, right = x + width, top = y, bottom = y + height;
    const hit = Math.min(CORNER_TOL, Math.min(width, height) / 2);
    if (Math.abs(p.x - left) <= hit && Math.abs(p.y - top) <= hit) return 'nw';
    if (Math.abs(p.x - right) <= hit && Math.abs(p.y - top) <= hit) return 'ne';
    if (Math.abs(p.x - left) <= hit && Math.abs(p.y - bottom) <= hit) return 'sw';
    if (Math.abs(p.x - right) <= hit && Math.abs(p.y - bottom) <= hit) return 'se';
    if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) return 'move';
    return 'create';
  }

  /** 夹紧到图片显示区域（与画布框选同款） */
  function clampRect(r: DragRect): DragRect {
    if (!display) return r;
    const maxX = display.x + display.w;
    const maxY = display.y + display.h;
    return {
      x: Math.max(display.x, Math.min(maxX - MIN_SIZE, r.x)),
      y: Math.max(display.y, Math.min(maxY - MIN_SIZE, r.y)),
      width: Math.max(MIN_SIZE, Math.min(maxX - r.x, r.width)),
      height: Math.max(MIN_SIZE, Math.min(maxY - r.y, r.height)),
    };
  }

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          if (!display) return;
          const p = { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
          const cur = dragRectRef.current;
          const handle = cur ? hitTest(p, cur) : 'create';
          dragHandleRef.current = handle;
          rectBeforeDragRef.current = cur ? { ...cur } : null;
          dragStartRef.current = p;
          if (handle === 'create') {
            setDragRect({ x: p.x, y: p.y, width: 0, height: 0 });
          }
        },
        onPanResponderMove: (evt) => {
          if (!display) return;
          const p = { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
          const handle = dragHandleRef.current;
          const base = rectBeforeDragRef.current;
          if (handle === 'create') {
            const start = dragStartRef.current;
            if (!start) return;
            const left = Math.max(display.x, Math.min(start.x, p.x));
            const right = Math.min(display.x + display.w, Math.max(start.x, p.x));
            const top = Math.max(display.y, Math.min(start.y, p.y));
            const bottom = Math.min(display.y + display.h, Math.max(start.y, p.y));
            setDragRect({ x: left, y: top, width: right - left, height: bottom - top });
          } else if (handle === 'move' && base) {
            const dx = p.x - (dragStartRef.current?.x ?? p.x);
            const dy = p.y - (dragStartRef.current?.y ?? p.y);
            setDragRect(clampRect({ x: base.x + dx, y: base.y + dy, width: base.width, height: base.height }));
          } else if (base && (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se')) {
            const dLeft = display.x, dTop = display.y;
            const dRight = display.x + display.w, dBottom = display.y + display.h;
            const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
            let newRect: DragRect;
            if (handle === 'nw') {
              const right = base.x + base.width, bottom = base.y + base.height;
              const nx = clamp(p.x, dLeft, right - MIN_SIZE);
              const ny = clamp(p.y, dTop, bottom - MIN_SIZE);
              newRect = { x: nx, y: ny, width: right - nx, height: bottom - ny };
            } else if (handle === 'ne') {
              const bottom = base.y + base.height;
              const nx = clamp(p.x, base.x + MIN_SIZE, dRight);
              const ny = clamp(p.y, dTop, bottom - MIN_SIZE);
              newRect = { x: base.x, y: ny, width: nx - base.x, height: bottom - ny };
            } else if (handle === 'sw') {
              const right = base.x + base.width;
              const nx = clamp(p.x, dLeft, right - MIN_SIZE);
              const ny = clamp(p.y, base.y + MIN_SIZE, dBottom);
              newRect = { x: nx, y: base.y, width: right - nx, height: ny - base.y };
            } else { // se
              const nx = clamp(p.x, base.x + MIN_SIZE, dRight);
              const ny = clamp(p.y, base.y + MIN_SIZE, dBottom);
              newRect = { x: base.x, y: base.y, width: nx - base.x, height: ny - base.y };
            }
            setDragRect(newRect);
          }
        },
        onPanResponderRelease: () => {
          dragStartRef.current = null;
          rectBeforeDragRef.current = null;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display]
  );

  function handleLayout(e: { nativeEvent: { layout: { width: number; height: number } } }) {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: width, h: height });
  }

  // 选区有效性（基于 contain 显示区，坐标空间与 display 一致）
  const percent = useMemo(() => {
    if (!dragRect || !display || display.w < 1 || display.h < 1) return null;
    return {
      w: (dragRect.width / display.w) * 100,
      h: (dragRect.height / display.h) * 100,
    };
  }, [dragRect, display]);
  const pixelSize = useMemo(() => {
    if (!dragRect || !display || !imgSize || display.w < 1 || display.h < 1) return null;
    const sx = imgSize.w / display.w;
    const sy = imgSize.h / display.h;
    return { w: dragRect.width * sx, h: dragRect.height * sy };
  }, [dragRect, display, imgSize]);
  const valid = !!percent && percent.w >= MIN_PERCENT && percent.h >= MIN_PERCENT
    && !!pixelSize && pixelSize.w >= MIN_PIXELS && pixelSize.h >= MIN_PIXELS;

  async function confirmCrop() {
    if (!imgSize || !display || !dragRect || !valid || busy || !normalizedUri) return;
    setBusy(true);
    try {
      const cropX = Math.round(Math.max(0, ((dragRect.x - display.x) / display.w) * imgSize.w));
      const cropY = Math.round(Math.max(0, ((dragRect.y - display.y) / display.h) * imgSize.h));
      const cropW = Math.max(1, Math.min(imgSize.w - cropX, Math.round((dragRect.width / display.w) * imgSize.w)));
      const cropH = Math.max(1, Math.min(imgSize.h - cropY, Math.round((dragRect.height / display.h) * imgSize.h)));
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
          <View style={styles.canvasInner} onLayout={handleLayout} {...pan.panHandlers}>
            {normalizing ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={colors.accent} />
                <Text style={styles.loadingText}>正在处理图片…</Text>
              </View>
            ) : display && showUri ? (
              <>
                <View pointerEvents="none" style={{ position: 'absolute', left: display.x, top: display.y, width: display.w, height: display.h }}>
                  <Image
                    source={{ uri: showUri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode="stretch"
                  />
                </View>
                {/* 选区外四块半透明遮罩 + 边框 + 四角拖拽手柄（与画布蒙版同款） */}
                {dragRect ? (
                  <View pointerEvents="none" style={styles.maskLayer}>
                    <View style={{ position: 'absolute', left: display.x, top: display.y, width: display.w, height: Math.max(0, dragRect.y - display.y), backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: display.x, top: dragRect.y + dragRect.height, width: display.w, height: Math.max(0, (display.y + display.h) - (dragRect.y + dragRect.height)), backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: display.x, top: Math.max(display.y, dragRect.y), width: Math.max(0, dragRect.x - display.x), height: Math.max(0, Math.min(dragRect.y + dragRect.height, display.y + display.h) - Math.max(display.y, dragRect.y)), backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: dragRect.x + dragRect.width, top: Math.max(display.y, dragRect.y), width: Math.max(0, (display.x + display.w) - (dragRect.x + dragRect.width)), height: Math.max(0, Math.min(dragRect.y + dragRect.height, display.y + display.h) - Math.max(display.y, dragRect.y)), backgroundColor: 'rgba(0,0,0,0.55)' }} />
                    <View style={{ position: 'absolute', left: dragRect.x, top: dragRect.y, width: dragRect.width, height: dragRect.height, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.sm }} />
                    {[
                      { left: dragRect.x, top: dragRect.y },
                      { left: dragRect.x + dragRect.width, top: dragRect.y },
                      { left: dragRect.x, top: dragRect.y + dragRect.height },
                      { left: dragRect.x + dragRect.width, top: dragRect.y + dragRect.height },
                    ].map((c, i) => (
                      <View key={i} style={[styles.cornerDot, { left: c.left - 6, top: c.top - 6 }]} />
                    ))}
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
          <Text style={styles.sizeText}>
            {valid && percent && pixelSize
              ? `${percent.w.toFixed(0)}% × ${percent.h.toFixed(0)}% · ${Math.round(pixelSize.w)}×${Math.round(pixelSize.h)}px`
              : dragRect
                ? '选区过小，至少 2% × 2% 且 ≥32px'
                : '拖拽框选裁剪范围'}
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
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: c.accent,
      borderWidth: 2,
      borderColor: '#fff',
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
