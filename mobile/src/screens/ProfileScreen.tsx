import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';
import type { UserProfile } from '../types';

type Props = {
  username: string;
  userProfile: UserProfile | null;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  /** 观看广告获得免水印次数（App 层负责调 API 并刷新 userProfile） */
  onWatchAd: () => Promise<void>;
  onLogout: () => void;
};

/** 个人中心：账号信息、VIP 状态、免水印配额、看广告得次数、退出登录 */
export function ProfileScreen({ username, userProfile, onBack, onRefresh, onWatchAd, onLogout }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);
  const [refreshing, setRefreshing] = useState(false);
  const [watching, setWatching] = useState(false);

  const isVip = userProfile?.isVip ?? false;
  const isAdmin = userProfile?.role === 'admin';
  const remaining = userProfile?.remainingQuota ?? 0;
  const watermarkOn = userProfile?.watermark?.enabled ?? false;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }, [onRefresh]);

  async function handleWatchAd() {
    if (watching) return;
    setWatching(true);
    try { await onWatchAd(); } finally { setWatching(false); }
  }

  const vipLabel = isVip
    ? userProfile?.vipType === 'permanent'
      ? 'VIP 会员（永久）'
      : userProfile?.vipExpiresAt
        ? `VIP 会员（至 ${userProfile.vipExpiresAt.slice(0, 10)}）`
        : 'VIP 会员'
    : '普通用户';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Icon name="back" size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>个人中心</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.muted} />}
      >
        {/* 用户卡片 */}
        <View style={styles.card}>
          <View style={[styles.avatar, { backgroundColor: isVip ? '#d4a017' : colors.accent }]}>
            <Text style={styles.avatarText}>{(username || 'U').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.username} numberOfLines={1}>{username || '未登录'}</Text>
            <View style={styles.badgeRow}>
              {isAdmin && (
                <View style={[styles.badge, styles.badgeAdmin]}>
                  <Text style={[styles.badgeText, styles.badgeTextAdmin]}>管理员</Text>
                </View>
              )}
              <View style={[styles.badge, isVip && styles.badgeVip]}>
                <Text style={[styles.badgeText, isVip && styles.badgeTextVip]}>{isVip ? 'VIP' : '普通用户'}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 会员状态 */}
        <View style={styles.card}>
          <View style={styles.rowHeader}>
            <Icon name="starFilled" size={16} color={isVip ? '#d4a017' : colors.muted} />
            <Text style={styles.rowTitle}>会员状态</Text>
          </View>
          <Text style={styles.rowValue}>{vipLabel}</Text>
          {!isVip && (
            <Text style={styles.hint}>开通 VIP 可免水印、不限次数保存原图，请联系管理员开通</Text>
          )}
        </View>

        {/* 免水印配额 */}
        <View style={styles.card}>
          <View style={styles.rowHeader}>
            <Icon name="droplet" size={16} color={colors.accent} />
            <Text style={styles.rowTitle}>今日免水印次数</Text>
          </View>
          <Text style={[styles.quotaValue, isVip && { color: colors.text }]}>{isVip ? '不限' : remaining}</Text>
          {!isVip && watermarkOn && (
            <Text style={styles.hint}>保存无水印原图将消耗 1 次机会，每日自动重置</Text>
          )}
          {!isVip && !watermarkOn && (
            <Text style={styles.hint}>水印功能未开启，保存图片不消耗次数</Text>
          )}
          {!isVip && userProfile?.adEnabled && watermarkOn && (
            <Pressable style={[styles.adBtn, watching && { opacity: 0.6 }]} onPress={handleWatchAd}>
              <Icon name="play" size={16} color="#fff" />
              <Text style={styles.adBtnText}>看广告 +{userProfile?.adCredits ?? 1} 次</Text>
            </Pressable>
          )}
          {!isVip && !userProfile?.adEnabled && watermarkOn && (
            <Text style={styles.hint}>看广告获取次数功能未开启</Text>
          )}
        </View>

        {/* 水印设置 */}
        <View style={styles.card}>
          <View style={styles.rowHeader}>
            <Icon name="image" size={16} color={colors.muted} />
            <Text style={styles.rowTitle}>水印设置</Text>
          </View>
          <Text style={styles.rowValue}>{watermarkOn ? '已开启（非会员图片带水印）' : '未开启'}</Text>
          {watermarkOn && userProfile?.watermark?.text ? (
            <Text style={styles.hint}>水印文字：{userProfile.watermark.text}</Text>
          ) : null}
        </View>

        {/* 退出登录 */}
        <Pressable style={styles.logoutBtn} onPress={onLogout}>
          <Icon name="logout" size={18} color={colors.danger} />
          <Text style={[styles.logoutText, { color: colors.danger }]}>退出登录</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border,
    },
    backBtn: { width: 34, alignItems: 'flex-start' },
    title: { fontSize: fontSize.lg, fontWeight: '700', color: c.text },
    body: { padding: spacing.lg, gap: spacing.md },
    card: {
      backgroundColor: c.card, borderRadius: radius.lg, padding: spacing.lg,
      borderWidth: 1, borderColor: c.border, gap: spacing.sm,
    },
    avatar: {
      width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
      marginRight: spacing.md,
    },
    avatarText: { fontSize: fontSize.xxl, fontWeight: '700', color: '#fff' },
    username: { fontSize: fontSize.lg, fontWeight: '700', color: c.text, marginBottom: spacing.xs },
    badgeRow: { flexDirection: 'row', gap: spacing.sm },
    badge: {
      paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill,
      backgroundColor: c.input, borderWidth: 1, borderColor: c.border,
    },
    badgeText: { fontSize: fontSize.xs, color: c.muted },
    badgeAdmin: { backgroundColor: c.accentLight, borderColor: c.accent },
    badgeTextAdmin: { color: c.accent },
    badgeVip: { backgroundColor: 'rgba(212,160,23,0.12)', borderColor: '#d4a017' },
    badgeTextVip: { color: '#d4a017', fontWeight: '700' },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rowTitle: { fontSize: fontSize.sm, color: c.muted },
    rowValue: { fontSize: fontSize.md, color: c.text, fontWeight: '600' },
    quotaValue: { fontSize: fontSize.xxl, fontWeight: '700', color: c.accent },
    hint: { fontSize: fontSize.sm, color: c.muted, lineHeight: 18 },
    adBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
      backgroundColor: c.accent, borderRadius: radius.md, paddingVertical: spacing.md, marginTop: spacing.xs,
    },
    adBtnText: { fontSize: fontSize.md, fontWeight: '600', color: '#fff' },
    logoutBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
      backgroundColor: c.card, borderRadius: radius.lg, paddingVertical: spacing.lg,
      borderWidth: 1, borderColor: c.border, marginTop: spacing.sm,
    },
    logoutText: { fontSize: fontSize.md, fontWeight: '600' },
  });
