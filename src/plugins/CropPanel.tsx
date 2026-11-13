import { Icon } from '../Icon';
import { useLanguage } from '../i18n';

// 裁剪：纯本地像素操作。进入模式后在画布上框选区域，面板里确认后
// 由服务端插件直接用 Sharp 裁下选区，不调用任何图片或视觉模型。
export function CropPanel({ cropRect, cropSubmitting, generating, closeCrop, submitCrop }: {
  cropRect: { x: number; y: number; width: number; height: number } | null;
  cropSubmitting: boolean;
  generating: boolean;
  closeCrop: () => void;
  submitCrop: () => Promise<void>;
}) {
  const { t } = useLanguage();
  return (<section className="crop-panel">
    <div className="crop-panel-head"><div><strong>{t('ws.crop')}</strong><span>{cropRect
      ? t('ws.cropRectSummary', { x: cropRect.x.toFixed(1), y: cropRect.y.toFixed(1), width: cropRect.width.toFixed(1), height: cropRect.height.toFixed(1) })
      : t('ws.cropHint')}</span></div><button className="crop-exit" onClick={closeCrop}><Icon name="close" size={13} /> {t('common.exit')}</button></div>
    <div className="canvas-tool-body">
      <p className="crop-summary">{t('ws.cropSummary')}</p>
    </div>
    <div className="crop-panel-actions"><button className="button secondary" onClick={closeCrop} disabled={cropSubmitting || generating}>{t('common.cancel')}</button><button className="button primary" disabled={!cropRect || cropRect.width < 1 || cropRect.height < 1 || cropSubmitting || generating} onClick={() => void submitCrop()}>{cropSubmitting ? t('ws.cropSubmitting') : t('ws.confirmCrop')}</button></div>
  </section>);
}
