import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
import { api, downloadToCache, imageSource, resolveUrl, versionDownloadPath } from '../api';
import { outpaintPresets } from '../sizes';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { GenerationTask, Message, ModelConfig, ProjectBundle, ProjectImage, Version } from '../types';
import { Icon } from '../components/Icon';
import { ModalSheet } from '../components/ModalSheet';
import { RectSelector, type PercentRect } from '../components/RectSelector';
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

type SheetName = 'history' | 'compare' | 'editText' | 'batch' | 'gallery' | 'localEdit' | 'outpaint' | 'extractHint' | null;

const STAGE_LABELS: Record<string, string> = {
  planning: '视觉定位中…',
  compositing: '参考图合成中…',
  generating: '生成中…',
  preserving: '还原框外像素…',
};

const OUTPAINT_HINT = '原图比例优先（向四周自然补全），也可选择主流画布比例';

export function WorkspaceScreen({ projectId, models, activeModel, onBack, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [activeTask, setActiveTask] = useState<GenerationTask | null>(null);
  const [bottomTab, setBottomTab] = useState<'canvas' | 'chat'>('canvas');
  const [count, setCount] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [parentVersionId, setParentVersionId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [selectMode, setSelectMode] = useState<'localEdit' | 'extract' | null>(null);
  const [selectedRect, setSelectedRect] = useState<PercentRect | null>(null);
  const [localInstruction, setLocalInstruction] = useState('');
  const [localReference, setLocalReference] = useState<{ data: string; mimeType: string; name?: string } | null>(null);
  const [extractHint, setExtractHint] = useState('');
  const [extractBusy, setExtractBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
          await loadBundle();
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeTask, bundle, projectId, loadBundle]);

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
      const mimeType = asset.mimeType || 'image/jpeg';
      setUploading(true);
      await uploadImage(asset.base64, mimeType, asset.fileName || `photo-${Date.now()}.jpg`);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setUploading(false);
    }
  }

  async function pickReference() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, base64: true });
      const asset = result.assets?.[0];
      if (!asset?.base64) return;
      setLocalReference({ data: asset.base64, mimeType: asset.mimeType || 'image/jpeg', name: asset.fileName || 'reference.jpg' });
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

  async function submitGenerate() {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setBottomTab('chat');
    try {
      const input: Record<string, unknown> = {
        prompt: prompt.trim(),
        params: { count },
      };
      if (currentImage) input.imageId = currentImage.id;
      if (parentVersionId) input.parentVersionId = parentVersionId;
      const result = await api.generate(projectId, input);
      setParentVersionId(null);
      const task = await api.getTask(projectId, result.taskId);
      setActiveTask(task);
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
            const result = await ops[kind]();
            const task = await api.getTask(projectId, result.taskId);
            setActiveTask(task);
          } catch (e) { notify((e as Error).message, 'error'); }
        },
      },
    ]);
  }

  async function submitOutpaint(size: string) {
    if (!currentImage) return;
    setSheet(null);
    try {
      setBottomTab('chat');
      const result = await api.outpaint(projectId, { imageId: currentImage.id, size });
      const task = await api.getTask(projectId, result.taskId);
      setActiveTask(task);
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  async function submitLocalEdit() {
    if (!currentImage || !selectedRect) return;
    if (!localInstruction.trim() && !localReference) { notify('请描述修改要求或上传参考图', 'error'); return; }
    setSheet(null);
    try {
      setBottomTab('chat');
      const input: Record<string, unknown> = {
        imageId: currentImage.id,
        rect: selectedRect,
        instruction: localInstruction.trim(),
      };
      if (localReference) input.reference = localReference;
      const result = await api.localEdit(projectId, input);
      const task = await api.getTask(projectId, result.taskId);
      setActiveTask(task);
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
    setExtractBusy(true);
    try {
      const width = currentImage.width;
      const height = currentImage.height;
      if (!width || !height) throw new Error('无法读取原图尺寸');
      const cropX = Math.round((selectedRect.x / 100) * width);
      const cropY = Math.round((selectedRect.y / 100) * height);
      const cropW = Math.min(width - cropX, Math.max(1, Math.round((selectedRect.width / 100) * width)));
      const cropH = Math.min(height - cropY, Math.max(1, Math.round((selectedRect.height / 100) * height)));
      if (cropW < 8 || cropH < 8) throw new Error('框选区域太小，请重新框选');

      const fullUrl = resolveUrl(currentImage.url);
      if (!fullUrl) throw new Error('图片地址无效');
      setBusyLabel('正在下载原图…');
      const localUri = await downloadToCache(fullUrl, `extract-src-${currentImage.id}`);
      let scale = 1;
      if (Math.max(cropW, cropH) > 2048) scale = 2048 / Math.max(cropW, cropH);
      if (Math.min(cropW, cropH) * scale < 256) scale = 256 / Math.min(cropW, cropH);
      const actions: ImageManipulator.Action[] = [{ crop: { originX: cropX, originY: cropY, width: cropW, height: cropH } }];
      if (Math.abs(scale - 1) > 0.01) actions.push({ resize: { width: Math.round(cropW * scale), height: Math.round(cropH * scale) } });
      setBusyLabel('正在截取选区…');
      const rendered = await ImageManipulator.manipulateAsync(localUri, actions, { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true });
      if (!rendered.base64) throw new Error('截图生成失败，请重试');

      setBusyLabel('正在提交任务…');
      setSheet(null);
      setBottomTab('chat');
      const result = await api.extractAsset(projectId, {
        imageId: currentImage.id,
        rect: selectedRect,
        crop: { data: rendered.base64, mimeType: 'image/jpeg' },
        hint: extractHint.trim(),
      });
      const task = await api.getTask(projectId, result.taskId);
      setActiveTask(task);
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

  const rectSelectorImage = selectMode ? currentImage : null;

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
      ? '排队等待中…'
      : (activeTask.stage && STAGE_LABELS[activeTask.stage]) || '生成中…'
    : '';

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.topbarBtn}>
          <Icon name="back" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.topbarTitle} numberOfLines={1}>
          {bundle.project.name}{parentVersionId ? '（从历史继续）' : ''}
        </Text>
        <Pressable onPress={pickImage} hitSlop={8} style={styles.topbarBtn} disabled={uploading}>
          {uploading ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="upload" size={18} color={colors.text} />}
        </Pressable>
      </View>

      {/* Bottom tabs */}
      <View style={styles.tabBar}>
        <Pressable style={[styles.tab, bottomTab === 'canvas' && styles.tabActive]} onPress={() => setBottomTab('canvas')}>
          <Text style={[styles.tabText, bottomTab === 'canvas' && styles.tabTextActive]}>画布</Text>
        </Pressable>
        <Pressable style={[styles.tab, bottomTab === 'chat' && styles.tabActive]} onPress={() => setBottomTab('chat')}>
          <Text style={[styles.tabText, bottomTab === 'chat' && styles.tabTextActive]}>对话</Text>
        </Pressable>
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {bottomTab === 'canvas' ? (
          <View style={styles.canvasPanel}>
            <View style={styles.canvasArea}>
              {currentImage ? (
                <Image source={imageSource(currentImage.url, 1280)} style={styles.canvasImage} resizeMode="contain" />
              ) : (
                <Pressable style={styles.canvasEmpty} onPress={pickImage}>
                  <Icon name="image" size={48} color={colors.border} />
                  <Text style={styles.canvasEmptyText}>点击上传图片，或输入提示词开始创作</Text>
                </Pressable>
              )}
            </View>
            {/* Tool row */}
            <ScrollView horizontal style={styles.toolRow} contentContainerStyle={styles.toolList} showsHorizontalScrollIndicator={false}>
              <ToolBtn icon="history" label="历史" colors={colors} onPress={() => setSheet('history')} />
              <ToolBtn icon="compare" label="对比" colors={colors} disabled={!parentImage} onPress={() => setSheet('compare')} />
              <ToolBtn icon="text" label="改字" colors={colors} disabled={!currentImage} onPress={() => setSheet('editText')} />
              <ToolBtn icon="region" label="局部" colors={colors} disabled={!currentImage} onPress={() => { setSelectMode('localEdit'); }} />
              <ToolBtn icon="crop" label="提取" colors={colors} disabled={!currentImage} onPress={() => { setSelectMode('extract'); }} />
              <ToolBtn icon="expand" label="扩图" colors={colors} disabled={!currentImage} onPress={() => setSheet('outpaint')} />
              <ToolBtn icon="enhance" label="清晰" colors={colors} disabled={!currentImage} onPress={() => runSpecial('enhance')} />
              <ToolBtn icon="droplet" label="去水印" colors={colors} disabled={!currentImage} onPress={() => runSpecial('watermark')} />
              <ToolBtn icon="batch" label="批量" colors={colors} onPress={() => setSheet('batch')} />
              <ToolBtn icon="gallery" label="画廊" colors={colors} onPress={() => setSheet('gallery')} />
            </ScrollView>
            {candidates.length > 1 && (
              <ScrollView horizontal style={styles.candidateBar} contentContainerStyle={styles.candidateList} showsHorizontalScrollIndicator={false}>
                {candidates.map((img) => (
                  <Pressable key={img.id} onPress={() => useAsCurrent(img)} style={[styles.candidateItem, img.id === currentImage?.id && styles.candidateActive]}>
                    <Image source={imageSource(img.url, 320)} style={styles.candidateImage} resizeMode="cover" />
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(item: Message) => item.id}
            contentContainerStyle={styles.chatList}
            inverted
            renderItem={({ item }: { item: Message }) => (
              <MessageBubble message={item} imagesById={imageMapOf(bundle)} colors={colors} />
            )}
          />
        )}
      </View>

      {/* Input bar */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inputBar}>
          <View style={styles.countRow}>
            <Text style={styles.countLabel}>数量</Text>
            {[1, 2, 3, 4].map((n) => (
              <Pressable key={n} style={[styles.countBtn, count === n && styles.countBtnActive]} onPress={() => setCount(n)}>
                <Text style={[styles.countText, count === n && styles.countTextActive]}>{n}</Text>
              </Pressable>
            ))}
            {taskLabel ? (
              <Pressable style={styles.taskPill} onPress={cancelTask}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.taskPillText}>{taskLabel}</Text>
                <Icon name="stop" size={12} color="#fff" />
              </Pressable>
            ) : null}
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

      {/* Region selection overlays */}
      {rectSelectorImage && selectMode === 'localEdit' && (
        <RectSelector
          imageUrl={rectSelectorImage.url}
          imageWidth={rectSelectorImage.width}
          imageHeight={rectSelectorImage.height}
          title="局部编辑 · 框选区域"
          hint="拖拽框选需要修改的区域（可从图片外开始拖拽，自动取交集）"
          confirmLabel="下一步"
          onConfirm={(rect) => { setSelectedRect(rect); setSelectMode(null); setSheet('localEdit'); }}
          onCancel={() => setSelectMode(null)}
        />
      )}
      {rectSelectorImage && selectMode === 'extract' && (
        <RectSelector
          imageUrl={rectSelectorImage.url}
          imageWidth={rectSelectorImage.width}
          imageHeight={rectSelectorImage.height}
          title="提取素材 · 圈选主体"
          hint="圈选想提取的主体（允许带少量背景，模型会自动去除干扰）"
          confirmLabel="下一步"
          onConfirm={(rect) => { setSelectedRect(rect); setSelectMode(null); setSheet('extractHint'); }}
          onCancel={() => setSelectMode(null)}
        />
      )}

      {/* Sheets */}
      <ModalSheet visible={sheet === 'history'} title="历史版本" onClose={() => setSheet(null)}>
        <HistoryModal
          bundle={bundle}
          onUseVersion={useVersion}
          onDeleteVersion={deleteVersion}
          onDownloadVersion={downloadVersionZip}
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

      <ModalSheet visible={sheet === 'batch'} title="批量生成" onClose={() => setSheet(null)}>
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
            setBottomTab('chat');
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
            <Icon name="upload" size={16} color={colors.accent} />
            <Text style={styles.referenceText}>{localReference ? `已选参考图：${localReference.name || '图片'}` : '添加参考图（可选）'}</Text>
            {localReference && (
              <Pressable hitSlop={8} onPress={() => setLocalReference(null)}>
                <Icon name="close" size={16} color={colors.muted} />
              </Pressable>
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
    </View>
  );
}

function imageMapOf(bundle: ProjectBundle): Map<string, ProjectImage> {
  const map = new Map<string, ProjectImage>();
  for (const img of bundle.images) map.set(img.id, img);
  return map;
}

function ToolBtn({ icon, label, colors, onPress, disabled }: { icon: string; label: string; colors: ReturnType<typeof useTheme>['colors']; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={[toolStyles.btn, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={18} color={disabled ? colors.muted : colors.accent} />
      <Text style={[toolStyles.label, { color: colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}

const toolStyles = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.md, backgroundColor: 'rgba(109,85,247,0.08)', minWidth: 56 },
  label: { fontSize: 10 },
});

function MessageBubble({ message, imagesById, colors }: { message: Message; imagesById: Map<string, ProjectImage>; colors: ReturnType<typeof useTheme>['colors'] }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const text = message.content.text || message.content.prompt || message.content.message || '';
  const outputImages = (message.content.outputImageIds || [])
    .map((id) => imagesById.get(id))
    .filter((img): img is ProjectImage => Boolean(img && img.fileSize > 0));

  return (
    <View style={[bubbleStyles.msgBubble, isUser ? bubbleStyles.msgUser : isSystem ? bubbleStyles.msgSystem : bubbleStyles.msgAssistant]}>
      <Text style={[bubbleStyles.msgText, { color: isUser ? '#fff' : isSystem ? colors.danger : colors.text }]}>{text}</Text>
      {outputImages.length > 0 && (
        <View style={bubbleStyles.msgImages}>
          {outputImages.map((img) => (
            <Image key={img.id} source={imageSource(img.url, 320)} style={bubbleStyles.msgImage} resizeMode="cover" />
          ))}
        </View>
      )}
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  msgBubble: { maxWidth: '88%', padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.sm },
  msgUser: { alignSelf: 'flex-end', backgroundColor: '#6d55f7' },
  msgAssistant: { alignSelf: 'flex-start', backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#e4e6eb' },
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
    tabBar: { flexDirection: 'row', backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border },
    tab: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center' },
    tabActive: { borderBottomWidth: 2, borderBottomColor: c.accent },
    tabText: { fontSize: fontSize.md, color: c.muted },
    tabTextActive: { color: c.accent, fontWeight: '700' },
    canvasPanel: { flex: 1, backgroundColor: c.canvasBg },
    canvasArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.md },
    canvasImage: { width: '100%', height: '100%' },
    canvasEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl, flex: 1, alignSelf: 'stretch' },
    canvasEmptyText: { marginTop: spacing.md, fontSize: fontSize.md, color: c.muted, textAlign: 'center' },
    toolRow: { flexGrow: 0, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
    toolList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm, alignItems: 'center' },
    candidateBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
    candidateList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm, alignItems: 'center' },
    candidateItem: { width: 56, height: 56, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
    candidateActive: { borderColor: c.accent },
    candidateImage: { width: '100%', height: '100%' },
    countRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
    countLabel: { fontSize: fontSize.sm, color: c.muted },
    countBtn: { width: 30, height: 26, borderRadius: radius.sm, backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    countBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
    countText: { fontSize: fontSize.sm, color: c.textSecondary },
    countTextActive: { color: '#fff', fontWeight: '700' },
    taskPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: c.accent, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 4, marginLeft: 'auto' },
    taskPillText: { color: '#fff', fontSize: fontSize.xs },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    chatList: { padding: spacing.md, gap: spacing.sm },
    inputBar: { flexDirection: 'column', padding: spacing.md, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    input: { flex: 1, minHeight: 40, maxHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, backgroundColor: c.bg },
    sendBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: 40, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: c.accent },
    padBody: { padding: spacing.md, gap: spacing.md },
    fieldLabel: { fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    instructionInput: { minHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.card, padding: spacing.md, fontSize: fontSize.md, color: c.text, textAlignVertical: 'top' },
    referenceBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
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
  });
