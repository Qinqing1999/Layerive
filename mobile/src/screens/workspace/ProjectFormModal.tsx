import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../theme';
import { fontSize, spacing, radius } from '../../theme';

type Props = {
  visible: boolean;
  title: string;
  /** 初始名称，传入时自动同步到输入框 */
  initialName?: string;
  initialDesc?: string;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (name: string, description: string) => Promise<void> | void;
  onCancel: () => void;
};

/**
 * 项目创建/编辑共用表单弹窗：标题、名称、描述、提交/取消按钮。
 * 内置 KeyboardAvoidingView（iOS padding 行为）防止键盘遮挡输入框。
 */
export function ProjectFormModal({ visible, title, initialName = '', initialDesc = '', submitLabel, busy, onSubmit, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [name, setName] = useState(initialName);
  const [desc, setDesc] = useState(initialDesc);

  // 弹窗每次打开时重置为最新的初始值，避免上一次输入残留
  useEffect(() => {
    if (visible) {
      setName(initialName);
      setDesc(initialDesc);
    }
  }, [visible, initialName, initialDesc]);

  const canSubmit = name.trim().length > 0 && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    await onSubmit(name.trim(), desc.trim());
  }

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>
          <TextInput
            style={styles.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="项目名称"
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <TextInput
            style={[styles.modalInput, styles.modalDesc]}
            value={desc}
            onChangeText={setDesc}
            placeholder="项目描述（可选）"
            placeholderTextColor={colors.muted}
            multiline
            numberOfLines={3}
          />
          <View style={styles.modalActions}>
            <Pressable style={styles.modalCancel} onPress={onCancel}>
              <Text style={styles.modalCancelText}>取消</Text>
            </Pressable>
            <Pressable style={[styles.modalSubmit, !canSubmit && { opacity: 0.5 }]} onPress={handleSubmit} disabled={!canSubmit}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSubmitText}>{submitLabel}</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.card, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: c.border },
    modalTitle: { fontSize: fontSize.lg, fontWeight: '700', color: c.text, marginBottom: spacing.md },
    modalInput: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: c.text, marginBottom: spacing.sm },
    modalDesc: { minHeight: 80, textAlignVertical: 'top' },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
    modalCancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: c.border },
    modalCancelText: { color: c.textSecondary, fontSize: fontSize.md },
    modalSubmit: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: c.accent, minWidth: 72, alignItems: 'center', justifyContent: 'center' },
    modalSubmitText: { color: '#fff', fontSize: fontSize.md, fontWeight: '600' },
  });
