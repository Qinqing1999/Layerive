import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, imageSource } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { BatchEditProgress, ModelConfig } from '../../types';
import { Icon } from '../../components/Icon';

type Props = {
  projectId: string;
  imageModel: ModelConfig | null;
  hasCanvasImage: boolean;
  notify: (message: string, kind?: 'success' | 'error') => void;
  onFinished: () => void;
  onClose: () => void;
};

type Mode = 'edit' | 'generate';
type Entry = 'template' | 'prompts';

function parseVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const name = match[1].trim();
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Batch panel: batch edit (needs canvas image) / batch text-to-image, with live progress. */
export function BatchModal({ projectId, imageModel, hasCanvasImage, notify, onFinished, onClose }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const canEdit = hasCanvasImage && Boolean(imageModel?.capabilities.includes('edit_prompt'));
  const canGenerate = Boolean(imageModel?.capabilities.includes('text_to_image'));
  const [mode, setMode] = useState<Mode>(canEdit ? 'edit' : 'generate');
  const [entry, setEntry] = useState<Entry>('template');
  const [template, setTemplate] = useState('');
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [promptsText, setPromptsText] = useState('');
  const [stylePrompt, setStylePrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<BatchEditProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const finishedRef = useRef(false);

  const variables = useMemo(() => parseVariables(template), [template]);

  const linesOf = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);
  const quantity = useMemo(() => {
    if (entry === 'prompts') return linesOf(promptsText).length;
    if (!variables.length) return 0;
    return linesOf(varValues[variables[0]] || '').length;
  }, [entry, promptsText, variables, varValues]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function startPolling(taskId: string) {
    taskIdRef.current = taskId;
    finishedRef.current = false;
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getBatchEdit(projectId, taskId);
        setProgress(data);
        if (data.status !== 'generating' && data.status !== 'queued' && !finishedRef.current) {
          finishedRef.current = true;
          if (pollRef.current) clearInterval(pollRef.current);
          onFinished();
        }
      } catch { /* keep polling */ }
    }, 1500);
  }

  function validate(): string | null {
    if (mode === 'edit' && !hasCanvasImage) return '批量改图需要画布中已有图片';
    if (!imageModel) return '未找到可用图片模型';
    if (entry === 'template') {
      if (!template.trim()) return '请填写提示词模板';
      if (!variables.length) return '模板中至少包含一个 {{变量}}';
      if (variables.length > 10) return '模板最多支持 10 个变量';
      if (quantity < 2 || quantity > 50) return '每个变量的取值需要 2–50 行';
      for (const name of variables) {
        const values = linesOf(varValues[name] || '');
        if (values.length !== quantity) return `变量「${name}」需要 ${quantity} 行取值`;
      }
    } else {
      const prompts = linesOf(promptsText);
      if (prompts.length < 2 || prompts.length > 50) return '提示词列表需要 2–50 行';
      if (prompts.some((line) => line.length > 1000)) return '单条提示词不能超过 1000 字符';
    }
    if (mode === 'generate' && stylePrompt.length > 2000) return '统一风格提示词不能超过 2000 字符';
    return null;
  }

  async function start() {
    const error = validate();
    if (error) { notify(error, 'error'); return; }
    setStarting(true);
    try {
      const base: Record<string, unknown> = {};
      if (entry === 'template') {
        base.template = template;
        base.quantity = quantity;
        base.variables = variables.map((name) => ({ name, values: linesOf(varValues[name] || '') }));
      } else {
        base.prompts = linesOf(promptsText);
      }
      if (mode === 'generate') {
        if (stylePrompt.trim()) base.stylePrompt = stylePrompt.trim();
        const result = await api.startBatchGenerate(projectId, base);
        startPolling(result.taskId);
      } else {
        const result = await api.startBatchEdit(projectId, base);
        startPolling(result.taskId);
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!taskIdRef.current) return;
    try {
      await api.cancelTask(projectId, taskIdRef.current);
      notify('正在取消，已完成图片会保留');
    } catch (e) { notify((e as Error).message, 'error'); }
  }

  if (progress) {
    const total = progress.total;
    const done = progress.completed + progress.failed;
    const ratio = total > 0 ? done / total : 0;
    const images = progress.items.filter((item) => item.image).map((item) => item.image!);
    const statusLabel: Record<string, string> = { queued: '排队中', generating: '进行中', success: '已完成', partial: '部分完成', failed: '失败', canceled: '已取消' };
    return (
      <View style={styles.progressWrap}>
        <View style={styles.progressHead}>
          <Text style={styles.progressTitle}>{statusLabel[progress.status] || progress.status}</Text>
          <Text style={styles.progressCount}>
            {progress.completed}/{total} 张{progress.failed ? ` · 失败 ${progress.failed}` : ''}
          </Text>
        </View>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.round(ratio * 100)}%` }]} />
        </View>
        <Text style={styles.eta}>
          {progress.status === 'queued'
            ? '任务排队等待中…'
            : progress.status === 'generating'
              ? `剩余约 ${progress.remaining} 张${progress.estimatedRemainingSeconds ? ` · 预计 ${Math.ceil(progress.estimatedRemainingSeconds / 60)} 分钟` : ''}`
              : progress.error || `版本 V${progress.versionNumber ?? ''} 已写入${progress.failed ? '，失败项已跳过' : ''}`}
        </Text>
        {images.length > 0 && (
          <FlatList
            horizontal
            data={images}
            keyExtractor={(img) => img.id}
            contentContainerStyle={styles.thumbsRow}
            renderItem={({ item }) => (
              <Image source={imageSource(item.url, 320)} style={styles.thumb} resizeMode="cover" />
            )}
          />
        )}
        <View style={styles.progressFooter}>
          {progress.status === 'generating' || progress.status === 'queued' ? (
            <Pressable style={[styles.footerBtn, { backgroundColor: colors.danger }]} onPress={cancel}>
              <Icon name="stop" size={16} color="#fff" />
              <Text style={styles.footerBtnText}>取消任务</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.footerBtn, { backgroundColor: colors.accent }]} onPress={onClose}>
              <Text style={styles.footerBtnText}>完成</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <View style={styles.segRow}>
          <Pressable style={[styles.segBtn, mode === 'edit' && styles.segActive, !canEdit && { opacity: 0.4 }]} onPress={() => canEdit && setMode('edit')}>
            <Text style={[styles.segText, mode === 'edit' && styles.segTextActive]}>批量改图</Text>
          </Pressable>
          <Pressable style={[styles.segBtn, mode === 'generate' && styles.segActive, !canGenerate && { opacity: 0.4 }]} onPress={() => canGenerate && setMode('generate')}>
            <Text style={[styles.segText, mode === 'generate' && styles.segTextActive]}>批量文生图</Text>
          </Pressable>
        </View>
        {!canEdit && mode === 'edit' ? <Text style={styles.warn}>需要画布中有图片，且模型支持改图</Text> : null}
        <View style={styles.segRow}>
          <Pressable style={[styles.segBtnSmall, entry === 'template' && styles.segActive]} onPress={() => setEntry('template')}>
            <Text style={[styles.segText, entry === 'template' && styles.segTextActive]}>变量模板</Text>
          </Pressable>
          <Pressable style={[styles.segBtnSmall, entry === 'prompts' && styles.segActive]} onPress={() => setEntry('prompts')}>
            <Text style={[styles.segText, entry === 'prompts' && styles.segTextActive]}>提示词列表</Text>
          </Pressable>
        </View>
      </View>

      {entry === 'template' ? (
        <View style={[styles.section, { flex: 1 }]}>
          <Text style={styles.label}>提示词模板（用 {'{{变量名}}'} 占位，最多 10 个变量）</Text>
          <TextInput
            style={[styles.templateInput, mode === 'edit' && { minHeight: 64 }]}
            value={template}
            onChangeText={setTemplate}
            placeholder={mode === 'edit' ? '保持画布图片构图，把 {{动作}} 改为…' : '一个 {{形容词}} 的 {{主体}}，{{风格}}'}
            placeholderTextColor={colors.muted}
            multiline
          />
          {variables.length > 0 && (
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>变量取值（每行一个，共 {quantity || '—'} 张，需 2–50）</Text>
              <FlatList
                data={variables}
                keyExtractor={(name) => name}
                contentContainerStyle={{ gap: spacing.sm }}
                renderItem={({ item: name }) => (
                  <View>
                    <Text style={styles.varName}>{`{{${name}}}`}</Text>
                    <TextInput
                      style={styles.valuesInput}
                      value={varValues[name] || ''}
                      onChangeText={(text) => setVarValues((prev) => ({ ...prev, [name]: text }))}
                      placeholder={'每行一个取值，例如：\n微笑\n大笑\n严肃'}
                      placeholderTextColor={colors.muted}
                      multiline
                    />
                  </View>
                )}
              />
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.section, { flex: 1 }]}>
          <Text style={styles.label}>提示词列表（每行一条，共 {quantity || '—'} 张，单条 ≤1000 字符）</Text>
          <TextInput
            style={[styles.valuesInput, { flex: 1 }]}
            value={promptsText}
            onChangeText={setPromptsText}
            placeholder={'每行一条完整提示词，例如：\n黄昏海边的灯塔，暖色调\n雪夜森林的小木屋，冷色调'}
            placeholderTextColor={colors.muted}
            multiline
          />
        </View>
      )}

      {mode === 'generate' && (
        <View style={styles.section}>
          <Text style={styles.label}>统一风格提示词（可选，追加到每条提示词）</Text>
          <TextInput
            style={[styles.templateInput, { minHeight: 48 }]}
            value={stylePrompt}
            onChangeText={setStylePrompt}
            placeholder="例如：电影感光影，胶片质感"
            placeholderTextColor={colors.muted}
            multiline
          />
        </View>
      )}

      <View style={styles.footer}>
        <Text style={styles.countNote}>将生成 {quantity >= 2 && quantity <= 50 ? quantity : '—'} 张</Text>
        <Pressable style={[styles.startBtn, starting && { opacity: 0.6 }]} onPress={start} disabled={starting}>
          {starting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.startText}>开始生成</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1 },
    section: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: spacing.sm },
    segRow: { flexDirection: 'row', gap: spacing.sm },
    segBtn: { flex: 1, height: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
    segBtnSmall: { flex: 1, height: 34, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
    segActive: { backgroundColor: c.accentLight, borderColor: c.accent },
    segText: { fontSize: fontSize.sm, color: c.textSecondary },
    segTextActive: { color: c.accent, fontWeight: '700' },
    warn: { fontSize: fontSize.xs, color: c.warning },
    label: { fontSize: fontSize.sm, color: c.textSecondary, fontWeight: '600' },
    templateInput: { minHeight: 80, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.card, padding: spacing.md, fontSize: fontSize.md, color: c.text, textAlignVertical: 'top' },
    varName: { fontSize: fontSize.xs, color: c.accent, fontWeight: '700', marginBottom: 4 },
    valuesInput: { minHeight: 72, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.card, padding: spacing.sm, fontSize: fontSize.sm, color: c.text, textAlignVertical: 'top' },
    footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, paddingBottom: spacing.xl, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    countNote: { flex: 1, fontSize: fontSize.sm, color: c.muted },
    startBtn: { height: 44, paddingHorizontal: spacing.xl, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    startText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
    progressWrap: { flex: 1, padding: spacing.md },
    progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    progressTitle: { fontSize: fontSize.lg, fontWeight: '700', color: c.text },
    progressCount: { fontSize: fontSize.sm, color: c.textSecondary },
    barTrack: { height: 8, borderRadius: 4, backgroundColor: c.border, marginTop: spacing.md, overflow: 'hidden' },
    barFill: { height: '100%', backgroundColor: c.accent, borderRadius: 4 },
    eta: { fontSize: fontSize.xs, color: c.muted, marginTop: spacing.sm },
    thumbsRow: { paddingVertical: spacing.md, gap: spacing.sm },
    thumb: { width: 84, height: 84, borderRadius: radius.sm, backgroundColor: c.card },
    progressFooter: { marginTop: 'auto', flexDirection: 'row' },
    footerBtn: { flex: 1, height: 46, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    footerBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
