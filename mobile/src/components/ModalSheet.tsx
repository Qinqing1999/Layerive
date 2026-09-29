import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { fontSize, spacing } from '../theme';
import { Icon } from './Icon';

type Props = {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

/** Themed full-screen sheet with a title bar, close button and optional footer. */
export function ModalSheet({ visible, title, onClose, children, footer }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
            <Icon name="close" size={20} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.body}>{children}</View>
        {footer ? <View style={[styles.footer, { paddingBottom: (insets.bottom || 0) + spacing.md }]}>{footer}</View> : null}
      </View>
    </Modal>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.card },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm,
      backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    title: { flex: 1, fontSize: fontSize.lg, fontWeight: '700', color: c.text },
    closeBtn: { padding: spacing.xs },
    body: { flex: 1 },
    footer: {
      padding: spacing.md,
      backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border,
    },
  });
