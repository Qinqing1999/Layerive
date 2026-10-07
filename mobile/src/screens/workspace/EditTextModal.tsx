import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../../api';
import { useTheme } from '../../theme';
import { fontSize, radius, spacing } from '../../theme';
import type { ProjectImage, TextSegment } from '../../types';
import { Icon } from '../../components/Icon';

type Props = {
  projectId: string;
  image: ProjectImage;
  visionModelId: string;
  /** 生成尺寸档位（原图比例映射），保证改字输出与原图同比例 */
  size?: string;
  notify: (message: string, kind?: 'success' | 'error') => void;
  onSubmitted: (taskId: string, editInput: Record<string, unknown>) => void;
  onCancel: () => void;
};

/** Recognized-text editor: load segments, edit / delete / add, then submit edit-text task. */
export function EditTextModal({ projectId, image, visionModelId, size, notify, onSubmitted, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [recognizedBy, setRecognizedBy] = useState('');
  const [recognizeError, setRecognizeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecognizeError(null);
    api.recognizeText(projectId, image.id, visionModelId)
      .then((result) => {
        if (cancelled) return;
        setSegments(result.segments || []);
        setRecognizedBy(result.cached ? '已使用缓存识别结果' : `已由 ${result.modelName} 识别`);
      })
      .catch((e: Error) => { if (!cancelled) setRecognizeError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, image.id]);

  function retryRecognize() {
    setSegments([]);
    setRecognizedBy('');
    setRecognizeError(null);
    setLoading(true);
    api.recognizeText(projectId, image.id, visionModelId)
      .then((result) => {
        setSegments(result.segments || []);
        setRecognizedBy(result.cached ? '已使用缓存识别结果' : `已由 ${result.modelName} 识别`);
      })
      .catch((e: Error) => setRecognizeError(e.message))
      .finally(() => setLoading(false));
  }

  function updateSegment(id: string, text: string) {
    setSegments((prev) => prev.map((seg) => (seg.id === id ? { ...seg, text } : seg)));
  }

  function moveSegment(id: string, direction: -1 | 1) {
    setSegments((prev) => {
      const idx = prev.findIndex((seg) => seg.id === id);
      if (idx < 0) return prev;
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function addManual() {
    setSegments((prev) => [
      ...prev,
      { id: `manual-${Date.now()}`, text: '', originalText: '', context: '手动框选新增的文字', manual: true },
    ]);
  }

  async function submit() {
    if (submitting) return;
    const changed = segments.filter((seg) => seg.originalText !== seg.text && (seg.originalText || (seg.manual && seg.text)));
    if (!changed.length) { notify('请先修改、删除或新增至少一段文字', 'error'); return; }
    setSubmitting(true);
    try {
      const editInput: Record<string, unknown> = {
        imageId: image.id,
        visionModelId,
        segments: changed.map((seg) => ({
          originalText: seg.originalText,
          text: seg.text,
          context: seg.context,
          manual: Boolean(seg.manual),
          rect: seg.rect || null,
        })),
      };
      if (size) editInput.params = { size };
      const result = await api.editText(projectId, editInput);
      onSubmitted(result.taskId, editInput);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.loadingText}>视觉模型正在识别图片文字…</Text>
        </View>
      ) : recognizeError ? (
        <View style={styles.loadingWrap}>
          <Icon name="close" size={32} color={colors.danger} />
          <Text style={styles.errorText}>识别失败：{recognizeError}</Text>
          <Pressable style={styles.retryBtn} onPress={retryRecognize}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={segments}
          keyExtractor={(item: TextSegment) => item.id}
          contentContainerStyle={styles.list}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          ListHeaderComponent={recognizedBy ? <Text style={styles.headerNote}>{recognizedBy}，可直接修改下方文字内容；清空表示删除。</Text> : null}
          ListEmptyComponent={<Text style={styles.empty}>未识别到文字，可在下方手动新增。</Text>}
          renderItem={({ item, index }: { item: TextSegment; index: number }) => (
            <View style={styles.row}>
              <View style={styles.rowText}>
                {item.originalText ? <Text style={styles.original} numberOfLines={1}>原文：{item.originalText}</Text> : null}
                <TextInput
                  style={[styles.input, !item.text && { color: colors.muted }]}
                  value={item.text}
                  onChangeText={(text) => updateSegment(item.id, text)}
                  placeholder={item.originalText ? '清空则删除该段文字' : '输入要新增的文字'}
                  placeholderTextColor={colors.muted}
                />
                {item.context ? <Text style={styles.context} numberOfLines={1}>{item.context}</Text> : null}
              </View>
              <View style={styles.rowActions}>
                <Pressable style={[styles.moveBtn, index === 0 && { opacity: 0.3 }]} onPress={() => moveSegment(item.id, -1)} disabled={index === 0}>
                  <Icon name="chevronUp" size={14} color={colors.muted} />
                </Pressable>
                <Pressable style={[styles.moveBtn, index === segments.length - 1 && { opacity: 0.3 }]} onPress={() => moveSegment(item.id, 1)} disabled={index === segments.length - 1}>
                  <Icon name="chevronDown" size={14} color={colors.muted} />
                </Pressable>
                <Pressable style={styles.deleteBtn} onPress={() => updateSegment(item.id, '')}>
                  <Icon name="trash" size={16} color={colors.danger} />
                </Pressable>
              </View>
            </View>
          )}
          ListFooterComponent={
            <Pressable style={styles.addBtn} onPress={addManual}>
              <Icon name="plus" size={16} color={colors.accent} />
              <Text style={styles.addText}>新增文字</Text>
            </Pressable>
          }
        />
      )}
      <View style={styles.footer}>
        <Pressable style={styles.cancelBtn} onPress={onCancel} disabled={submitting}>
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
        <Pressable style={[styles.submitBtn, (submitting || loading) && { opacity: 0.5 }]} onPress={submit} disabled={submitting || loading}>
          {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.submitText}>提交并改图</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1 },
    loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
    loadingText: { color: c.muted, fontSize: fontSize.md },
    errorText: { color: c.danger, fontSize: fontSize.md, textAlign: 'center', paddingHorizontal: spacing.lg },
    retryBtn: { marginTop: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: c.accent, borderRadius: radius.md },
    retryText: { color: c.accent, fontSize: fontSize.md, fontWeight: '600' },
    list: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
    headerNote: { fontSize: fontSize.sm, color: c.muted, marginBottom: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, paddingVertical: spacing.xl },
    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.sm, gap: spacing.sm },
    rowText: { flex: 1 },
    rowActions: { alignItems: 'center', gap: 2 },
    moveBtn: { padding: 4, borderRadius: radius.sm },
    original: { fontSize: fontSize.xs, color: c.muted, marginBottom: 2 },
    input: { minHeight: 38, borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, backgroundColor: c.input, paddingHorizontal: spacing.sm, fontSize: fontSize.md, color: c.text, paddingVertical: 6 },
    context: { fontSize: fontSize.xs, color: c.muted, marginTop: 2 },
    deleteBtn: { padding: spacing.sm },
    addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, padding: spacing.md, borderWidth: 1, borderStyle: 'dashed', borderColor: c.accent, borderRadius: radius.md },
    addText: { color: c.accent, fontSize: fontSize.md, fontWeight: '600' },
    footer: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, paddingBottom: spacing.xl, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
    cancelBtn: { flex: 1, height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    cancelText: { color: c.textSecondary, fontSize: fontSize.md },
    submitBtn: { flex: 2, height: 46, borderRadius: radius.md, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
