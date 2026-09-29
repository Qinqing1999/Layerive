import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, getServerBase, setAuthToken, setServerBase } from '../api';
import { useTheme } from '../theme';
import { fontSize, radius, spacing } from '../theme';

type Props = {
  onSuccess: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

export function LoginScreen({ onSuccess, notify }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerBase());
  const [showServer, setShowServer] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (loading || !password) return;
    setLoading(true);
    try {
      const trimmed = server.trim();
      if (trimmed && trimmed !== getServerBase()) await setServerBase(trimmed);
      const result = await api.login(username, password);
      await setAuthToken(result.token);
      onSuccess();
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.card}>
        <View style={styles.brand}>
          <View style={styles.logo}><Text style={styles.logoText}>P</Text></View>
          <Text style={styles.title}>像素变换</Text>
          <Text style={styles.subtitle}>AI 图片创作工作台</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>用户名</Text>
          <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="用户名" placeholderTextColor={colors.muted} editable={!loading} autoCapitalize="none" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>密码</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="请输入密码" placeholderTextColor={colors.muted} secureTextEntry editable={!loading} />
        </View>

        <View style={styles.field}>
          <Pressable onPress={() => setShowServer((v) => !v)}>
            <Text style={styles.toggleServer}>{showServer ? '收起服务器设置' : '连接其他服务器（真机访问电脑）'}</Text>
          </Pressable>
          {showServer && (
            <TextInput
              style={styles.input}
              value={server}
              onChangeText={setServer}
              placeholder="http://192.168.x.x:8788"
              placeholderTextColor={colors.muted}
              editable={!loading}
              autoCapitalize="none"
              keyboardType="url"
            />
          )}
          {showServer ? <Text style={styles.hint}>电脑端需以 PIXELFLOW_API_HOST=0.0.0.0 npm start 启动，并使用电脑的局域网 IP。</Text> : null}
        </View>

        <Pressable style={[styles.button, (loading || !password) && { opacity: 0.5 }]} onPress={submit} disabled={loading || !password}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{loading ? '登录中…' : '登录'}</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (c: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    card: { width: '100%', maxWidth: 360, backgroundColor: c.card, borderRadius: radius.lg, padding: spacing.xl, elevation: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.1, shadowRadius: 20 },
    brand: { alignItems: 'center', marginBottom: spacing.xl },
    logo: { width: 52, height: 52, borderRadius: 14, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
    logoText: { color: '#fff', fontSize: fontSize.xl, fontWeight: '800' },
    title: { fontSize: fontSize.xl, fontWeight: '800', color: c.text, marginBottom: spacing.xs },
    subtitle: { fontSize: fontSize.sm, color: c.muted },
    field: { marginBottom: spacing.md },
    label: { fontSize: fontSize.sm, fontWeight: '600', color: c.text, marginBottom: spacing.xs },
    input: { height: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, fontSize: fontSize.md, color: c.text, backgroundColor: c.input, marginTop: spacing.xs },
    toggleServer: { fontSize: fontSize.xs, color: c.accent, fontWeight: '600' },
    hint: { fontSize: 10, color: c.muted, marginTop: spacing.xs },
    button: { height: 46, borderRadius: radius.sm, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
    buttonText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
  });
