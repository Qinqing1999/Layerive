import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { RemoteImage } from '../components/RemoteImage';
import { ZoomableImage } from '../components/ZoomableImage';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, downloadToCache, imageSource, resolveUrl, versionDownloadPath } from '../api';
import { TASK_OPERATION_LABELS, formatTaskTime } from '../labels';
import { closestSizeForDimensions, outpaintPresets } from '../sizes';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { GenerateResult, GenerationTask, Message, ModelConfig, ProjectBundle, ProjectImage, Version } from '../types';
import { Icon } from '../components/Icon';
import { CropView } from '../components/CropView';
import { ModalSheet } from '../components/ModalSheet';
import { HistoryModal } from './workspace/HistoryModal';
import { CompareModal } from './workspace/CompareModal';
import { EditTextModal } from './workspace/EditTextModal';
import { BatchModal } from './workspace/BatchModal';
import { GalleryModal } from './workspace/GalleryModal';

type Props = {
  projectId: string;
  models: ModelConfig[];
  activeModel: string;
  activeVisionModel: string;
  onBack: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

type SheetName = 'tasks' | 'history' | 'compare' | 'editText' | 'batch' | 'gallery' | 'localEdit' | 'outpaint' | 'extractHint' | 'size' | null;
type SelectMode = 'localEdit' | 'extract' | null;
type WorkspaceTab = 'canvas' | 'chat' | 'history';

/** 图片百分比坐标（与服务端 rect 字段一致） */
type PercentRect = { x: number; y: number; width: number; height: number };

/** 画布内拖拽产生的显示坐标矩形 */
type DragRect = { x: number; y: number; width: number; height: number };

/** 选区拖拽手柄类型：创建新框 / 整体移动 / 四角调整 */
type DragHandle = 'create' | 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** 角点触控热区（像素）：触摸点距框角在此范围内视为拖拽手柄（34px ≈ 11dp，保证手指能轻松点中） */
const CORNER_TOL = 34;

/** EXIF Orientation → 顺时针旋转角度（Android 裁剪不自动烘焙 EXIF，需显式旋转） */
function exifRotation(asset: { exif?: Record<string, unknown> | null }): number {
  const orientation = Number(asset.exif?.Orientation ?? 1);
  if (orientation === 3 || orientation === 4) return 180;
  if (orientation === 5 || orientation === 6) return 90;
  if (orientation === 7 || orientation === 8) return 270;
  return 0;
}

const STAGE_LABELS: Record<string, string> = {
  planning: '视觉定位中…',
  compositing: '参考图合成中…',
  generating: '生成中…',
  preserving: '还原框外像素…',
};

// 扩图方向与幅度选项
const OUT_DIRS: { key: 'up' | 'down' | 'left' | 'right' | 'all'; label: string }[] = [
  { key: 'up', label: '向上' },
  { key: 'down', label: '向下' },
  { key: 'left', label: '向左' },
  { key: 'right', label: '向右' },
  { key: 'all', label: '四周' },
];
const OUT_SCALES: { value: number; label: string }[] = [
  { value: 0.25, label: '+25%' },
  { value: 0.5, label: '+50%' },
  { value: 1, label: '+100%' },
];

const SELECT_HINTS: Record<'localEdit' | 'extract', string> = {
  localEdit: '在图片上拖拽框选要修改的区域',
  extract: '圈选想提取的主体（允许带少量背景）',
};

export function WorkspaceScreen({ projectId, models, activeModel, activeVisionModel, onBack, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [stylePrompt, setStylePrompt] = useState('');
  const [showStylePrompt, setShowStylePrompt] = useState(false);
  // 主输入框内容高度：用 onContentSizeChange 显式设置，避免 Android 多行 TextInput 原生高度溢出 Yoga 边框
  const [inputH, setInputH] = useState(0);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeTask, setActiveTask] = useState<GenerationTask | null>(null);
  const [bottomTab, setBottomTab] = useState<WorkspaceTab>('canvas');
  const insets = useSafeAreaInsets();
  const [preview, setPreview] = useState<{ image: ProjectImage; message?: Message } | null>(null);
  const [count, setCount] = useState(1);
  // 生成尺寸：null = 跟随模型默认；设置后文生图/改图均按此尺寸提交
  const [genSize, setGenSize] = useState<{ value: string; label: string } | null>(null);
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  // 扩图增强：方向 / 扩展幅度 / 新增区域内容描述
  const [outDir, setOutDir] = useState<'up' | 'down' | 'left' | 'right' | 'all'>('all');
  const [outScale, setOutScale] = useState(0.5);
  const [outHint, setOutHint] = useState('');
  const [uploading, setUploading] = useState(false);
  const [cropAsset, setCropAsset] = useState<{ uri: string; data: string; mimeType: string; name: string; use: 'upload' | 'reference'; rotation: number } | null>(null);
  const [parentVersionId, setParentVersionId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [selectMode, setSelectMode] = useState<SelectMode>(null);
  const [selectedRect, setSelectedRect] = useState<PercentRect | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const canvasWrapRef = useRef<View | null>(null);
  const canvasOriginRef = useRef({ x: 0, y: 0 });
  /** 画布缩放/平移状态（非框选模式下可用双指缩放、单指拖动查看图片） */
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 });
  const canvasZoomRef = useRef(1);
  const canvasPanRef = useRef({ x: 0, y: 0 });
  const lastPinchDistRef = useRef(0);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const chatListRef = useRef<FlatList<Message> | null>(null);
  // 追踪用户是否在列表底部附近（决定新消息是否自动滚动）
  const isNearBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  // 进入对话页时定位到最新消息：FlatList 分批渲染、内容在挂载后陆续增长，
  // 用时间窗（1.2s）内每次内容变化都重新滚到底部，避免只滚到部分内容的底部
  const initialScrollDeadlineRef = useRef(0);
  useEffect(() => {
    if (bottomTab === 'chat') {
      isNearBottomRef.current = true;
      initialScrollDeadlineRef.current = Date.now() + 1200;
      chatListRef.current?.scrollToEnd({ animated: false });
    }
  }, [bottomTab]);
  /** 触摸事件 → 画布容器内坐标（pageX 全局稳定，不受 Android 子 View locationX 跳变影响） */
  function canvasPoint(evt: { nativeEvent: { pageX: number; pageY: number } }) {
    return {
      x: evt.nativeEvent.pageX - canvasOriginRef.current.x,
      y: evt.nativeEvent.pageY - canvasOriginRef.current.y,
    };
  }
  /** 框选手势专用：取框选触摸层的本地坐标（locationX/Y）。
   *  触摸层与画框蒙版同处 wrap 坐标空间，天然同参照系——
   *  不经过任何测量换算，从机制上排除状态栏/布局时序导致的坐标偏移 */
  function overlayPoint(evt: { nativeEvent: { locationX: number; locationY: number } }) {
    return { x: evt.nativeEvent.locationX, y: evt.nativeEvent.locationY };
  }
  /** 测量画布容器原点，对齐 pageX/pageY 参照系。
   *  关键：非 edge-to-edge 时 measureInWindow 返回屏幕坐标（含状态栏高度），
   *  而触摸 pageY 相对应用内容区（状态栏下方，不含状态栏）。
   *  若不校正，所有计算出的触摸点会整体上移一个状态栏高度，
   *  导致角点 hitTest 系统性失准（按角变移动/新建，按边反而能 resize）。 */
  function measureCanvasOrigin(onDone?: () => void) {
    canvasWrapRef.current?.measureInWindow((x, y) => {
      const statusH = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;
      canvasOriginRef.current = { x, y: y - statusH };
      onDone?.();
    });
  }
  // ---- 画布双指缩放 + 单指拖动 ----
  function handleCanvasTouchStart(e: any) {
    // 每次触摸都刷新容器原点（含状态栏校正），避免布局变化后缓存过期
    measureCanvasOrigin();
    // 框选模式下禁用画布缩放/平移，避免与画框拖拽冲突
    if (selectMode) return;
    const touches = e.nativeEvent.touches;
    if (touches.length === 2) {
      const t0 = touches[0], t1 = touches[1];
      lastPinchDistRef.current = Math.sqrt((t0.pageX - t1.pageX) ** 2 + (t0.pageY - t1.pageY) ** 2);
    } else if (touches.length === 1) {
      const p = canvasPoint(e);
      panStartRef.current = { x: p.x - canvasPanRef.current.x, y: p.y - canvasPanRef.current.y };
    }
  }
  function handleCanvasTouchMove(e: any) {
    // 框选模式下禁用画布缩放/平移
    if (selectMode) return;
    const touches = e.nativeEvent.touches;
    if (touches.length === 2) {
      const t0 = touches[0], t1 = touches[1];
      const dist = Math.sqrt((t0.pageX - t1.pageX) ** 2 + (t0.pageY - t1.pageY) ** 2);
      const prev = lastPinchDistRef.current;
      if (prev === 0) { lastPinchDistRef.current = dist; return; }
      const ratio = dist / prev;
      const newZoom = Math.min(5, Math.max(0.3, canvasZoomRef.current * ratio));
      // 以触摸中心为基准计算平移偏移
      const cx = (t0.pageX + t1.pageX) / 2 - canvasOriginRef.current.x;
      const cy = (t0.pageY + t1.pageY) / 2 - canvasOriginRef.current.y;
      const dRatio = newZoom / canvasZoomRef.current;
      const newPanX = canvasPanRef.current.x - (cx - canvasSize.w / 2) * (dRatio - 1);
      const newPanY = canvasPanRef.current.y - (cy - canvasSize.h / 2) * (dRatio - 1);
      setCanvasZoom(newZoom); canvasZoomRef.current = newZoom;
      setCanvasPan({ x: newPanX, y: newPanY }); canvasPanRef.current = { x: newPanX, y: newPanY };
      lastPinchDistRef.current = dist;
    } else if (touches.length === 1) {
      const start = panStartRef.current;
      if (!start) return;
      const p = canvasPoint(e);
      const nx = p.x - start.x;
      const ny = p.y - start.y;
      setCanvasPan({ x: nx, y: ny }); canvasPanRef.current = { x: nx, y: ny };
    }
  }
  function handleCanvasTouchEnd() {
    lastPinchDistRef.current = 0;
    panStartRef.current = null;
  }
  function resetCanvasZoom() {
    setCanvasZoom(1); canvasZoomRef.current = 1;
    setCanvasPan({ x: 0, y: 0 }); canvasPanRef.current = { x: 0, y: 0 };
  }
  const [dragRect, setDragRectState] = useState<DragRect | null>(null);
  const dragRectRef = useRef<DragRect | null>(null);
  const setDragRect = useCallback((r: DragRect | null) => {
    dragRectRef.current = r;
    setDragRectState(r);
  }, []);
  const dragHandleRef = useRef<DragHandle>('create');
  const rectBeforeDragRef = useRef<DragRect | null>(null);
  const [localInstruction, setLocalInstruction] = useState('');
  const [localReference, setLocalReference] = useState<{ data: string; mimeType: string; name?: string } | null>(null);
  const [extractHint, setExtractHint] = useState('');
  const [extractBusy, setExtractBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  /** 撤销/重做栈：记录本地变换（旋转/翻转）前的图片信息 */
  const [undoStack, setUndoStack] = useState<{ imageId: string; versionId: string | null; url: string }[]>([]);
  const [redoStack, setRedoStack] = useState<{ imageId: string; versionId: string | null; url: string }[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  /** 最近一次提交（按任务 ID 记录），任务失败时可原样重发 */
  const lastSubmitRef = useRef<{ taskId: string; submit: () => Promise<GenerateResult> } | null>(null);
  /** 提交锁：防止 submitGenerate 在 activeTask 设置前被连点触发重复请求 */
  const submittingRef = useRef(false);
  const [failedTask, setFailedTask] = useState<{ error: string | null; retryable: boolean } | null>(null);
  /** 草稿仅首次加载恢复，避免轮询刷新覆盖用户正在输入的内容 */
  const draftRestoredRef = useRef(false);
  /** loadBundle 竞态保护：只接受最新一次请求的结果 */
  const bundleReqIdRef = useRef(0);
  /** 轮询连续失败计数 + 任务最长轮询窗口 */
  const pollFailCountRef = useRef(0);
  const pollStartRef = useRef(0);
  // 运行时探测的图片尺寸缓存（当服务端未存 width/height 时回退使用）
  const [runtimeImgSize, setRuntimeImgSize] = useState<{ id: string; w: number; h: number } | null>(null);

  const currentImage = useMemo(
    () => bundle?.images.find((img) => img.id === bundle.project.currentImageId) || null,
    [bundle],
  );
  const currentVersion = useMemo(
    () => (currentImage?.versionId ? bundle?.versions.find((v) => v.id === currentImage.versionId) || null : null),
    [bundle, currentImage],
  );
  const parentVersion = useMemo(
    () => (currentVersion?.parentVersionId ? bundle?.versions.find((v) => v.id === currentVersion.parentVersionId) || null : null),
    [bundle, currentVersion],
  );
  const parentImage = useMemo(() => {
    if (!parentVersion) return null;
    return parentVersion.outputs.find((img) => img.id === parentVersion.selectedImageId)
      || parentVersion.outputs[0]
      || parentVersion.inputs[0]
      || null;
  }, [parentVersion]);
  const candidates = useMemo(() => {
    if (currentVersion && currentVersion.status !== 'failed') {
      const outputs = currentVersion.outputs.filter((img) => img.fileSize > 0);
      if (outputs.length) return outputs;
    }
    return currentImage ? [currentImage] : [];
  }, [currentVersion, currentImage]);
  const imageModel = models.find((m) => m.id === (bundle?.project.defaultModelId || activeModel)) || models[0] || null;
  const messages = bundle?.messages || [];
  const imageMap = useMemo(() => {
    const map = new Map<string, ProjectImage>();
    if (bundle) for (const img of bundle.images) map.set(img.id, img);
    return map;
  }, [bundle]);

  const loadBundle = useCallback(async (): Promise<ProjectBundle | null> => {
    const reqId = ++bundleReqIdRef.current;
    try {
      const data = await api.getProject(projectId);
      // 竞态保护：只接受最新一次请求的结果
      if (reqId !== bundleReqIdRef.current) return null;
      setBundle(data);
      // 草稿仅首次加载恢复，避免轮询刷新覆盖用户正在输入的内容
      if (!draftRestoredRef.current) {
        draftRestoredRef.current = true;
        const draft = data.project.draft as { prompt?: string; count?: number; stylePrompt?: string };
        if (draft?.prompt) {
          setPrompt(draft.prompt);
          if (typeof draft?.count === 'number') setCount(draft.count);
        } else {
          // 服务端无草稿时回退读取 AsyncStorage 本地副本（App 被杀后恢复）
          try {
            const local = await AsyncStorage.getItem(`layerive-draft:${projectId}`);
            if (local) {
              const localDraft = JSON.parse(local) as { prompt?: string; count?: number; stylePrompt?: string };
              if (localDraft?.prompt) setPrompt(localDraft.prompt);
              if (typeof localDraft?.count === 'number') setCount(localDraft.count);
            }
          } catch { /* ignore */ }
        }
        if (typeof draft?.stylePrompt === 'string') {
          setStylePrompt(draft.stylePrompt);
          if (draft.stylePrompt) setShowStylePrompt(true);
        }
      }
      return data;
    } catch (e) {
      if (reqId !== bundleReqIdRef.current) return null;
      notify((e as Error).message, 'error');
      return null;
    } finally {
      if (reqId === bundleReqIdRef.current) setLoading(false);
    }
  }, [projectId, notify]);

  useEffect(() => { void loadBundle(); }, [loadBundle]);

  // 拦截系统返回键，防止误触发回桌面
  const handleBack = useCallback(() => { onBack(); return true; }, [onBack]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let subscription: { remove: () => void } | null = null;
    try {
      subscription = BackHandler.addEventListener('hardwareBackPress', handleBack);
    } catch {
      // older RN versions may not support addEventListener API
    }
    return () => { try { subscription?.remove(); } catch { /* ignore */ } };
  }, [handleBack]);

  // 草稿防抖保存到服务端 + AsyncStorage 本地副本
  useEffect(() => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(async () => {
      if (!bundle) return;
      const draft = { prompt: prompt.trim(), count, stylePrompt: stylePrompt.trim() };
      // 先写本地副本（防止 App 被杀后草稿丢失）
      try {
        await AsyncStorage.setItem(`layerive-draft:${projectId}`, JSON.stringify(draft));
      } catch { /* ignore */ }
      // 再保存到服务端，成功后清理本地副本
      try {
        await api.updateProject(projectId, { draft });
        await AsyncStorage.removeItem(`layerive-draft:${projectId}`);
      } catch { /* 网络失败时保留本地副本 */ }
    }, 900);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [prompt, count, stylePrompt, projectId, bundle]);

  // 进入工作台（或 App 重启后重进）恢复进行中/排队中的任务，让队列显示与轮询接上
  useEffect(() => {
    if (!bundle) return;
    let alive = true;
    (async () => {
      try {
        const { tasks } = await api.listGeneratingTasks(projectId);
        if (!alive || !tasks.length) return;
        const newest = tasks[0];
        setActiveTask((prev) => prev ?? {
          id: newest.id,
          status: newest.status,
          operationType: newest.operationType,
          stage: null,
          error: null,
          createdAt: newest.createdAt,
          finishedAt: null,
        });
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [bundle, projectId]);

  // Poll the running task until it leaves the queue / "generating".
  useEffect(() => {
    if (!bundle || !activeTask || (activeTask.status !== 'generating' && activeTask.status !== 'queued')) return;
    pollFailCountRef.current = 0;
    pollStartRef.current = Date.now();
    const MAX_POLL_MS = 10 * 60 * 1000; // 10 分钟上限
    const MAX_FAILS = 5; // 连续失败 5 次停止
    pollRef.current = setInterval(async () => {
      // 超过最长轮询窗口，视为失败
      if (Date.now() - pollStartRef.current > MAX_POLL_MS) {
        setActiveTask(null);
        setFailedTask({ error: '任务超时（超过 10 分钟），请重试', retryable: lastSubmitRef.current?.taskId === activeTask.id });
        if (pollRef.current) clearInterval(pollRef.current);
        return;
      }
      try {
        const task = await api.getTask(projectId, activeTask.id);
        pollFailCountRef.current = 0;
        if (task.status === 'generating' || task.status === 'queued') {
          setActiveTask(task);
        } else {
          setActiveTask(null);
          setFailedTask(
            task.status === 'failed'
              ? { error: task.error, retryable: lastSubmitRef.current?.taskId === task.id }
              : null,
          );
          await loadBundle();
        }
      } catch (e) {
        pollFailCountRef.current++;
        const msg = (e as Error).message;
        // 401 会由 request 层处理会话过期，这里不重复处理
        if (msg.includes('登录已过期')) {
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        // 连续失败超过阈值，停止轮询并提示
        if (pollFailCountRef.current >= MAX_FAILS) {
          setActiveTask(null);
          setFailedTask({ error: '网络连接不稳定，任务可能仍在运行，请稍后查看', retryable: false });
          if (pollRef.current) clearInterval(pollRef.current);
        }
        // 其他错误静默重试（网络抖动）
      }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, bundle, projectId, loadBundle]);

  // 切换画布图片时退出框选模式
  useEffect(() => {
    setSelectMode(null);
    setDragRect(null);
  }, [currentImage?.id]);

  // 当服务端未存 width/height 时，运行时探测图片尺寸
  // 注意：imageSource 传了 1280px 宽度，需用 Image.getSize 获取实际渲染尺寸
  useEffect(() => {
    if (!currentImage || currentImage.width || currentImage.height) return;
    const url = imageSource(currentImage.url, 1280)?.uri;
    if (!url) return;
    let alive = true;
    Image.getSize(
      url,
      (w, h) => { if (alive && currentImage) setRuntimeImgSize({ id: currentImage.id, w, h }); },
      () => {},
    );
    return () => { alive = false; };
  }, [currentImage?.id, currentImage?.url, currentImage?.width, currentImage?.height]);

  async function uploadImage(data: string, mimeType: string, name: string) {
    try {
      const result = await api.uploadImage(projectId, { data, mimeType, name });
      setBundle(result);
      setParentVersionId(null);
      notify('图片已上传');
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  async function pickImage() {
    if (uploading) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { notify('需要相册权限才能上传图片', 'error'); return; }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        base64: true,
        exif: true,
      });
      const asset = result.assets?.[0];
      if (!asset?.base64) return;
      // 选图后先进入裁剪界面，由用户决定裁剪导入或使用原图
      setCropAsset({
        uri: asset.uri,
        data: asset.base64,
        mimeType: asset.mimeType || 'image/jpeg',
        name: asset.fileName || `photo-${Date.now()}.jpg`,
        use: 'upload',
        rotation: exifRotation(asset),
      });
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  /** 直接拍照（不进入选图库） */
  async function pickCamera() {
    if (uploading) return;
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) { notify('需要相机权限', 'error'); return; }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        base64: true,
        exif: true,
      });
      const asset = result.assets?.[0];
      if (!asset?.base64) return;
      setCropAsset({
        uri: asset.uri,
        data: asset.base64,
        mimeType: asset.mimeType || 'image/jpeg',
        name: asset.fileName || `camera-${Date.now()}.jpg`,
        use: 'upload',
        rotation: exifRotation(asset),
      });
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  /** 裁剪界面确认（含「使用原图」空 data 信号）：按用途上传画布或设为局部编辑参考图 */
  function handleCropDone(asset: { data: string; mimeType: string; name: string }) {
    const target = cropAsset;
    setCropAsset(null);
    if (!target) return;
    const finalAsset = asset.data
      ? asset
      : { data: target.data, mimeType: target.mimeType, name: target.name };
    if (target.use === 'upload') {
      setUploading(true);
      void uploadImage(finalAsset.data, finalAsset.mimeType, finalAsset.name).finally(() => setUploading(false));
    } else {
      setLocalReference(finalAsset);
      notify('参考图已就绪');
    }
  }

  async function pickReference() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, base64: true, exif: true });
      const asset = result.assets?.[0];
      if (!asset?.base64) return;
      // 参考图同样先进入裁剪界面，可编辑选择范围后再使用
      setCropAsset({
        uri: asset.uri,
        data: asset.base64,
        mimeType: asset.mimeType || 'image/jpeg',
        name: asset.fileName || 'reference.jpg',
        use: 'reference',
        rotation: exifRotation(asset),
      });
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  function useAsCurrent(image: ProjectImage) {
    if (!bundle) return;
    const prevImageId = bundle.project.currentImageId;
    setBundle({ ...bundle, project: { ...bundle.project, currentImageId: image.id } });
    api.updateProject(projectId, { currentImageId: image.id }).catch((e) => {
      // 服务端失败：回滚本地状态，提示用户
      setBundle((prev) => prev ? { ...prev, project: { ...prev.project, currentImageId: prevImageId } } : prev);
      notify((e as Error).message, 'error');
    });
  }

  /** Use a history version as the current canvas + next generation input. */
  function useVersion(version: Version) {
    const target = version.outputs.find((img) => img.id === version.selectedImageId) || version.outputs[0];
    if (!target || !bundle) { notify('该版本没有可用输出图片', 'error'); return; }
    const prevImageId = bundle.project.currentImageId;
    setBundle({ ...bundle, project: { ...bundle.project, currentImageId: target.id } });
    api.updateProject(projectId, { currentImageId: target.id }).catch((e) => {
      // 服务端失败：回滚本地状态
      setBundle((prev) => prev ? { ...prev, project: { ...prev.project, currentImageId: prevImageId } } : prev);
      notify((e as Error).message, 'error');
    });
    setParentVersionId(version.id);
    setSheet(null);
    setBottomTab('canvas');
    notify(`已切换到 V${version.number}，可从此版本继续创作`);
  }

  /** 提交任务后立即返回（fire-and-track），不等待 getTask —— 轮询 effect 会自动拉取状态 */
  async function runTracked(submit: () => Promise<GenerateResult>) {
    setFailedTask(null);
    const result = await submit();
    lastSubmitRef.current = { taskId: result.taskId, submit };
    // 立即设置 queued 状态，让轮询 effect 接管后续状态更新
    setActiveTask({
      id: result.taskId,
      status: 'queued',
      operationType: undefined,
      stage: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });
    // 立即刷新 bundle，让对话页显示刚插入的 user message
    await loadBundle();
  }

  function retryFailed() {
    const entry = lastSubmitRef.current;
    if (!entry || !failedTask?.retryable) return;
    setFailedTask(null);
    setBottomTab('chat');
    runTracked(entry.submit).catch((e) => notify((e as Error).message, 'error'));
  }

  async function submitGenerate() {
    if (!prompt.trim() || activeTask || submittingRef.current) return;
    submittingRef.current = true;
    // 提交前固化输入，失败重试时沿用当时的画布图与父版本
    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      params: { count, ...(genSize ? { size: genSize.value } : {}) },
      visionModelId: activeVisionModel,
    };
    if (currentImage) input.imageId = currentImage.id;
    if (parentVersionId) input.parentVersionId = parentVersionId;
    setBottomTab('chat');
    try {
      await runTracked(() => api.generate(projectId, input));
      setParentVersionId(null);
      setPrompt(''); // 发送成功后自动清空输入框（失败时保留以便重试）
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      submittingRef.current = false;
    }
  }

  async function cancelTask() {
    if (!activeTask) return;
    try {
      await api.cancelTask(projectId, activeTask.id);
      setActiveTask(null);
      await loadBundle();
      notify('已取消');
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  /** 进入 / 退出画布框选模式（局部编辑 / 提取素材） */
  function toggleSelectMode(mode: Exclude<SelectMode, null>) {
    if (!currentImage) { notify('请先在画布中选择图片', 'error'); return; }
    if (selectMode === mode) {
      setSelectMode(null);
      setDragRect(null);
    } else {
      // 进入框选模式前重置画布缩放/平移，保证触摸坐标与 imageDisplay 一致
      resetCanvasZoom();
      setSelectMode(mode);
      setDragRect(null);
    }
  }

  function confirmSelection() {
    if (!selectedRect) return;
    const next = selectMode;
    setSelectMode(null);
    setDragRect(null);
    if (next === 'localEdit') setSheet('localEdit');
    if (next === 'extract') setSheet('extractHint');
  }

  function runSpecial(kind: 'enhance' | 'watermark') {
    if (!currentImage) { notify('请先在画布中选择图片', 'error'); return; }
    const tips = {
      enhance: '对当前图片调用图片模型提升清晰度与细节，保持内容不变。继续？',
      watermark: '视觉模型将先判断并定位水印，再由图片模型修复遮挡区域。继续？',
    } as const;
    const ops = {
      enhance: () => api.enhance(projectId, { imageId: currentImage.id, visionModelId: activeVisionModel, params: { size: originalSizeFor(currentImage) } }),
      watermark: () => api.removeWatermark(projectId, { imageId: currentImage.id, visionModelId: activeVisionModel, params: { size: originalSizeFor(currentImage) } }),
    } as const;
    Alert.alert(kind === 'enhance' ? '图片变清晰' : '去水印', tips[kind], [
      { text: '取消', style: 'cancel' },
      {
        text: '开始',
        onPress: async () => {
          try {
            setBottomTab('chat');
            await runTracked(ops[kind]);
          } catch (e) { notify((e as Error).message, 'error'); }
        },
      },
    ]);
  }

  async function submitOutpaint(size: string, direction?: string, hint?: string) {
    if (!currentImage) return;
    const imageId = currentImage.id;
    setSheet(null);
    try {
      setBottomTab('chat');
      await runTracked(() => api.outpaint(projectId, {
        imageId, size, visionModelId: activeVisionModel,
        ...(direction ? { direction } : {}),
        ...(hint ? { hint } : {}),
      }));
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  /** 编辑类操作默认跟随原图比例（映射到当前模型支持的最近档位） */
  function originalSizeFor(image: ProjectImage | null) {
    return closestSizeForDimensions(imageModel?.provider, image?.width, image?.height);
  }

  /** 扩图目标尺寸与预览布局：按方向+幅度计算理想画布，再映射到模型支持的档位 */
  const outpaintPlan = useMemo(() => {
    const w0 = currentImage?.width || 1024;
    const h0 = currentImage?.height || 1024;
    const ex = outDir === 'left' || outDir === 'right' || outDir === 'all' ? outScale : 0;
    const ey = outDir === 'up' || outDir === 'down' || outDir === 'all' ? outScale : 0;
    const targetW = Math.round(w0 * (1 + ex));
    const targetH = Math.round(h0 * (1 + ey));
    const size = closestSizeForDimensions(imageModel?.provider, targetW, targetH);
    const [sw, sh] = size.split('x').map(Number);
    // 画布映射到档位后，原图实际占比（clamp 避免比例偏差导致负值）
    const innerW = Math.min(sw, (w0 / targetW) * sw);
    const innerH = Math.min(sh, (h0 / targetH) * sh);
    const padL = outDir === 'left' ? sw - innerW : outDir === 'all' ? (sw - innerW) / 2 : 0;
    const padR = outDir === 'right' ? sw - innerW : outDir === 'all' ? (sw - innerW) / 2 : 0;
    const padT = outDir === 'up' ? sh - innerH : outDir === 'all' ? (sh - innerH) / 2 : 0;
    const padB = outDir === 'down' ? sh - innerH : outDir === 'all' ? (sh - innerH) / 2 : 0;
    return { size, sw, sh, padL: (padL / sw) * 100, padR: (padR / sw) * 100, padT: (padT / sh) * 100, padB: (padB / sh) * 100 };
  }, [currentImage, outDir, outScale, imageModel]);

  function applyCustomSize() {
    const w = Number(customW);
    const h = Number(customH);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 256 || h < 256 || w > 4096 || h > 4096) {
      notify('宽高需在 256-4096 之间', 'error');
      return;
    }
    const value = `${Math.round(w)}x${Math.round(h)}`;
    setGenSize({ value, label: '自定义' });
    setSheet(null);
    notify(`已选择自定义 ${value}`);
  }

  async function submitLocalEdit() {
    if (!currentImage || !selectedRect) return;
    if (!localInstruction.trim() && !localReference) { notify('请描述修改要求或上传参考图', 'error'); return; }
    // 固化本次输入（含参考图），失败后可原样重试
    const input: Record<string, unknown> = {
      imageId: currentImage.id,
      rect: selectedRect,
      instruction: localInstruction.trim(),
      visionModelId: activeVisionModel,
      params: { size: originalSizeFor(currentImage) },
    };
    if (localReference) input.reference = localReference;
    setSheet(null);
    try {
      setBottomTab('chat');
      await runTracked(() => api.localEdit(projectId, input));
      setLocalInstruction('');
      setLocalReference(null);
      setSelectedRect(null);
    } catch (e) {
      notify((e as Error).message, 'error');
      setSheet('localEdit');
    }
  }

  /** Crop the selected region from the original image and submit extract-asset. */
  async function submitExtract() {
    if (!currentImage || !selectedRect) return;
    // 固化选区与说明，裁剪 + 提交整体可重试
    const imageId = currentImage.id;
    const rect = selectedRect;
    const hint = extractHint.trim();
    const run = async (): Promise<GenerateResult> => {
      const width = currentImage.width;
      const height = currentImage.height;
      if (!width || !height) throw new Error('无法读取原图尺寸');
      const cropX = Math.round((rect.x / 100) * width);
      const cropY = Math.round((rect.y / 100) * height);
      const cropW = Math.min(width - cropX, Math.max(1, Math.round((rect.width / 100) * width)));
      const cropH = Math.min(height - cropY, Math.max(1, Math.round((rect.height / 100) * height)));
      if (cropW < 8 || cropH < 8) throw new Error('框选区域太小，请重新框选');

      const fullUrl = resolveUrl(currentImage.url);
      if (!fullUrl) throw new Error('图片地址无效');
      setBusyLabel('正在下载原图…');
      const localUri = await downloadToCache(fullUrl, `extract-src-${imageId}`);
      let scale = 1;
      if (Math.max(cropW, cropH) > 2048) scale = 2048 / Math.max(cropW, cropH);
      if (Math.min(cropW, cropH) * scale < 256) scale = 256 / Math.min(cropW, cropH);
      const actions: ImageManipulator.Action[] = [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }];
      if (Math.abs(scale - 1) > 0.01) actions.push({ resize: { width: Math.round(cropW * scale), height: Math.round(cropH * scale) } });
      setBusyLabel('正在截取选区…');
      const rendered = await ImageManipulator.manipulateAsync(localUri, actions, { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true });
      if (!rendered.base64) throw new Error('截图生成失败，请重试');

      setBusyLabel('正在提交任务…');
      return api.extractAsset(projectId, {
        imageId,
        rect,
        crop: { data: rendered.base64, mimeType: 'image/jpeg' },
        hint,
        visionModelId: activeVisionModel,
      });
    };
    setExtractBusy(true);
    try {
      setBottomTab('chat');
      await runTracked(run);
      setSheet(null);
      setExtractHint('');
      setSelectedRect(null);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setExtractBusy(false);
      setBusyLabel('');
    }
  }

  async function deleteVersion(version: Version) {
    const hasChildren = bundle?.versions.some((v) => v.parentVersionId === version.id) || false;
    const doDelete = async (force: boolean) => {
      try {
        await api.deleteVersion(projectId, version.id, force);
        const fresh = await loadBundle();
        // 如果删除的是当前画布版本，基于刷新后的 bundle 切换到父版本或最近可用版本
        const isCurrent = currentImage?.versionId === version.id;
        if (isCurrent && fresh) {
          const parentVer = fresh.versions.find((v) => v.id === version.parentVersionId && v.status === 'completed');
          const fallbackVer = fresh.versions.find((v) => v.id !== version.id && v.status === 'completed');
          const targetVer = parentVer || fallbackVer;
          if (targetVer) {
            const targetImg = targetVer.outputs.find((img) => img.fileSize > 0) || targetVer.outputs[0];
            if (targetImg) {
              await api.updateProject(projectId, { currentImageId: targetImg.id });
              await loadBundle();
            }
          }
        }
        notify(`V${version.number} 已删除`);
      } catch (e) { notify((e as Error).message, 'error'); }
    };
    if (hasChildren) {
      Alert.alert(
        `删除 V${version.number}`,
        '此版本有子版本，强制删除后子版本将直接连接到它的父版本。确定删除？',
        [
          { text: '取消', style: 'cancel' },
          { text: '强制删除', style: 'destructive', onPress: () => void doDelete(true) },
        ],
      );
    } else {
      Alert.alert(`删除 V${version.number}`, '确定删除此版本？删除后不可恢复。', [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => void doDelete(false) },
      ]);
    }
  }

  async function downloadVersionZip(version: Version) {
    const outputs = version.outputs.filter((img) => img.fileSize > 0);
    if (outputs.length === 0) { notify('该版本没有可下载的图片', 'error'); return; }
    try {
      setBusyLabel('正在打包版本图片…');
      const uri = await downloadToCache(versionDownloadPath(projectId, version.id), `layerive-V${version.number}.zip`);
      setBusyLabel('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: `V${version.number} 图片` });
      } else {
        notify(`已下载到本地：${uri}`);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusyLabel('');
    }
  }

  /** 保存/分享当前预览的原图（iOS 可存入相册，Android 由分享面板接管） */
  async function sharePreview() {
    if (!preview) return;
    const fullUrl = resolveUrl(preview.image.url);
    if (!fullUrl) { notify('图片地址无效', 'error'); return; }
    const ext = /\.png($|\?)/i.test(fullUrl) ? 'png' : /\.webp($|\?)/i.test(fullUrl) ? 'webp' : 'jpg';
    try {
      setBusyLabel('正在下载原图…');
      const uri = await downloadToCache(fullUrl, `preview-${preview.image.id}.${ext}`);
      setBusyLabel('');
      if (await Sharing.isAvailableAsync()) {
        const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: '保存 / 分享图片' });
      } else {
        notify(`已下载到本地：${uri}`);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusyLabel('');
    }
  }

  /** 直接保存到手机相册/下载文件夹 */
  async function saveCurrentImage() {
    if (!currentImage) { notify('没有当前图片', 'error'); return; }
    const fullUrl = resolveUrl(currentImage.url);
    if (!fullUrl) { notify('图片地址无效', 'error'); return; }
    const ext = /\.png($|\?)/i.test(fullUrl) ? 'png' : /\.webp($|\?)/i.test(fullUrl) ? 'webp' : 'jpg';
    try {
      setBusyLabel('正在保存…');
      const uri = await downloadToCache(fullUrl, `layerive-${currentImage.id}.${ext}`);
      setBusyLabel('');
      if (await Sharing.isAvailableAsync()) {
        const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: '保存到相册' });
        notify('已保存到相册');
      } else {
        notify('系统分享不可用，请重试', 'error');
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusyLabel('');
    }
  }

  /** 收藏当前预览图片到画廊 */
  async function favoriteToGallery() {
    if (!preview) return;
    try {
      await api.galleryFromImage(projectId, preview.image.id);
      notify('已收藏到画廊');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }

  /** 旋转/翻转当前画布图片（本地处理，不上传新版本） */
  async function transformImage(action: 'rotate90' | 'flipH' | 'flipV') {
    if (!currentImage || uploading) return;
    const fullUrl = resolveUrl(currentImage.url);
    if (!fullUrl) { notify('图片地址无效', 'error'); return; }
    setUploading(true);
    setBusyLabel('正在处理图片…');
    try {
      const uri = await downloadToCache(fullUrl, `transform-${currentImage.id}.jpg`);
      const actions: ImageManipulator.Action[] = action === 'rotate90'
        ? [{ rotate: 90 }]
        : action === 'flipH'
        ? [{ flip: ImageManipulator.FlipType.Horizontal }]
        : [{ flip: ImageManipulator.FlipType.Vertical }];
      const out = await ImageManipulator.manipulateAsync(uri, actions, { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true });
      if (!out.base64) throw new Error('图片处理失败');
      // 记录撤销栈（含 versionId，与服务端状态同步）
      setUndoStack((prev) => [...prev, { imageId: currentImage.id, versionId: currentImage.versionId || null, url: currentImage.url }]);
      setRedoStack([]);
      const updated = await api.uploadImage(projectId, { data: out.base64, mimeType: 'image/jpeg', name: `transform-${Date.now()}.jpg` });
      setBundle(updated);
      // 清理临时文件
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      FileSystem.deleteAsync(out.uri, { idempotent: true }).catch(() => {});
      notify(action === 'rotate90' ? '已旋转 90°' : action === 'flipH' ? '已水平翻转' : '已垂直翻转');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setUploading(false);
      setBusyLabel('');
    }
  }

  /** 撤销上一次本地变换（回到撤销栈中的前一张图） */
  function undoTransform() {
    setUndoStack((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, { imageId: last.imageId, versionId: last.versionId, url: last.url }]);
      // 切换回上一张图（同时更新 currentVersionId，避免 loadBundle 后状态回退）
      if (bundle) {
        setBundle({ ...bundle, project: { ...bundle.project, currentImageId: last.imageId, currentVersionId: last.versionId } });
        void api.updateProject(projectId, { currentImageId: last.imageId, currentVersionId: last.versionId }).catch(() => {});
      }
      return prev.slice(0, -1);
    });
  }

  /** 重做上次撤销的变换 */
  function redoTransform() {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setUndoStack((u) => [...u, { imageId: last.imageId, versionId: last.versionId, url: last.url }]);
      if (bundle) {
        setBundle({ ...bundle, project: { ...bundle.project, currentImageId: last.imageId, currentVersionId: last.versionId } });
        void api.updateProject(projectId, { currentImageId: last.imageId, currentVersionId: last.versionId }).catch(() => {});
      }
      return prev.slice(0, -1);
    });
  }

  // ---- 画布框选：图片在画布内的实际显示区域（aspectFit） ----
  // 注意：imageSource(url, 1280) 返回的是缩略图，需与缩略图尺寸一致
  const imageDisplay = useMemo(() => {
    const cw = canvasSize.w;
    const ch = canvasSize.h;
    // 优先使用 runtimeImgSize（缩略图实际尺寸），其次使用服务端原始尺寸
    const imgSize = (runtimeImgSize && runtimeImgSize.id === currentImage?.id)
      ? { w: runtimeImgSize.w, h: runtimeImgSize.h }
      : { w: currentImage?.width || 0, h: currentImage?.height || 0 };
    if (!cw || !ch || !imgSize.w || !imgSize.h) return null;
    const scale = Math.min(cw / imgSize.w, ch / imgSize.h);
    const w = imgSize.w * scale;
    const h = imgSize.h * scale;
    return { left: (cw - w) / 2, top: (ch - h) / 2, w, h };
  }, [canvasSize, currentImage?.id, currentImage?.width, currentImage?.height, runtimeImgSize]);

  /** 判断触摸点落在已有选区的哪个手柄上 */
  function hitTest(p: { x: number; y: number }, rect: DragRect): DragHandle {
    if (!rect || rect.width < 1 || rect.height < 1) return 'create';
    const { x, y, width, height } = rect;
    const left = x, right = x + width, top = y, bottom = y + height;
    // 边角优先：热区 = min(36px, 边长的一半)，保证小框也能点到
    const hit = Math.min(CORNER_TOL, Math.min(width, height) / 2);
    if (Math.abs(p.x - left) <= hit && Math.abs(p.y - top) <= hit) return 'nw';
    if (Math.abs(p.x - right) <= hit && Math.abs(p.y - top) <= hit) return 'ne';
    if (Math.abs(p.x - left) <= hit && Math.abs(p.y - bottom) <= hit) return 'sw';
    if (Math.abs(p.x - right) <= hit && Math.abs(p.y - bottom) <= hit) return 'se';
    // 在选区内部 → 整体移动
    if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) return 'move';
    return 'create';
  }

  /** 夹紧到图片显示区域，同时限制宽高不溢出、不小于最小值 */
  function clampRect(r: DragRect): DragRect {
    if (!imageDisplay) return r;
    const minSize = 20;
    const maxX = imageDisplay.left + imageDisplay.w;
    const maxY = imageDisplay.top + imageDisplay.h;
    return {
      x: Math.max(imageDisplay.left, Math.min(maxX - minSize, r.x)),
      y: Math.max(imageDisplay.top, Math.min(maxY - minSize, r.y)),
      width: Math.max(minSize, Math.min(maxX - r.x, r.width)),
      height: Math.max(minSize, Math.min(maxY - r.y, r.height)),
    };
  }

  const panResponder = useMemo(() => PanResponder.create({
    // selectMode 下单指始终接管；双指不抢占，让画布的 touch handlers 处理缩放
    onStartShouldSetPanResponder: (evt) => Boolean(selectMode) && evt.nativeEvent.touches.length < 2,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (evt) => {
      if (!selectMode || !imageDisplay) return;
      // 同步取本地坐标（locationX/Y），无测量、无异步、无参照系换算
      const p = overlayPoint(evt);
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
      if (!selectMode || !imageDisplay) return;
      const p = overlayPoint(evt);
      const handle = dragHandleRef.current;
      const base = rectBeforeDragRef.current;
      if (handle === 'create') {
        const start = dragStartRef.current;
        if (!start) return;
        const left = Math.max(imageDisplay.left, Math.min(start.x, p.x));
        const right = Math.min(imageDisplay.left + imageDisplay.w, Math.max(start.x, p.x));
        const top = Math.max(imageDisplay.top, Math.min(start.y, p.y));
        const bottom = Math.min(imageDisplay.top + imageDisplay.h, Math.max(start.y, p.y));
        setDragRect({ x: left, y: top, width: right - left, height: bottom - top });
      } else if (handle === 'move' && base) {
        const dx = p.x - (dragStartRef.current?.x ?? p.x);
        const dy = p.y - (dragStartRef.current?.y ?? p.y);
        setDragRect(clampRect({ x: base.x + dx, y: base.y + dy, width: base.width, height: base.height }));
      } else if (base && (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se')) {
        // 四角 resize：拖动的角 = 手指位置（精确跟手，放大/缩小都有效），对角固定不动。
        // 新边夹在 [对角∓minSize, imageDisplay 边界] 内，保证不小于最小尺寸、不超出图片
        const minSize = 20;
        const dLeft = imageDisplay.left, dTop = imageDisplay.top;
        const dRight = imageDisplay.left + imageDisplay.w, dBottom = imageDisplay.top + imageDisplay.h;
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
        let newRect: DragRect;
        if (handle === 'nw') {
          const right = base.x + base.width, bottom = base.y + base.height;
          const nx = clamp(p.x, dLeft, right - minSize);
          const ny = clamp(p.y, dTop, bottom - minSize);
          newRect = { x: nx, y: ny, width: right - nx, height: bottom - ny };
        } else if (handle === 'ne') {
          const bottom = base.y + base.height;
          const nx = clamp(p.x, base.x + minSize, dRight);
          const ny = clamp(p.y, dTop, bottom - minSize);
          newRect = { x: base.x, y: ny, width: nx - base.x, height: bottom - ny };
        } else if (handle === 'sw') {
          const right = base.x + base.width;
          const nx = clamp(p.x, dLeft, right - minSize);
          const ny = clamp(p.y, base.y + minSize, dBottom);
          newRect = { x: nx, y: base.y, width: right - nx, height: ny - base.y };
        } else { // se
          const nx = clamp(p.x, base.x + minSize, dRight);
          const ny = clamp(p.y, base.y + minSize, dBottom);
          newRect = { x: base.x, y: base.y, width: nx - base.x, height: ny - base.y };
        }
        setDragRect(newRect);
      }
    },
    onPanResponderRelease: () => {
      dragStartRef.current = null;
      rectBeforeDragRef.current = null;
    },
  }), [selectMode, imageDisplay]);

  // 显示坐标 → 图片百分比坐标
  const dragPercent = useMemo<PercentRect | null>(() => {
    if (!dragRect || !imageDisplay || imageDisplay.w < 1 || imageDisplay.h < 1) return null;
    const x = ((dragRect.x - imageDisplay.left) / imageDisplay.w) * 100;
    const y = ((dragRect.y - imageDisplay.top) / imageDisplay.h) * 100;
    return {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
      width: Math.max(0, Math.min(100 - Math.max(0, x), (dragRect.width / imageDisplay.w) * 100)),
      height: Math.max(0, Math.min(100 - Math.max(0, y), (dragRect.height / imageDisplay.h) * 100)),
    };
  }, [dragRect, imageDisplay]);

  const dragValid = !!dragPercent && dragPercent.width >= 2 && dragPercent.height >= 2;

  // 拖拽结束后同步到 selectedRect，供「下一步」使用
  useEffect(() => {
    if (!selectMode) return;
    if (dragPercent && dragValid) setSelectedRect(dragPercent);
    if (!dragRect) setSelectedRect(null);
  }, [dragPercent, dragValid, dragRect, selectMode]);

  /** 选区外蒙版：上 / 下 / 左 / 右四块半透明遮罩 + 四角拖拽手柄 */
  const renderCanvasMask = () => {
    if (!selectMode || !dragRect || !imageDisplay) return null;
    const { left: dLeft, top: dTop, w: dW, h: dH } = imageDisplay;
    const maskColor = 'rgba(0,0,0,0.55)';
    const hs = 6; // 角点手柄半宽
    const corners = [
      { left: dragRect.x - hs, top: dragRect.y - hs },
      { left: dragRect.x + dragRect.width - hs, top: dragRect.y - hs },
      { left: dragRect.x - hs, top: dragRect.y + dragRect.height - hs },
      { left: dragRect.x + dragRect.width - hs, top: dragRect.y + dragRect.height - hs },
    ];
    // 左右遮罩：y/height 必须限制在 imageDisplay 范围内，防止框靠近边缘时遮罩溢出
    const ly = Math.max(dTop, dragRect.y);
    const lh = Math.min(dragRect.y + dragRect.height, dTop + dH) - ly;
    const ry = Math.max(dTop, dragRect.y);
    const rh = Math.min(dragRect.y + dragRect.height, dTop + dH) - ry;
    return (
      <View pointerEvents="none" style={styles.maskLayer}>
        <View style={{ position: 'absolute', left: dLeft, top: dTop, width: dW, height: Math.max(0, dragRect.y - dTop), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dLeft, top: dragRect.y + dragRect.height, width: dW, height: Math.max(0, (dTop + dH) - (dragRect.y + dragRect.height)), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dLeft, top: ly, width: Math.max(0, dragRect.x - dLeft), height: Math.max(0, lh), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dragRect.x + dragRect.width, top: ry, width: Math.max(0, (dLeft + dW) - (dragRect.x + dragRect.width)), height: Math.max(0, rh), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dragRect.x, top: dragRect.y, width: dragRect.width, height: dragRect.height, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.sm }} />
        {/* 四角拖拽手柄 */}
        {corners.map((c, i) => (
          <View key={`c${i}`} style={[styles.cornerDot, { left: c.left, top: c.top }]} />
        ))}
      </View>
    );
  };

  if (loading || !bundle) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top, backgroundColor: colors.card }]}>
        {loading ? (
          <>
            <ActivityIndicator size="large" color={colors.accent} />
            {busyLabel ? <Text style={styles.loadingText}>{busyLabel}</Text> : <Text style={styles.loadingText}>加载中…</Text>}
          </>
        ) : (
          <>
            <Text style={styles.loadingText}>加载失败</Text>
            <Pressable
              hitSlop={8}
              onPress={() => { setLoading(true); void loadBundle(); }}
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.retryBtnText}>重试</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  const taskLabel = activeTask
    ? activeTask.status === 'queued'
      ? activeTask.queuePosition
        ? `排队中 · 第 ${activeTask.queuePosition} 位`
        : '排队等待中…'
      : (activeTask.stage && STAGE_LABELS[activeTask.stage]) || '生成中…'
    : '';

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.card }]}>
      {/* Top bar */}
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={8} style={({ pressed }) => [styles.topbarBtn, pressed && { opacity: 0.6 }]}>
          <Icon name="back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.topbarTitle} numberOfLines={1}>
          {bundle.project.name}{parentVersionId ? '（从历史继续）' : ''}
        </Text>
        {activeTask ? (
          <Pressable style={({ pressed }) => [styles.taskPill, pressed && { opacity: 0.85 }]} onPress={() => setSheet('tasks')}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.taskPillText} numberOfLines={1}>{taskLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setSheet('gallery')} hitSlop={8} style={({ pressed }) => [styles.topbarBtn, pressed && { opacity: 0.6 }]}>
          <Icon name="gallery" size={18} color={colors.text} />
        </Pressable>
      </View>

      {/* 画布操作栏：上传 / 相机 / 保存（仅画布页显示） */}
      {bottomTab === 'canvas' && (
        <View style={styles.actionBar}>
          <Pressable onPress={pickImage} style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]} disabled={uploading}>
            {uploading ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="upload" size={16} color={colors.text} />}
            <Text style={styles.actionText}>上传</Text>
          </Pressable>
          <Pressable onPress={pickCamera} style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]} disabled={uploading}>
            <Icon name="camera" size={16} color={colors.text} />
            <Text style={styles.actionText}>拍照</Text>
          </Pressable>
          <Pressable onPress={() => void saveCurrentImage()} style={({ pressed }) => [styles.actionBtn, !currentImage && styles.actionBtnDisabled, pressed && { opacity: 0.7 }]} disabled={!currentImage}>
            <Icon name="download" size={16} color={colors.text} />
            <Text style={styles.actionText}>保存</Text>
          </Pressable>
        </View>
      )}

      {/* 历史版本独立页面 */}
      {bottomTab === 'history' ? (
        <View style={styles.historyPage}>
          <HistoryModal
            bundle={bundle}
            onUseVersion={useVersion}
            onDeleteVersion={deleteVersion}
            onDownloadVersion={downloadVersionZip}
            onRefresh={async () => { await loadBundle(); }}
            notify={notify}
          />
        </View>
      ) : bottomTab === 'canvas' ? (
      /* 画布页（框选蒙版直接叠加在画布上，工具栏为底部固定行不遮图） */
      <View style={styles.canvasArea}>
      <View
        ref={canvasWrapRef}
        style={styles.canvasWrap}
      >
        {/* 缩放/平移变换层（只含图片，画框在外层保持坐标一致） */}
        {/* 触摸处理挂在内层：工具条是 wrap 的子元素，挂在 wrap 会因触摸冒泡导致滑动工具条时图片跟着平移 */}
        <View
          style={{ flex: 1, transform: canvasZoom !== 1 || (canvasPan.x !== 0 || canvasPan.y !== 0)
            ? [{ translateX: canvasPan.x }, { translateY: canvasPan.y }, { scale: canvasZoom }] : undefined }}
          onTouchStart={handleCanvasTouchStart}
          onTouchMove={handleCanvasTouchMove}
          onTouchEnd={handleCanvasTouchEnd}
          onLayout={(e) => {
            // 尺寸测量放在内容层：底部工具栏显隐会改变内容区高度，但 wrap 自身尺寸不变、
            // onLayout 不触发，会导致 imageDisplay 用过期尺寸计算、蒙版与图片错位
            setCanvasSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
            measureCanvasOrigin();
          }}
        >
          {currentImage ? (
            <Pressable
              style={imageDisplay
                ? { position: 'absolute', left: imageDisplay.left, top: imageDisplay.top, width: imageDisplay.w, height: imageDisplay.h }
                : styles.canvasImage}
              disabled={Boolean(selectMode)}
            >
              <Image
                source={imageSource(currentImage.url, 1280)}
                style={{ width: '100%', height: '100%' }}
                resizeMode={imageDisplay ? 'stretch' : 'contain'}
              />
            </Pressable>
          ) : (
            <Pressable style={styles.canvasEmpty} onPress={pickImage}>
              <Icon name="image" size={48} color={colors.border} />
              <Text style={styles.canvasEmptyText}>点击上传图片开始创作</Text>
            </Pressable>
          )}
        </View>
        {/* 缩放重置按钮：缩放不为 1 或有平移时显示 */}
        {(canvasZoom !== 1 || canvasPan.x !== 0 || canvasPan.y !== 0) ? (
          <Pressable onPress={resetCanvasZoom} style={styles.zoomResetBtn}>
            <Text style={styles.zoomResetText}>重置视图</Text>
          </Pressable>
        ) : null}

        {/* 画框层：在外层 wrap 内，坐标空间与 canvasPoint/imageDisplay 一致 */}
        {renderCanvasMask()}

        {/* 框选模式提示条 */}
        {selectMode ? (
          <View style={styles.selectHintBar} pointerEvents="none">
            <Icon name="region" size={14} color="#fff" />
            <Text style={styles.selectHintText}>{SELECT_HINTS[selectMode]}</Text>
          </View>
        ) : null}

        {!selectMode ? (
          /* 底部工具栏（正常流，不遮挡画布） */
          <ScrollView
            horizontal
            style={styles.toolRow}
            contentContainerStyle={styles.toolList}
            showsHorizontalScrollIndicator={false}
          >
            <ToolBtn icon="compare" label="对比" colors={colors} disabled={!parentImage} onPress={() => setSheet('compare')} />
            <ToolBtn icon="rotate" label="旋转" colors={colors} disabled={!currentImage} onPress={() => void transformImage('rotate90')} />
            <ToolBtn icon="flipH" label="翻转" colors={colors} disabled={!currentImage} onPress={() => void transformImage('flipH')} />
            <ToolBtn icon="undo" label="撤销" colors={colors} disabled={!undoStack.length} onPress={undoTransform} />
            <ToolBtn icon="redo" label="重做" colors={colors} disabled={!redoStack.length} onPress={redoTransform} />
            <ToolBtn icon="text" label="改字" colors={colors} disabled={!currentImage} onPress={() => setSheet('editText')} />
            <ToolBtn icon="region" label="局部" colors={colors} active={selectMode === 'localEdit'} disabled={!currentImage} onPress={() => toggleSelectMode('localEdit')} />
            <ToolBtn icon="crop" label="提取" colors={colors} active={selectMode === 'extract'} disabled={!currentImage} onPress={() => toggleSelectMode('extract')} />
            <ToolBtn icon="expand" label="扩图" colors={colors} disabled={!currentImage} onPress={() => setSheet('outpaint')} />
            <ToolBtn icon="enhance" label="清晰" colors={colors} disabled={!currentImage} onPress={() => runSpecial('enhance')} />
            <ToolBtn icon="droplet" label="去水印" colors={colors} disabled={!currentImage} onPress={() => runSpecial('watermark')} />
          </ScrollView>
        ) : null}

        {/* 框选触摸层：置于最上层，box-only 使其成为唯一触摸目标，
            locationX/Y 即画布本地坐标，与蒙版渲染天然同参照系，无需任何测量换算 */}
        {selectMode ? (
          <View style={styles.selectTouchLayer} pointerEvents="box-only" {...panResponder.panHandlers} />
        ) : null}
      </View>

      {/* 框选确认操作条：位于画布手势区之外，避免被 PanResponder 抢占触摸 */}
      {selectMode ? (
        <View style={styles.selectActionBar}>
          <Pressable style={styles.selectCancelBtn} onPress={() => { setSelectMode(null); setDragRect(null); }}>
            <Text style={styles.selectCancelText}>取消</Text>
          </Pressable>
          <Text style={styles.selectSizeText}>
            {dragValid && selectedRect ? `${selectedRect.width.toFixed(0)}% × ${selectedRect.height.toFixed(0)}%` : '拖拽框选'}
          </Text>
          <Pressable
            style={[styles.selectNextBtn, !dragValid && { opacity: 0.4 }]}
            disabled={!dragValid}
            onPress={confirmSelection}
          >
            <Text style={styles.selectNextText}>下一步</Text>
            <Icon name="chevronRight" size={14} color="#fff" />
          </Pressable>
        </View>
      ) : null}
      </View>
      ) : (
        /* 对话页：消息列表与输入栏同容器（flex:1 + minHeight:0），输入栏始终完整可见 */
        <View style={styles.chatPage}>
        <FlatList
          ref={chatListRef}
          style={styles.chatList}
          data={messages}
          keyExtractor={(item: Message) => item.id}
          contentContainerStyle={styles.chatListContent}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={5}
          renderItem={({ item }: { item: Message }) => (
            <MessageBubble
              message={item}
              imagesById={imageMap}
              colors={colors}
              onImagePress={(img) => setPreview({ image: img, message: item })}
            />
          )}
          onContentSizeChange={() => {
            // 进入对话页的时间窗内：内容每增长一批就重新定位到底部，保证显示最新消息
            if (Date.now() < initialScrollDeadlineRef.current) {
              isNearBottomRef.current = true;
              prevMsgCountRef.current = messages.length;
              chatListRef.current?.scrollToEnd({ animated: false });
              return;
            }
            // 仅当新消息到达且用户接近底部时才自动滚动，不打断阅读历史
            if (messages.length > prevMsgCountRef.current && isNearBottomRef.current) {
              chatListRef.current?.scrollToEnd({ animated: false });
            }
            prevMsgCountRef.current = messages.length;
          }}
          onScroll={({ nativeEvent }) => {
            // 监听滚动位置：距底部 < 150px 视为"接近底部"
            const { contentOffset, contentSize } = nativeEvent;
            const layoutHeight = (nativeEvent as unknown as { layoutMeasurement?: { height: number } }).layoutMeasurement?.height || 800;
            const distToBottom = contentSize.height - contentOffset.y - layoutHeight;
            isNearBottomRef.current = distToBottom < 150;
          }}
          scrollEventThrottle={16}
        />
        {/* 输入栏：与消息列表同容器，保证始终完整显示 */}
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.inputBarWrap}>
          <View style={[styles.inputBar, { paddingBottom: (insets.bottom || 0) + spacing.md }]}>
            {currentImage ? (
              <View style={styles.canvasHint}>
                {imageSource(currentImage.url, 128) ? (
                  <RemoteImage source={imageSource(currentImage.url, 128)} style={styles.canvasHintThumb} resizeMode="cover" fallbackLabel="图片加载失败" />
                ) : null}
                <View style={styles.canvasHintTextWrap}>
                  <Text style={styles.canvasHintTitle}>正在编辑画布图片</Text>
                  <Text style={styles.canvasHintMeta} numberOfLines={1}>
                    {[currentImage.width && currentImage.height ? `${currentImage.width}×${currentImage.height}` : '', '输入描述即可修改'].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </View>
            ) : null}
            {/* 数量/批量创作：风格编辑器展开时隐藏，为输入区腾出空间 */}
            {!showStylePrompt && (
              <View style={styles.countRow}>
                <CountSelect value={count} onChange={setCount} colors={colors} />
                <Pressable style={styles.batchPill} onPress={() => setSheet('size')}>
                  <Icon name="crop" size={13} color={colors.accent} />
                  <Text style={styles.batchPillText}>{genSize ? `${genSize.label} ${genSize.value}` : '比例'}</Text>
                </Pressable>
                <Pressable style={styles.batchPill} onPress={() => setSheet('batch')}>
                  <Icon name="batch" size={13} color={colors.accent} />
                  <Text style={styles.batchPillText}>批量创作</Text>
                </Pressable>
              </View>
            )}
            {/* 项目风格提示词：可折叠，内容存入 draft，服务端文生图时自动拼接到 prompt */}
            <Pressable style={styles.styleToggle} onPress={() => setShowStylePrompt((v) => !v)}>
              <Icon name={showStylePrompt ? 'chevronDown' : 'chevronRight'} size={12} color={colors.muted} />
              <Text style={styles.styleToggleText}>项目风格提示词</Text>
              {stylePrompt.trim() ? <Text style={styles.styleBadge}>已设置</Text> : null}
            </Pressable>
            {showStylePrompt && (
              <TextInput
                style={[styles.input, styles.styleInput]}
                value={stylePrompt}
                onChangeText={setStylePrompt}
                placeholder="例如：扁平插画风格…仅用于文生图时统一风格，改图不会生效。"
                placeholderTextColor={colors.muted}
                multiline
                textAlignVertical="top"
              />
            )}
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, styles.inputGrow, inputH > 0 && { height: Math.min(inputH + 18, 120) }]}
                value={prompt}
                onChangeText={setPrompt}
                placeholder={currentImage ? '描述你想如何修改这张图片…' : '描述你想生成的图片…'}
                placeholderTextColor={colors.muted}
                multiline
                onContentSizeChange={(e) => setInputH(e.nativeEvent.contentSize.height)}
              />
              {activeTask ? (
                <Pressable style={({ pressed }) => [styles.sendBtn, { backgroundColor: colors.danger }, pressed && { opacity: 0.85 }]} onPress={cancelTask}>
                  <Icon name="stop" size={16} color="#fff" />
                </Pressable>
              ) : (
                <Pressable style={({ pressed }) => [styles.sendBtn, !prompt.trim() && { opacity: 0.5 }, pressed && { opacity: 0.85 }]} onPress={submitGenerate} disabled={!prompt.trim()}>
                  <Icon name="send" size={16} color="#fff" />
                </Pressable>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
        </View>
      )}

      {/* 候选图条 */}
      {bottomTab === 'canvas' && candidates.length > 1 && (
        <ScrollView horizontal style={styles.candidateBar} contentContainerStyle={styles.candidateList} showsHorizontalScrollIndicator={false}>
          {candidates.map((img) => (
            <Pressable key={img.id} onPress={() => useAsCurrent(img)} style={[styles.candidateItem, img.id === currentImage?.id && styles.candidateActive]}>
              <RemoteImage source={imageSource(img.url, 320)} style={styles.candidateImage} resizeMode="cover" fallbackLabel="图片加载失败" />
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* 任务失败横幅（任意页签可见，紧贴底部导航） */}
      {failedTask ? (
        <View style={styles.failedBar}>
          <Text style={styles.failedText} numberOfLines={2}>{failedTask.error || '任务失败'}</Text>
          {failedTask.retryable ? (
            <Pressable style={styles.failedRetry} onPress={retryFailed}>
              <Text style={styles.failedRetryText}>重试</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={6} onPress={() => setFailedTask(null)}>
            <Icon name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {/* 底部导航：画布 / 对话 / 历史 */}
      <View style={[styles.tabBar, { paddingBottom: (insets.bottom || 0) + spacing.sm }]}>
        <Pressable style={[styles.tabBtn, bottomTab === 'canvas' && styles.tabBtnActive]} onPress={() => setBottomTab('canvas')}>
          <Icon name="image" size={16} color={bottomTab === 'canvas' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'canvas' && styles.tabTextActive]}>画布</Text>
          {candidates.length > 1 ? <Text style={[styles.tabBadge, bottomTab === 'canvas' && styles.tabBadgeActive]}>{candidates.length}</Text> : null}
        </Pressable>
        <Pressable style={[styles.tabBtn, bottomTab === 'chat' && styles.tabBtnActive]} onPress={() => setBottomTab('chat')}>
          <Icon name="chatbubble-ellipses" size={16} color={bottomTab === 'chat' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'chat' && styles.tabTextActive]}>对话</Text>
          {activeTask ? <View style={styles.tabDot} /> : null}
        </Pressable>
        <Pressable style={[styles.tabBtn, bottomTab === 'history' && styles.tabBtnActive]} onPress={() => setBottomTab('history')}>
          <Icon name="history" size={16} color={bottomTab === 'history' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'history' && styles.tabTextActive]}>历史</Text>
        </Pressable>
      </View>

      {/* Sheets */}
      {/* 图片预览：消息图片与画布图片共用（大图 + 出处 + 保存/分享 + 设为画布） */}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={[styles.previewOverlay, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 10 }]}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {preview?.message?.content.versionNumber ? `V${preview.message.content.versionNumber} · 生成结果` : preview?.message ? '图片预览' : '画布图片'}
            </Text>
            <Pressable onPress={() => setPreview(null)} hitSlop={8}>
              <Icon name="close" size={22} color="#fff" />
            </Pressable>
          </View>
          {preview && (
            <ZoomableImage source={imageSource(preview.image.url, 1280)} style={styles.previewImage} resizeMode="contain" fallbackLabel="预览加载失败" />
          )}
          {preview && (
            <View style={styles.previewInfo}>
              {preview.message ? (
                <>
                  <Text style={styles.previewPrompt} numberOfLines={4}>
                    {preview.message.content.prompt || preview.message.content.text || '（无提示词）'}
                  </Text>
                  <Text style={styles.previewMeta}>
                    {[preview.message.content.modelName, preview.image.width ? `${preview.image.width}×${preview.image.height}` : ''].filter(Boolean).join(' · ')}
                  </Text>
                </>
              ) : (
                <Text style={styles.previewMeta}>
                  {[preview.image.width ? `${preview.image.width}×${preview.image.height}` : '', '保存到手机相册或分享给他人'].filter(Boolean).join(' · ')}
                </Text>
              )}
              <View style={styles.previewActions}>
                <Pressable style={styles.previewShareBtn} onPress={() => void sharePreview()}>
                  <Icon name="share" size={15} color={colors.accent} />
                  <Text style={styles.previewShareText}>保存 / 分享</Text>
                </Pressable>
                {preview.message ? (
                  <Pressable style={styles.previewGalleryBtn} onPress={() => void favoriteToGallery()}>
                    <Icon name="heart" size={15} color={colors.accent} />
                    <Text style={styles.previewGalleryText}>收藏到画廊</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.previewUseBtn}
                  onPress={() => { useAsCurrent(preview.image); setPreview(null); setBottomTab('canvas'); }}
                >
                  <Icon name="image" size={15} color="#fff" />
                  <Text style={styles.previewUseText}>设为画布图片</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {/* 任务队列：独立面板，查看排队/进行中任务并支持取消与失败重试 */}
      <ModalSheet visible={sheet === 'tasks'} title="任务队列" onClose={() => setSheet(null)}>
        <TasksPanel
          projectId={projectId}
          activeTask={activeTask}
          failedTask={failedTask}
          onRetry={retryFailed}
          onCancel={cancelTask}
        />
      </ModalSheet>

      <ModalSheet visible={sheet === 'compare'} title="前后对比" onClose={() => setSheet(null)}>
        <CompareModal
          beforeUrl={parentImage?.url || null}
          afterUrl={currentImage?.url || null}
          beforeLabel={parentVersion ? `V${parentVersion.number}` : '之前'}
          afterLabel={currentVersion ? `V${currentVersion.number}` : '当前'}
        />
      </ModalSheet>

      <ModalSheet visible={sheet === 'editText'} title="图片改字" onClose={() => setSheet(null)}>
        {currentImage && (
          <EditTextModal
            projectId={projectId}
            image={currentImage}
            visionModelId={activeVisionModel}
            provider={imageModel?.provider}
            notify={notify}
            onSubmitted={(taskId, editInput) => {
              setSheet(null);
              setBottomTab('chat');
              // 同步设置 lastSubmitRef，submit 为真正的重新提交函数（修复重试断裂）
              lastSubmitRef.current = {
                taskId,
                submit: () => api.editText(projectId, editInput),
              };
              // 获取任务状态并设置 activeTask，轮询 effect 接管
              void api.getTask(projectId, taskId).then((task) => {
                setActiveTask(task);
                notify('改字任务已提交，等待视觉规划与生成');
              }).catch(() => {
                notify('任务已提交，但状态获取失败，请稍后查看', 'error');
              });
            }}
            onCancel={() => setSheet(null)}
          />
        )}
      </ModalSheet>

      <ModalSheet visible={sheet === 'batch'} title="批量创作" onClose={() => setSheet(null)}>
        <BatchModal
          projectId={projectId}
          imageModel={imageModel}
          visionModelId={activeVisionModel}
          hasCanvasImage={Boolean(currentImage)}
          notify={notify}
          onFinished={() => { void loadBundle(); }}
          onClose={() => setSheet(null)}
        />
      </ModalSheet>

      <ModalSheet visible={sheet === 'gallery'} title="提示词画廊" onClose={() => setSheet(null)}>
        <GalleryModal
          projectId={projectId}
          currentImageId={currentImage?.id || null}
          visionModelId={activeVisionModel}
          notify={notify}
          onUse={(usePrompt, useStylePrompt) => {
            setPrompt(usePrompt || '');
            if (useStylePrompt) setStylePrompt(useStylePrompt);
            setSheet(null);
            notify(useStylePrompt ? '提示词与风格已填入' : '提示词已填入');
          }}
        />
      </ModalSheet>

      {/* Local edit instruction sheet */}
      <ModalSheet
        visible={sheet === 'localEdit'}
        title="局部编辑"
        onClose={() => { setSheet(null); setSelectedRect(null); }}
        footer={
          <Pressable style={styles.primaryBtn} onPress={submitLocalEdit}>
            <Text style={styles.primaryBtnText}>提交局部修改</Text>
          </Pressable>
        }
      >
        <View style={styles.padBody}>
          <Text style={styles.fieldLabel}>修改要求（有参考图时可留空）</Text>
          <TextInput
            style={styles.instructionInput}
            value={localInstruction}
            onChangeText={setLocalInstruction}
            placeholder="例如：把这个区域替换成一束花"
            placeholderTextColor={colors.muted}
            multiline
          />
          <Pressable style={styles.referenceBtn} onPress={pickReference}>
            {localReference ? (
              <>
                <Image
                  source={{ uri: `data:${localReference.mimeType};base64,${localReference.data}` }}
                  style={styles.referenceThumb}
                  resizeMode="cover"
                />
                <Text style={styles.referenceText} numberOfLines={1}>
                  已选参考图：{localReference.name || '图片'}
                </Text>
                <Pressable hitSlop={8} onPress={() => setLocalReference(null)}>
                  <Icon name="close" size={16} color={colors.muted} />
                </Pressable>
              </>
            ) : (
              <>
                <Icon name="upload" size={16} color={colors.accent} />
                <Text style={styles.referenceText}>添加参考图（可选）</Text>
              </>
            )}
          </Pressable>
          {selectedRect && (
            <Text style={styles.rectNote}>
              选区：x {selectedRect.x.toFixed(1)}% · y {selectedRect.y.toFixed(1)}% · {selectedRect.width.toFixed(1)}% × {selectedRect.height.toFixed(1)}%
            </Text>
          )}
        </View>
      </ModalSheet>

      {/* Outpaint sheet：方向 + 幅度 + 预览 + 内容描述，也可直接选目标尺寸 */}
      <ModalSheet
        visible={sheet === 'outpaint'}
        title="扩图"
        onClose={() => setSheet(null)}
        footer={
          <Pressable style={styles.primaryBtn} onPress={() => submitOutpaint(outpaintPlan.size, outDir, outHint.trim())} disabled={!currentImage}>
            <Text style={styles.primaryBtnText}>开始扩图（{outpaintPlan.size}）</Text>
          </Pressable>
        }
      >
        <View style={styles.padBody}>
          {/* 扩展方向 */}
          <Text style={styles.fieldLabel}>扩展方向</Text>
          <View style={styles.miniChipRow}>
            {OUT_DIRS.map((d) => (
              <Pressable key={d.key} style={[styles.miniChip, outDir === d.key && styles.miniChipActive]} onPress={() => setOutDir(d.key)}>
                <Text style={[styles.miniChipText, outDir === d.key && styles.miniChipTextActive]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
          {/* 扩展幅度 */}
          <Text style={styles.fieldLabel}>扩展幅度</Text>
          <View style={styles.miniChipRow}>
            {OUT_SCALES.map((s) => (
              <Pressable key={s.value} style={[styles.miniChip, outScale === s.value && styles.miniChipActive]} onPress={() => setOutScale(s.value)}>
                <Text style={[styles.miniChipText, outScale === s.value && styles.miniChipTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
          {/* 预览：虚线区域为新增部分，中心为原图 */}
          <View style={[styles.outpaintPreview, { aspectRatio: outpaintPlan.sw / outpaintPlan.sh }]}>
            <View
              style={{
                position: 'absolute',
                top: `${outpaintPlan.padT}%`,
                bottom: `${outpaintPlan.padB}%`,
                left: `${outpaintPlan.padL}%`,
                right: `${outpaintPlan.padR}%`,
                overflow: 'hidden',
                borderRadius: radius.sm,
              }}
            >
              {currentImage ? (
                <RemoteImage source={imageSource(currentImage.url, 480)} style={{ width: '100%', height: '100%' }} resizeMode="cover" fallbackLabel="原图" />
              ) : null}
            </View>
          </View>
          <Text style={styles.outpaintMeta}>原图 {currentImage?.width || '?'}×{currentImage?.height || '?'} → 目标 {outpaintPlan.size}（浅色边距为新增区域）</Text>
          {/* 新增区域内容描述 */}
          <Text style={styles.fieldLabel}>新增区域内容描述（可选）</Text>
          <TextInput
            style={styles.instructionInput}
            value={outHint}
            onChangeText={setOutHint}
            placeholder="例如：向上扩展天空和远山，保持黄昏色调"
            placeholderTextColor={colors.muted}
            multiline
          />
          {/* 直接选目标尺寸（高级） */}
          <Text style={styles.fieldLabel}>或直接选择目标尺寸</Text>
          <View style={styles.sizeGrid}>
            {outpaintPresets(imageModel?.provider, currentImage?.width, currentImage?.height).map((preset) => (
              <Pressable
                key={`${preset.label}-${preset.size}`}
                style={[styles.sizeBtn, preset.original && styles.sizeBtnOriginal]}
                onPress={() => submitOutpaint(preset.size)}
              >
                <Text style={[styles.sizeLabel, preset.original && styles.sizeBtnOriginalText]}>{preset.label}</Text>
                <Text style={[styles.sizeValue, preset.original && styles.sizeBtnOriginalValue]}>{preset.size}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </ModalSheet>

      {/* Generation size sheet：常用比例 / 原图比例 / 自定义宽高 */}
      <ModalSheet visible={sheet === 'size'} title="生成比例" onClose={() => setSheet(null)}>
        <View style={styles.padBody}>
          <Text style={styles.fieldLabel}>选择后，本次会话中的生成（文生图/改图）将使用该尺寸；不选择则跟随模型默认。</Text>
          <View style={styles.sizeGrid}>
            {outpaintPresets(imageModel?.provider, currentImage?.width, currentImage?.height).map((preset) => (
              <Pressable
                key={`${preset.label}-${preset.size}`}
                style={[styles.sizeBtn, genSize?.value === preset.size && styles.sizeBtnSelected]}
                onPress={() => { setGenSize({ value: preset.size, label: preset.label }); setSheet(null); notify(`已选择 ${preset.label} ${preset.size}`); }}
              >
                <Text style={[styles.sizeLabel, genSize?.value === preset.size && styles.sizeBtnOriginalText]}>{preset.label}</Text>
                <Text style={[styles.sizeValue, genSize?.value === preset.size && styles.sizeBtnOriginalValue]}>{preset.size}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.fieldLabel}>自定义宽 × 高（像素，256-4096）</Text>
          <View style={styles.customSizeRow}>
            <TextInput
              style={styles.customSizeInput}
              value={customW}
              onChangeText={(v) => setCustomW(v.replace(/[^0-9]/g, ''))}
              placeholder="宽"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
            />
            <Text style={styles.customSizeX}>×</Text>
            <TextInput
              style={styles.customSizeInput}
              value={customH}
              onChangeText={(v) => setCustomH(v.replace(/[^0-9]/g, ''))}
              placeholder="高"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
            />
            <Pressable style={styles.customSizeApply} onPress={applyCustomSize}>
              <Text style={styles.customSizeApplyText}>应用</Text>
            </Pressable>
          </View>
          {genSize && (
            <Pressable onPress={() => { setGenSize(null); setCustomW(''); setCustomH(''); setSheet(null); notify('已恢复模型默认尺寸'); }}>
              <Text style={styles.linkText}>恢复跟随模型默认</Text>
            </Pressable>
          )}
        </View>
      </ModalSheet>

      {/* Extract hint sheet */}
      <ModalSheet
        visible={sheet === 'extractHint'}
        title="提取素材"
        onClose={() => { setSheet(null); setSelectedRect(null); }}
        footer={
          <Pressable style={styles.primaryBtn} onPress={submitExtract} disabled={extractBusy}>
            {extractBusy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>提交提取</Text>
            )}
          </Pressable>
        }
      >
        <View style={styles.padBody}>
          <Text style={styles.fieldLabel}>补充说明（可选，帮助模型确定要提取的主体）</Text>
          <TextInput
            style={styles.instructionInput}
            value={extractHint}
            onChangeText={setExtractHint}
            placeholder="例如：只要那只猫，不要背景"
            placeholderTextColor={colors.muted}
            multiline
          />
          {selectedRect && (
            <Text style={styles.rectNote}>
              已圈选 {selectedRect.width.toFixed(1)}% × {selectedRect.height.toFixed(1)}% 区域，将截取后由视觉模型规划提取。
            </Text>
          )}
        </View>
      </ModalSheet>

      {/* Busy overlay for downloads / cropping */}
      {busyLabel ? (
        <View style={styles.busyOverlay} pointerEvents="none">
          <View style={styles.busyCard}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.busyText}>{busyLabel}</Text>
          </View>
        </View>
      ) : null}

      {/* 上传裁剪界面 */}
      {cropAsset && (
        <CropView
          visible
          uri={cropAsset.uri}
          rotation={cropAsset.rotation}
          onCancel={() => setCropAsset(null)}
          onUseOriginal={handleCropDone}
          onConfirm={handleCropDone}
        />
      )}
    </View>
  );
}

/** 数量下拉选择：替代占宽的四枚按钮，节省输入栏空间 */
function CountSelect({ value, onChange, colors }: { value: number; onChange: (n: number) => void; colors: ReturnType<typeof useTheme>['colors'] }) {
  const styles = countSelectStyles(colors);
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable style={styles.btn} onPress={() => setOpen(true)}>
        <Text style={styles.text}>数量 ×{value}</Text>
        <Icon name="chevronDown" size={13} color={colors.textSecondary} />
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {[1, 2, 3, 4].map((n) => (
              <Pressable
                key={n}
                style={styles.item}
                onPress={() => { onChange(n); setOpen(false); }}
              >
                <Text style={[styles.itemText, { color: n === value ? colors.accent : colors.text }]}>一次生成 {n} 张</Text>
                {n === value ? <Icon name="check" size={14} color={colors.accent} /> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const countSelectStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    btn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 30, paddingHorizontal: spacing.sm, borderRadius: radius.pill, backgroundColor: c.bg, borderWidth: 1, borderColor: c.border },
    text: { fontSize: fontSize.sm, color: c.text },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
    menu: { width: 220, borderRadius: radius.md, borderWidth: 1, overflow: 'hidden' },
    item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    itemText: { fontSize: fontSize.sm },
  });



/** 任务队列面板：排队/进行中/失败任务一目了然，支持取消与失败重试 */
function TasksPanel({ projectId, activeTask, failedTask, onRetry, onCancel }: {
  projectId: string;
  activeTask: GenerationTask | null;
  failedTask: { error: string | null; retryable: boolean } | null;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const styles = tasksPanelStyles(colors);
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pollStartRef = useRef(0);
  const pollFailRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listGeneratingTasks(projectId);
      setTasks(data.tasks);
      pollFailRef.current = 0;
    } catch { /* 静默重试 */ } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    pollStartRef.current = Date.now();
    const MAX_POLL_MS = 10 * 60 * 1000;
    const MAX_FAILS = 5;
    const timer = setInterval(async () => {
      // 超过 10 分钟停止轮询，避免长时间挂起耗电
      if (Date.now() - pollStartRef.current > MAX_POLL_MS) {
        clearInterval(timer);
        return;
      }
      try {
        const data = await api.listGeneratingTasks(projectId);
        setTasks(data.tasks);
        pollFailRef.current = 0;
      } catch {
        pollFailRef.current += 1;
        // 连续失败 5 次停止轮询，等待用户主动刷新
        if (pollFailRef.current >= MAX_FAILS) {
          clearInterval(timer);
        }
      } finally {
        setLoaded(true);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, projectId]);

  const rows = tasks.length ? tasks : activeTask ? [activeTask] : [];

  return (
    <View style={styles.container}>
      {failedTask ? (
        <View style={[styles.row, styles.failedRow]}>
          <View style={styles.rowMain}>
            <Text style={[styles.rowTitle, { color: colors.danger }]}>上次任务失败</Text>
            <Text style={[styles.rowSub, { color: colors.danger }]} numberOfLines={2}>{failedTask.error || '任务失败'}</Text>
          </View>
          {failedTask.retryable ? (
            <Pressable style={[styles.actionBtn, { backgroundColor: colors.danger }]} onPress={onRetry}>
              <Text style={styles.actionText}>重试</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {rows.map((task) => (
        <View key={task.id} style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>
              {TASK_OPERATION_LABELS[task.operationType || ''] || task.operationType || '任务'}
              {task.status === 'queued' ? ' · 排队中' : ' · 进行中'}
            </Text>
            <Text style={styles.rowSub}>
              {task.status === 'queued' && task.queuePosition ? `当前第 ${task.queuePosition} 位 · ` : ''}
              {task.status === 'generating' && task.stage ? `${STAGE_LABELS[task.stage] || '生成中'} · ` : ''}
              提交于 {formatTaskTime(task.createdAt) || '—'}
            </Text>
          </View>
          <Pressable style={[styles.actionBtn, { backgroundColor: colors.border }]} onPress={onCancel}>
            <Icon name="stop" size={13} color={colors.textSecondary} />
            <Text style={[styles.actionText, { color: colors.textSecondary }]}>取消</Text>
          </Pressable>
        </View>
      ))}

      {!rows.length && !failedTask && loaded ? (
        <View style={styles.empty}>
          <Icon name="check" size={28} color={colors.border} />
          <Text style={styles.emptyText}>当前没有进行中的任务</Text>
          <Text style={styles.emptySub}>生成中的任务会出现在这里；已完成的图片请到「历史」页查看</Text>
        </View>
      ) : null}
    </View>
  );
}

const tasksPanelStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { padding: spacing.md, gap: spacing.sm, minHeight: 180 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
    failedRow: { borderColor: `${c.danger}55`, backgroundColor: `${c.danger}0d` },
    rowMain: { flex: 1, gap: 2 },
    rowTitle: { fontSize: fontSize.sm, fontWeight: '700', color: c.text },
    rowSub: { fontSize: fontSize.xs, color: c.muted },
    actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
    actionText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
    empty: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
    emptyText: { fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    emptySub: { fontSize: fontSize.xs, color: c.muted, textAlign: 'center', paddingHorizontal: spacing.xl, lineHeight: 18 },
  });

function ToolBtn({ icon, label, colors, onPress, disabled, active }: { icon: string; label: string; colors: ReturnType<typeof useTheme>['colors']; onPress: () => void; disabled?: boolean; active?: boolean }) {
  const ts = toolStyles(colors);
  return (
    <Pressable
      style={[ts.btn, disabled && { opacity: 0.4 }, active && ts.btnActive]}
      onPress={onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={18} color={disabled ? colors.muted : active ? '#fff' : colors.accent} />
      <Text style={[ts.label, { color: disabled ? colors.muted : active ? '#fff' : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const toolStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, backgroundColor: `${c.accent}14`, minWidth: 56 },
  btnActive: { backgroundColor: c.accent },
  label: { fontSize: 10 },
});

function MessageBubble({ message, imagesById, colors, onImagePress }: { message: Message; imagesById: Map<string, ProjectImage>; colors: ReturnType<typeof useTheme>['colors']; onImagePress: (image: ProjectImage) => void }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const text = message.content.text || message.content.prompt || message.content.message || '';
  const outputImages = (message.content.outputImageIds || [])
    .map((id) => imagesById.get(id))
    .filter((img): img is ProjectImage => Boolean(img && img.fileSize > 0));

  return (
    <View style={[bubbleStyles.msgBubble, isUser ? { alignSelf: 'flex-end', backgroundColor: colors.accent } : isSystem ? bubbleStyles.msgSystem : { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]}>
      <Text style={[bubbleStyles.msgText, { color: isUser ? '#fff' : isSystem ? colors.danger : colors.text }]}>{text}</Text>
      {outputImages.length > 0 && (
        <View style={bubbleStyles.msgImages}>
          {outputImages.map((img) => (
            <Pressable key={img.id} onPress={() => onImagePress(img)}>
              <RemoteImage source={imageSource(img.url, 320)} style={bubbleStyles.msgImage} resizeMode="cover" fallbackLabel="图片加载失败" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  msgBubble: { maxWidth: '88%', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  msgSystem: { alignSelf: 'center', backgroundColor: 'transparent' },
  msgText: { fontSize: fontSize.md, lineHeight: 20 },
  msgImages: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  msgImage: { width: 84, height: 84, borderRadius: radius.sm },
});

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg },
    loadingText: { marginTop: spacing.md, fontSize: fontSize.md, color: c.muted },
    retryBtn: { marginTop: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: c.accent },
    retryBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
    topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border, gap: spacing.sm },
    topbarBtn: { padding: spacing.sm },
    topbarTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.md, fontWeight: '700', color: c.text, marginHorizontal: spacing.sm },
    canvasArea: { flex: 1, backgroundColor: c.canvasBg, overflow: 'hidden' },
    canvasWrap: { flex: 1, alignSelf: 'stretch' },
    zoomResetBtn: { position: 'absolute', top: spacing.md, right: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.pill, backgroundColor: 'rgba(0,0,0,0.6)' },
    zoomResetText: { color: '#fff', fontSize: fontSize.sm },
    canvasImage: { width: '100%', height: '100%' },
    canvasEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1, alignSelf: 'stretch' },
    canvasEmptyText: { marginTop: spacing.md, fontSize: fontSize.md, color: c.muted, textAlign: 'center', paddingHorizontal: spacing.xl },
    maskLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    selectTouchLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    cornerDot: { position: 'absolute', width: 12, height: 12, backgroundColor: c.accent, borderRadius: 2 },
    selectHintBar: { position: 'absolute', top: spacing.md, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
    selectHintText: { color: '#fff', fontSize: fontSize.xs },
    selectActionBar: { flexGrow: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
    selectCancelBtn: { height: 38, paddingHorizontal: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    selectCancelText: { color: c.textSecondary, fontSize: fontSize.sm },
    selectSizeText: { flex: 1, textAlign: 'center', fontSize: fontSize.xs, color: c.muted },
    selectNextBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 38, paddingHorizontal: spacing.md, borderRadius: radius.sm, backgroundColor: c.accent },
    selectNextText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
    toolRow: { flexGrow: 0, height: 74, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
    toolList: { paddingHorizontal: spacing.md, gap: spacing.sm, alignItems: 'center', paddingVertical: spacing.sm },
    candidateBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
    candidateList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm, alignItems: 'center' },
    candidateItem: { width: 56, height: 56, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
    candidateActive: { borderColor: c.accent },
    candidateImage: { width: '100%', height: '100%' },
    tabBar: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    tabBtn: { flex: 1, height: 38, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    tabBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
    tabText: { fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    tabTextActive: { color: '#fff' },
    tabBadge: { fontSize: fontSize.xs, color: c.accent, backgroundColor: c.accentLight, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
    tabBadgeActive: { color: '#fff', backgroundColor: 'rgba(255,255,255,0.25)' },
    tabDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
    chatPage: { flex: 1, minHeight: 0 },
    chatList: { flex: 1, backgroundColor: c.bg },
    chatListContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
    historyPage: { flex: 1, backgroundColor: c.bg },
    countRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
    canvasHint: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radius.md, backgroundColor: `${c.accent}14`, borderWidth: 1, borderColor: `${c.accent}33` },
    canvasHintThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: c.bg },
    canvasHintTextWrap: { flex: 1, gap: 2 },
    canvasHintTitle: { fontSize: fontSize.xs, fontWeight: '700', color: c.accent },
    canvasHintMeta: { fontSize: fontSize.xs, color: c.muted },
    taskPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: c.accent, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 4, maxWidth: 132 },
    taskPillText: { color: '#fff', fontSize: fontSize.xs },
    saveBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    saveBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: c.accentLight, borderWidth: 1, borderColor: c.accent },
    saveBtnDisabled: { opacity: 0.5 },
    saveBtnText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '700' },
    actionBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border },
    actionBtnDisabled: { opacity: 0.4 },
    actionText: { fontSize: fontSize.xs, color: c.textSecondary, fontWeight: '500' },
    batchPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.accentLight, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 5, marginLeft: 'auto' },
    batchPillText: { color: c.accent, fontSize: fontSize.xs, fontWeight: '700' },
    styleToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingBottom: spacing.xs },
    styleToggleText: { fontSize: fontSize.xs, color: c.muted, fontWeight: '600' },
    styleBadge: { fontSize: 10, color: c.accent, fontWeight: '700', backgroundColor: c.accentLight, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 4 },
    styleInput: { minHeight: 56, maxHeight: 96, marginBottom: spacing.sm },
    previewOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', paddingTop: 50, paddingBottom: 30 },
    previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    previewTitle: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600', flex: 1 },
    previewImage: { flex: 1, alignSelf: 'stretch' },
    previewInfo: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
    previewPrompt: { color: '#fff', fontSize: fontSize.sm, lineHeight: 19 },
    previewMeta: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.xs },
    previewActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
    previewShareBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: c.accent },
    previewShareText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '700' },
    previewGalleryBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: `${c.accent}55` },
    previewGalleryText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600' },
    previewUseBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, height: 44, borderRadius: radius.sm, backgroundColor: c.accent },
    previewUseText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    inputBarWrap: { flexShrink: 0 },
    inputBar: { flexDirection: 'column', flexShrink: 0, padding: spacing.md, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    input: { minHeight: 40, maxHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, backgroundColor: c.bg },
    inputGrow: { flex: 1 },
    sendBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: 40, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: c.accent },
    padBody: { padding: spacing.md, gap: spacing.md },
    fieldLabel: { fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    instructionInput: { minHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.card, padding: spacing.md, fontSize: fontSize.md, color: c.text, textAlignVertical: 'top' },
    referenceBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
    referenceThumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: c.muted },
    referenceText: { flex: 1, color: c.accent, fontSize: fontSize.sm },
    rectNote: { fontSize: fontSize.xs, color: c.muted },
    sizeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    sizeBtn: { width: '47%', padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.accent, backgroundColor: c.accentLight, alignItems: 'center', gap: 2 },
    sizeBtnOriginal: { backgroundColor: c.accent },
    sizeBtnOriginalText: { color: '#fff' },
    sizeBtnOriginalValue: { color: 'rgba(255,255,255,0.82)' },
    sizeLabel: { fontSize: fontSize.md, fontWeight: '700', color: c.accent },
    sizeValue: { fontSize: fontSize.xs, color: c.textSecondary },
    sizeBtnSelected: { backgroundColor: c.accent },
    miniChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
    miniChip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
    miniChipActive: { backgroundColor: c.accent, borderColor: c.accent },
    miniChipText: { fontSize: fontSize.xs, color: c.muted, fontWeight: '600' },
    miniChipTextActive: { color: '#fff', fontWeight: '700' },
    outpaintPreview: { width: '100%', maxWidth: 260, alignSelf: 'center', borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, backgroundColor: c.accentLight, overflow: 'hidden', marginBottom: spacing.xs },
    outpaintMeta: { fontSize: fontSize.xs, color: c.muted, textAlign: 'center', marginBottom: spacing.sm },
    customSizeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
    customSizeInput: { flex: 1, height: 42, borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, backgroundColor: c.card, paddingHorizontal: spacing.md, fontSize: fontSize.md, color: c.text },
    customSizeX: { color: c.muted, fontSize: fontSize.md },
    customSizeApply: { paddingHorizontal: spacing.lg, height: 42, borderRadius: radius.sm, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    customSizeApplyText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
    linkText: { color: c.accent, fontSize: fontSize.sm, fontWeight: '600', textAlign: 'center', paddingVertical: spacing.sm },
    primaryBtn: { height: 46, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
    // 顶部显示：与 App 级提示一致，避免遮挡画布底部工具栏
    busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 160 },
    busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    busyText: { color: c.text, fontSize: fontSize.sm },
    failedBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: `${c.danger}14`, borderTopWidth: 1, borderTopColor: `${c.danger}33` },
    failedText: { flex: 1, fontSize: fontSize.xs, color: c.danger },
    failedRetry: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: c.danger },
    failedRetryText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
  });
