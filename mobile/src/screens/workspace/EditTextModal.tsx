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
  notify: (message: string, kind?: 'success' | 'error') => void;
  onSubmitted: (taskId: string) => void;
  onCancel: () => void;
};

/** Recognized-text editor: load segments, edit / delete / add, then submit edit-text task. */
export function EditTextModal({ projectId, image, notify, onSubmitted, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [recognizedBy, setRecognizedBy] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.recognizeText(projectId, image.id)
      .then((result) => {
        if (cancelled) return;
        setSegments(result.segments || []);
        setRecognizedBy(result.cached ? '已使用缓存识别结果' : `已由 ${result.modelName} 识别`);
      })
      .catch((e: Error) => { if (!cancelled) notify(e.message, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, image.id]);

  function updateSegment(id: string, text: string) {
    setSegments((prev) => prev.map((seg) => (seg.id === id ? { ...seg, text } : seg)));
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
      const result = await api.editText(projectId, {
        imageId: image.id,
        segments: changed.map((seg) => ({
          originalText: seg.originalText,
          text: seg.text,
          context: seg.context,
          manual: Boolean(seg.manual),
          rect: seg.rect || null,
        })),
      });
      onSubmitted(result.taskId);
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
      ) : (
        <FlatList
          data={segments}
          keyExtractor={(item: TextSegment) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={recognizedBy ? <Text style={styles.headerNote}>{recognizedBy}，可直接修改下方文字内容；清空表示删除。</Text> : null}
          ListEmptyComponent={<Text style={styles.empty}>未识别到文字，可在下方手动新增。</Text>}
          renderItem={({ item }: { item: TextSegment }) => (
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
              <Pressable style={styles.deleteBtn} onPress={() => updateSegment(item.id, '')}>
                <Icon name="trash" size={16} color={colors.danger} />
              </Pressable>
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
    list: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
    headerNote: { fontSize: fontSize.sm, color: c.muted, marginBottom: spacing.sm },
    empty: { textAlign: 'center', color: c.muted, paddingVertical: spacing.xl },
    row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.sm, gap: spacing.sm },
    rowText: { flex: 1 },
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
