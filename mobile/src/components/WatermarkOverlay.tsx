import React, { useMemo } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import type { WatermarkConfig } from '../types';

type Props = {
  config: WatermarkConfig;
  /** 覆盖区域尺寸（从父容器 onLayout 获取），默认铺满 */
  width?: number;
  height?: number;
};

/**
 * 平铺文字水印层：非 VIP 用户查看图片时叠加在上方。
 * pointerEvents="none" 确保不拦截触摸事件。
 * 水印文字按 spacing 参数平铺，带旋转和透明度。
 */
export function WatermarkOverlay({ config, width = 400, height = 400 }: Props) {
  // 根据间距计算行列数，覆盖整个区域（多出一些确保无死角）
  const cols = Math.ceil(width / config.spacing) + 2;
  const rows = Math.ceil(height / config.spacing) + 2;

  const items = useMemo(() => {
    const arr: React.ReactNode[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // 交错排列，更像专业水印
        const offsetX = (r % 2) * (config.spacing / 2);
        arr.push(
          <Text
            key={`${r}-${c}`}
            style={{
              position: 'absolute',
              left: c * config.spacing + offsetX,
              top: r * config.spacing,
              fontSize: config.fontSize,
              color: config.color,
              opacity: config.opacity,
              transform: [{ rotate: `${config.rotation}deg` }],
            }}
          >
            {config.text}
          </Text>
        );
      }
    }
    return arr;
  }, [cols, rows, config.spacing, config.fontSize, config.color, config.opacity, config.rotation, config.text]);

  if (!config.enabled) return null;

  return (
    <View style={styles.overlay} pointerEvents="none">
      {items}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
});
