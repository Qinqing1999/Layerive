import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, downloadToCache, imageSource, resolveUrl, versionDownloadPath } from '../api';
import { outpaintPresets } from '../sizes';
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

type SheetName = 'tasks' | 'history' | 'compare' | 'editText' | 'batch' | 'gallery' | 'localEdit' | 'outpaint' | 'extractHint' | null;
type SelectMode = 'localEdit' | 'extract' | null;
type WorkspaceTab = 'canvas' | 'chat' | 'history';

/** 图片百分比坐标（与服务端 rect 字段一致） */
type PercentRect = { x: number; y: number; width: number; height: number };

/** 画布内拖拽产生的显示坐标矩形 */
type DragRect = { x: number; y: number; width: number; height: number };

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

const OUTPAINT_HINT = '原图比例优先（向四周自然补全），也可选择主流画布比例';

const SELECT_HINTS: Record<'localEdit' | 'extract', string> = {
  localEdit: '在图片上拖拽框选要修改的区域',
  extract: '圈选想提取的主体（允许带少量背景）',
};

export function WorkspaceScreen({ projectId, models, activeModel, onBack, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [activeTask, setActiveTask] = useState<GenerationTask | null>(null);
  const [bottomTab, setBottomTab] = useState<WorkspaceTab>('canvas');
  const insets = useSafeAreaInsets();
  const [preview, setPreview] = useState<{ image: ProjectImage; message?: Message } | null>(null);
  const [count, setCount] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [cropAsset, setCropAsset] = useState<{ uri: string; data: string; mimeType: string; name: string; use: 'upload' | 'reference'; rotation: number } | null>(null);
  const [parentVersionId, setParentVersionId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [selectMode, setSelectMode] = useState<SelectMode>(null);
  const [selectedRect, setSelectedRect] = useState<PercentRect | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const canvasWrapRef = useRef<View | null>(null);
  const canvasOriginRef = useRef({ x: 0, y: 0 });
  /** 触摸事件 → 画布容器内坐标（pageX 全局稳定，不受 Android 子 View locationX 跳变影响） */
  function canvasPoint(evt: { nativeEvent: { pageX: number; pageY: number } }) {
    return {
      x: evt.nativeEvent.pageX - canvasOriginRef.current.x,
      y: evt.nativeEvent.pageY - canvasOriginRef.current.y,
    };
  }
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [localInstruction, setLocalInstruction] = useState('');
  const [localReference, setLocalReference] = useState<{ data: string; mimeType: string; name?: string } | null>(null);
  const [extractHint, setExtractHint] = useState('');
  const [extractBusy, setExtractBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  /** 最近一次提交（按任务 ID 记录），任务失败时可原样重发 */
  const lastSubmitRef = useRef<{ taskId: string; submit: () => Promise<GenerateResult> } | null>(null);
  const [failedTask, setFailedTask] = useState<{ error: string | null; retryable: boolean } | null>(null);

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

  const loadBundle = useCallback(async () => {
    try {
      const data = await api.getProject(projectId);
      setBundle(data);
      const draft = data.project.draft as { prompt?: string };
      if (draft?.prompt) setPrompt(draft.prompt);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [projectId, notify]);

  useEffect(() => { void loadBundle(); }, [loadBundle]);

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
    pollRef.current = setInterval(async () => {
      try {
        const task = await api.getTask(projectId, activeTask.id);
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
      } catch { /* ignore */ }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, bundle, projectId, loadBundle]);

  // 切换画布图片时退出框选模式
  useEffect(() => {
    setSelectMode(null);
    setDragRect(null);
  }, [currentImage?.id]);

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
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, base64: true });
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
    setBundle({ ...bundle, project: { ...bundle.project, currentImageId: image.id } });
    void api.updateProject(projectId, { currentImageId: image.id }).catch(() => {});
  }

  /** Use a history version as the current canvas + next generation input. */
  function useVersion(version: Version) {
    const target = version.outputs.find((img) => img.id === version.selectedImageId) || version.outputs[0];
    if (!target || !bundle) { notify('该版本没有可用输出图片', 'error'); return; }
    setBundle({ ...bundle, project: { ...bundle.project, currentImageId: target.id } });
    void api.updateProject(projectId, { currentImageId: target.id }).catch(() => {});
    setParentVersionId(version.id);
    setSheet(null);
    notify(`已切换到 V${version.number}，可从此版本继续创作`);
  }

  /** 提交任务并记录可重试闭包；轮询发现失败时可通过该闭包原样重发 */
  async function runTracked(submit: () => Promise<GenerateResult>) {
    setFailedTask(null);
    const result = await submit();
    lastSubmitRef.current = { taskId: result.taskId, submit };
    const task = await api.getTask(projectId, result.taskId);
    setActiveTask(task);
  }

  function retryFailed() {
    const entry = lastSubmitRef.current;
    if (!entry || !failedTask?.retryable) return;
    setFailedTask(null);
    setBottomTab('chat');
    runTracked(entry.submit).catch((e) => notify((e as Error).message, 'error'));
  }

  async function submitGenerate() {
    if (!prompt.trim() || generating) return;
    // 提交前固化输入，失败重试时沿用当时的画布图与父版本
    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      params: { count },
    };
    if (currentImage) input.imageId = currentImage.id;
    if (parentVersionId) input.parentVersionId = parentVersionId;
    setGenerating(true);
    setBottomTab('chat');
    try {
      await runTracked(() => api.generate(projectId, input));
      setParentVersionId(null);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setGenerating(false);
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
      enhance: () => api.enhance(projectId, { imageId: currentImage.id }),
      watermark: () => api.removeWatermark(projectId, { imageId: currentImage.id }),
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

  async function submitOutpaint(size: string) {
    if (!currentImage) return;
    const imageId = currentImage.id;
    setSheet(null);
    try {
      setBottomTab('chat');
      await runTracked(() => api.outpaint(projectId, { imageId, size }));
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  async function submitLocalEdit() {
    if (!currentImage || !selectedRect) return;
    if (!localInstruction.trim() && !localReference) { notify('请描述修改要求或上传参考图', 'error'); return; }
    // 固化本次输入（含参考图），失败后可原样重试
    const input: Record<string, unknown> = {
      imageId: currentImage.id,
      rect: selectedRect,
      instruction: localInstruction.trim(),
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
        await loadBundle();
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

  // ---- 画布框选：图片在画布内的实际显示区域（aspectFit） ----
  const imageDisplay = useMemo(() => {
    const cw = canvasSize.w;
    const ch = canvasSize.h;
    if (!cw || !ch || !currentImage?.width || !currentImage?.height) return null;
    const scale = Math.min(cw / currentImage.width, ch / currentImage.height);
    const w = currentImage.width * scale;
    const h = currentImage.height * scale;
    return { left: (cw - w) / 2, top: (ch - h) / 2, w, h };
  }, [canvasSize, currentImage?.width, currentImage?.height]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => Boolean(selectMode),
    onMoveShouldSetPanResponder: () => Boolean(selectMode),
    onPanResponderGrant: (evt) => {
      if (!selectMode || !imageDisplay) return;
      // Android 上 locationX 会随子 View 边界跳变，改用 pageX 减容器原点
      const p = canvasPoint(evt);
      dragStartRef.current = p;
      setDragRect({ x: p.x, y: p.y, width: 0, height: 0 });
    },
    onPanResponderMove: (evt) => {
      const start = dragStartRef.current;
      if (!start || !imageDisplay || !selectMode) return;
      const { x, y } = canvasPoint(evt);
      const left = Math.max(imageDisplay.left, Math.min(start.x, x));
      const right = Math.min(imageDisplay.left + imageDisplay.w, Math.max(start.x, x));
      const top = Math.max(imageDisplay.top, Math.min(start.y, y));
      const bottom = Math.min(imageDisplay.top + imageDisplay.h, Math.max(start.y, y));
      setDragRect({ x: left, y: top, width: right - left, height: bottom - top });
    },
    onPanResponderRelease: () => { dragStartRef.current = null; },
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

  /** 选区外蒙版：上 / 下 / 左 / 右四块半透明遮罩 */
  const renderCanvasMask = () => {
    if (!selectMode || !dragRect || !imageDisplay) return null;
    const { left: dLeft, top: dTop, w: dW, h: dH } = imageDisplay;
    const maskColor = 'rgba(0,0,0,0.55)';
    return (
      <View pointerEvents="none" style={styles.maskLayer}>
        <View style={{ position: 'absolute', left: dLeft, top: dTop, width: dW, height: Math.max(0, dragRect.y - dTop), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dLeft, top: dragRect.y + dragRect.height, width: dW, height: Math.max(0, (dTop + dH) - (dragRect.y + dragRect.height)), backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dLeft, top: dragRect.y, width: Math.max(0, dragRect.x - dLeft), height: dragRect.height, backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dragRect.x + dragRect.width, top: dragRect.y, width: Math.max(0, (dLeft + dW) - (dragRect.x + dragRect.width)), height: dragRect.height, backgroundColor: maskColor }} />
        <View style={{ position: 'absolute', left: dragRect.x, top: dragRect.y, width: dragRect.width, height: dragRect.height, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.sm }} />
        {/* 四角指示点 */}
        <View style={[styles.cornerDot, { left: dragRect.x - 4, top: dragRect.y - 4 }]} />
        <View style={[styles.cornerDot, { left: dragRect.x + dragRect.width - 4, top: dragRect.y - 4 }]} />
        <View style={[styles.cornerDot, { left: dragRect.x - 4, top: dragRect.y + dragRect.height - 4 }]} />
        <View style={[styles.cornerDot, { left: dragRect.x + dragRect.width - 4, top: dragRect.y + dragRect.height - 4 }]} />
      </View>
    );
  };

  if (loading || !bundle) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
        {busyLabel ? <Text style={styles.loadingText}>{busyLabel}</Text> : <Text style={styles.loadingText}>加载中…</Text>}
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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Top bar */}
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.topbarBtn}>
          <Icon name="back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.topbarTitle} numberOfLines={1}>
          {bundle.project.name}{parentVersionId ? '（从历史继续）' : ''}
        </Text>
        {activeTask ? (
          <Pressable style={styles.taskPill} onPress={() => setSheet('tasks')}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.taskPillText} numberOfLines={1}>{taskLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => setSheet('gallery')} hitSlop={8} style={styles.topbarBtn}>
          <Icon name="gallery" size={18} color={colors.text} />
        </Pressable>
        <Pressable onPress={pickImage} hitSlop={8} style={styles.topbarBtn} disabled={uploading}>
          {uploading ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="upload" size={18} color={colors.text} />}
        </Pressable>
      </View>

      {/* 历史版本独立页面 */}
      {bottomTab === 'history' ? (
        <View style={styles.historyPage}>
          <HistoryModal
            bundle={bundle}
            onUseVersion={useVersion}
            onDeleteVersion={deleteVersion}
            onDownloadVersion={downloadVersionZip}
          />
        </View>
      ) : bottomTab === 'canvas' ? (
      /* 画布页（框选蒙版直接叠加在画布上，工具栏为底部固定行不遮图） */
      <View style={styles.canvasArea}>
      <View
        ref={canvasWrapRef}
        style={styles.canvasWrap}
        onLayout={(e) => {
          setCanvasSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
          canvasWrapRef.current?.measureInWindow((x, y) => { canvasOriginRef.current = { x, y }; });
        }}
        {...panResponder.panHandlers}
      >
        {currentImage ? (
          <Pressable
            style={imageDisplay
              ? { position: 'absolute', left: imageDisplay.left, top: imageDisplay.top, width: imageDisplay.w, height: imageDisplay.h }
              : styles.canvasImage}
            disabled={Boolean(selectMode)}
            onPress={() => setPreview({ image: currentImage })}
          >
            <Image
              source={imageSource(currentImage.url, 1280)}
              style={{ width: '100%', height: '100%' }}
              resizeMode="stretch"
            />
          </Pressable>
        ) : (
          <Pressable style={styles.canvasEmpty} onPress={pickImage}>
            <Icon name="image" size={48} color={colors.border} />
            <Text style={styles.canvasEmptyText}>点击上传图片开始创作</Text>
          </Pressable>
        )}

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
            <ToolBtn icon="text" label="改字" colors={colors} disabled={!currentImage} onPress={() => setSheet('editText')} />
            <ToolBtn icon="region" label="局部" colors={colors} active={selectMode === 'localEdit'} disabled={!currentImage} onPress={() => toggleSelectMode('localEdit')} />
            <ToolBtn icon="crop" label="提取" colors={colors} active={selectMode === 'extract'} disabled={!currentImage} onPress={() => toggleSelectMode('extract')} />
            <ToolBtn icon="expand" label="扩图" colors={colors} disabled={!currentImage} onPress={() => setSheet('outpaint')} />
            <ToolBtn icon="enhance" label="清晰" colors={colors} disabled={!currentImage} onPress={() => runSpecial('enhance')} />
            <ToolBtn icon="droplet" label="去水印" colors={colors} disabled={!currentImage} onPress={() => runSpecial('watermark')} />
          </ScrollView>
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
        /* 对话页：全高消息列表 */
        <FlatList
          style={styles.chatList}
          data={messages}
          keyExtractor={(item: Message) => item.id}
          contentContainerStyle={styles.chatListContent}
          inverted
          renderItem={({ item }: { item: Message }) => (
            <MessageBubble
              message={item}
              imagesById={imageMapOf(bundle)}
              colors={colors}
              onImagePress={(img) => setPreview({ image: img, message: item })}
            />
          )}
        />
      )}

      {/* 候选图条 */}
      {bottomTab === 'canvas' && candidates.length > 1 && (
        <ScrollView horizontal style={styles.candidateBar} contentContainerStyle={styles.candidateList} showsHorizontalScrollIndicator={false}>
          {candidates.map((img) => (
            <Pressable key={img.id} onPress={() => useAsCurrent(img)} style={[styles.candidateItem, img.id === currentImage?.id && styles.candidateActive]}>
              <Image source={imageSource(img.url, 320)} style={styles.candidateImage} resizeMode="cover" />
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
      <View style={styles.tabBar}>
        <Pressable style={[styles.tabBtn, bottomTab === 'canvas' && styles.tabBtnActive]} onPress={() => setBottomTab('canvas')}>
          <Icon name="image" size={16} color={bottomTab === 'canvas' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'canvas' && styles.tabTextActive]}>画布</Text>
          {candidates.length > 1 ? <Text style={[styles.tabBadge, bottomTab === 'canvas' && styles.tabBadgeActive]}>{candidates.length}</Text> : null}
        </Pressable>
        <Pressable style={[styles.tabBtn, bottomTab === 'chat' && styles.tabBtnActive]} onPress={() => setBottomTab('chat')}>
          <Icon name="chatbubble" size={16} color={bottomTab === 'chat' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'chat' && styles.tabTextActive]}>对话</Text>
          {activeTask ? <View style={styles.tabDot} /> : null}
        </Pressable>
        <Pressable style={[styles.tabBtn, bottomTab === 'history' && styles.tabBtnActive]} onPress={() => setBottomTab('history')}>
          <Icon name="history" size={16} color={bottomTab === 'history' ? '#fff' : colors.textSecondary} />
          <Text style={[styles.tabText, bottomTab === 'history' && styles.tabTextActive]}>历史</Text>
        </Pressable>
      </View>

      {/* 输入栏：仅对话页显示，避免与画布页重复 */}
      {bottomTab === 'chat' ? (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inputBar}>
          {currentImage ? (
            <View style={styles.canvasHint}>
              {imageSource(currentImage.url, 128) ? (
                <Image source={imageSource(currentImage.url, 128)} style={styles.canvasHintThumb} resizeMode="cover" />
              ) : null}
              <View style={styles.canvasHintTextWrap}>
                <Text style={styles.canvasHintTitle}>正在编辑画布图片</Text>
                <Text style={styles.canvasHintMeta} numberOfLines={1}>
                  {[currentImage.width && currentImage.height ? `${currentImage.width}×${currentImage.height}` : '', '输入描述即可修改'].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          ) : null}
          <View style={styles.countRow}>
            <CountSelect value={count} onChange={setCount} colors={colors} />
            <Pressable style={styles.batchPill} onPress={() => setSheet('batch')}>
              <Icon name="batch" size={13} color={colors.accent} />
              <Text style={styles.batchPillText}>批量创作</Text>
            </Pressable>
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={prompt}
              onChangeText={setPrompt}
              placeholder={currentImage ? '描述你想如何修改这张图片…' : '描述你想生成的图片…'}
              placeholderTextColor={colors.muted}
              multiline
              scrollEnabled={false}
            />
            {generating || activeTask ? (
              <Pressable style={[styles.sendBtn, { backgroundColor: colors.danger }]} onPress={cancelTask}>
                <Icon name="stop" size={16} color="#fff" />
              </Pressable>
            ) : (
              <Pressable style={[styles.sendBtn, !prompt.trim() && { opacity: 0.5 }]} onPress={submitGenerate} disabled={!prompt.trim()}>
                <Icon name="send" size={16} color="#fff" />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      ) : null}

      {/* Sheets */}
      {/* 图片预览：消息图片与画布图片共用（大图 + 出处 + 保存/分享 + 设为画布） */}
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.previewOverlay}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {preview?.message?.content.versionNumber ? `V${preview.message.content.versionNumber} · 生成结果` : preview?.message ? '图片预览' : '画布图片'}
            </Text>
            <Pressable onPress={() => setPreview(null)} hitSlop={8}>
              <Icon name="close" size={22} color="#fff" />
            </Pressable>
          </View>
          {preview && (
            <Image source={imageSource(preview.image.url, 1280)} style={styles.previewImage} resizeMode="contain" />
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
            notify={notify}
            onSubmitted={(taskId) => {
              setSheet(null);
              setBottomTab('chat');
              void api.getTask(projectId, taskId).then((task) => {
                setActiveTask(task);
                notify('改字任务已提交，等待视觉规划与生成');
              }).catch(() => {});
            }}
            onCancel={() => setSheet(null)}
          />
        )}
      </ModalSheet>

      <ModalSheet visible={sheet === 'batch'} title="批量创作" onClose={() => setSheet(null)}>
        <BatchModal
          projectId={projectId}
          imageModel={imageModel}
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
          notify={notify}
          onUse={(usePrompt, stylePrompt) => {
            setPrompt(usePrompt || '');
            setSheet(null);
            notify(stylePrompt ? '提示词已填入（风格提示词已忽略，可在提示词中补充）' : '提示词已填入');
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

      {/* Outpaint size sheet */}
      <ModalSheet visible={sheet === 'outpaint'} title="扩图" onClose={() => setSheet(null)}>
        <View style={styles.padBody}>
          <Text style={styles.fieldLabel}>{OUTPAINT_HINT}</Text>
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

function imageMapOf(bundle: ProjectBundle): Map<string, ProjectImage> {
  const map = new Map<string, ProjectImage>();
  for (const img of bundle.images) map.set(img.id, img);
  return map;
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

/** 任务操作的中文名（与桌面端一致） */
const OPERATION_LABELS: Record<string, string> = {
  generate: '生成',
  local_edit: '局部编辑',
  local_edit_batch: '批量局部编辑',
  outpaint: '扩图',
  enhance: '清晰度提升',
  remove_watermark: '去水印',
  extract_asset: '提取素材',
  edit_text: '图片改字',
  batch_edit: '批量改图',
  batch_generate: '批量文生图',
  upload: '上传',
};

function formatTaskTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

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

  const refresh = useCallback(async () => {
    try {
      const data = await api.listGeneratingTasks(projectId);
      setTasks(data.tasks);
    } catch { /* 静默重试 */ } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

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
              {OPERATION_LABELS[task.operationType || ''] || task.operationType || '任务'}
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
  return (
    <Pressable
      style={[toolStyles.btn, disabled && { opacity: 0.4 }, active && toolStyles.btnActive]}
      onPress={onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={18} color={disabled ? colors.muted : active ? '#fff' : colors.accent} />
      <Text style={[toolStyles.label, { color: disabled ? colors.muted : active ? '#fff' : colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const toolStyles = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, backgroundColor: 'rgba(109,85,247,0.08)', minWidth: 56 },
  btnActive: { backgroundColor: '#6d55f7' },
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
    <View style={[bubbleStyles.msgBubble, isUser ? bubbleStyles.msgUser : isSystem ? bubbleStyles.msgSystem : { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }]}>
      <Text style={[bubbleStyles.msgText, { color: isUser ? '#fff' : isSystem ? colors.danger : colors.text }]}>{text}</Text>
      {outputImages.length > 0 && (
        <View style={bubbleStyles.msgImages}>
          {outputImages.map((img) => (
            <Pressable key={img.id} onPress={() => onImagePress(img)}>
              <Image source={imageSource(img.url, 320)} style={bubbleStyles.msgImage} resizeMode="cover" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  msgBubble: { maxWidth: '88%', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  msgUser: { alignSelf: 'flex-end', backgroundColor: '#6d55f7' },
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
    topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingTop: spacing.lg, paddingBottom: spacing.sm, backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    topbarBtn: { padding: spacing.xs },
    topbarTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.md, fontWeight: '700', color: c.text, marginHorizontal: spacing.sm },
    canvasArea: { flex: 1, backgroundColor: c.canvasBg, overflow: 'hidden' },
    canvasWrap: { flex: 1, alignSelf: 'stretch' },
    canvasImage: { width: '100%', height: '100%' },
    canvasEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1, alignSelf: 'stretch' },
    canvasEmptyText: { marginTop: spacing.md, fontSize: fontSize.md, color: c.muted, textAlign: 'center', paddingHorizontal: spacing.xl },
    maskLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    cornerDot: { position: 'absolute', width: 8, height: 8, backgroundColor: c.accent, borderRadius: 2 },
    selectHintBar: { position: 'absolute', top: spacing.md, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
    selectHintText: { color: '#fff', fontSize: fontSize.xs },
    selectActionBar: { position: 'absolute', bottom: spacing.md, left: spacing.md, right: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: spacing.sm },
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
    batchPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: c.accentLight, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 5, marginLeft: 'auto' },
    batchPillText: { color: c.accent, fontSize: fontSize.xs, fontWeight: '700' },
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
    previewUseBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, height: 44, borderRadius: radius.sm, backgroundColor: '#6d55f7' },
    previewUseText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    inputBar: { flexDirection: 'column', padding: spacing.md, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    input: { flex: 1, minHeight: 40, maxHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, backgroundColor: c.bg },
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
    primaryBtn: { height: 46, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
    busyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
    busyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    busyText: { color: c.text, fontSize: fontSize.sm },
    failedBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: `${c.danger}14`, borderTopWidth: 1, borderTopColor: `${c.danger}33` },
    failedText: { flex: 1, fontSize: fontSize.xs, color: c.danger },
    failedRetry: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: c.danger },
    failedRetryText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
  });
