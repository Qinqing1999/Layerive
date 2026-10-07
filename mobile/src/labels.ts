/** 操作类型中文标签 */
export const OPERATION_LABELS: Record<string, string> = {
  upload: '上传',
  text_to_image: '文生图',
  edit_prompt: '改图',
  edit_text: '改字',
  local_edit: '局部编辑',
  outpaint: '扩图',
  enhance: '变清晰',
  remove_watermark: '去水印',
  extract_asset: '提取素材',
  batch_edit: '批量改图',
  batch_generate: '批量文生图',
};

/** 任务状态中文标签 */
export const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  generating: '生成中',
  success: '完成',
  partial: '部分完成',
  failed: '失败',
  canceled: '已取消',
};

/** 任务阶段中文标签 */
export const STAGE_LABELS: Record<string, string> = {
  planning: '多图意图判断',
  retrying: '正在重试',
  compositing: '合成参考素材',
  generating: '生成图片',
  preserving: '框外还原',
};

/** 批量任务状态中文标签（含生成中场景的精简文案） */
export const BATCH_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  generating: '进行中',
  success: '已完成',
  partial: '部分完成',
  failed: '失败',
  canceled: '已取消',
};

/** 时间格式化：相对时间（"刚刚"、"5 分钟前"、"昨天"、"3 天前"） */
export function formatRelativeTime(value: string | number): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  // 超过 7 天用日期格式
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
}

/** 时间格式化：月/日 时:分 */
export function formatDateTime(value: string | number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/** 任务时间格式化：HH:mm */
export function formatTaskTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** WorkspaceScreen 任务面板操作标签（生成任务视角） */
export const TASK_OPERATION_LABELS: Record<string, string> = {
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
