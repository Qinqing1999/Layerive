// Trusted built-in operation; cropping runs locally with Sharp, no model call.
import catalog from './catalog.json' with { type: 'json' };
import sharp from 'sharp';
import { pixelRect, validateRect } from '../local-edit.mjs';

const decodeOptions = { limitInputPixels: 40_000_000, failOn: 'error' };

function create(host, input) {
  const { projectId, imageOrThrow, httpError } = host;
  const image = imageOrThrow(projectId, input.imageId);
  let rect;
  try {
    rect = validateRect(input.rect, '裁剪区域');
  } catch (error) {
    throw httpError(400, 'crop.invalidRect', error.message);
  }
  if (rect.width <= 0.5 || rect.height <= 0.5) {
    throw httpError(400, 'crop.invalidRect', '裁剪区域太小，请在图片上框选一个更大的区域');
  }
  return host.generation({
    prompt: `将输入图片裁剪为框选区域（x ${rect.x.toFixed(2)}%，y ${rect.y.toFixed(2)}%，宽 ${rect.width.toFixed(2)}%，高 ${rect.height.toFixed(2)}%），保留选区内的原始像素，不缩放、不重绘。`,
    operation: 'crop_image',
    modelId: input.modelId,
    inputImageId: image.id,
    parentVersionId: input.parentVersionId || image.version_id || null,
    params: { ...(input.params || {}), count: 1, outputFormat: 'png', transparent: false },
  }, { rect, imageId: image.id });
}

// Auto-orient first: an EXIF-rotated phone photo must crop in the orientation
// the user actually sees, so percentage coordinates are resolved against the
// oriented dimensions rather than the raw encoded frame.
async function prepare(host, sourceImage, state) {
  const { providerInputBytes, signal, httpError } = host;
  const bytes = await providerInputBytes(sourceImage);
  const oriented = sharp(bytes, decodeOptions).autoOrient();
  const meta = await oriented.metadata();
  // sharp reports the encoded frame in width/height and the rotated frame in
  // autoOrient; extract() runs on the oriented frame, so prefer autoOrient.
  const width = meta.autoOrient?.width || meta.width;
  const height = meta.autoOrient?.height || meta.height;
  if (!width || !height) {
    throw httpError(422, 'crop.invalidImage', '无法读取原图片尺寸，请换一张图片后重试');
  }
  const crop = pixelRect(state.rect, width, height);
  let output;
  try {
    output = await oriented.extract(crop).png().toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw httpError(422, 'crop.invalidImage', '原图无法解码，请换一张图片后重试');
  }
  signal.throwIfAborted();
  return { image: sourceImage, local: { bytes: output.data, mimeType: 'image/png', width: output.info.width, height: output.info.height } };
}

export default {
  ...catalog.find(plugin => plugin.operation === 'crop_image'),
  create, prepare,
  taskInput: state => ({ stage: 'cutting', crop: { rect: state.rect, imageId: state.imageId } }),
  generationPhase: '本地裁剪并保存选区',
};
