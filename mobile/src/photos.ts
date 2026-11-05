import { ImageManipulator, SaveFormat, type ImageManipulatorContext } from 'expo-image-manipulator';
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  type ImagePickerAsset,
  type ImagePickerResult,
} from 'expo-image-picker';
import { MAX_FRAME_BYTES, MAX_PHOTOS } from '../../src/shared/phone-wire.js';

export type PhotoSource = 'library' | 'camera';

export type Photo = {
  readonly name: string;
  readonly media: 'image/jpeg';
  readonly data: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
};

export type PhotoPick =
  | { readonly kind: 'picked'; readonly photos: readonly Photo[]; readonly dropped: number }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'denied' };

const EDGES = [1568, 1280, 1024, 768] as const;
const QUALITY = [0.8, 0.65, 0.5] as const;
const TEXT_JSON_RESERVE = 100_000;
const PHOTO_CHARS = Math.floor((MAX_FRAME_BYTES - TEXT_JSON_RESERVE) / MAX_PHOTOS);

function photoName(fileName: string | null | undefined): string {
  return fileName && fileName !== '' ? fileName : 'photo.jpg';
}

function edgesToTry(width: number, height: number): readonly number[] {
  const own = Math.max(width, height);
  if (!(own > 0)) return EDGES;
  const edges: number[] = [];
  if (own < EDGES[0]) edges.push(own);
  for (const edge of EDGES) {
    if (edge > own || edges.includes(edge)) continue;
    edges.push(edge);
  }
  return edges;
}

function longEdgeSize(width: number, height: number, edge: number): { width?: number; height?: number } {
  if (width >= height) return { width: edge };
  return { height: edge };
}

async function renderJpeg(
  context: ImageManipulatorContext,
  width: number,
  height: number,
  edge: number,
  quality: number,
  reset: boolean,
): Promise<Omit<Photo, 'name'> | null> {
  if (reset) context.reset();
  context.resize(longEdgeSize(width, height, edge));
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({
      base64: true,
      compress: quality,
      format: SaveFormat.JPEG,
    });
    const data = saved.base64 ?? '';
    if (data === '' || data.length > PHOTO_CHARS) return null;
    return {
      media: 'image/jpeg',
      data,
      uri: saved.uri,
      width: saved.width,
      height: saved.height,
    };
  } finally {
    image.release();
  }
}

async function fitPhoto(asset: ImagePickerAsset): Promise<Photo | null> {
  const name = photoName(asset.fileName);
  for (const edge of edgesToTry(asset.width, asset.height)) {
    let context: ImageManipulatorContext;
    try {
      context = ImageManipulator.manipulate(asset.uri, { maxWidth: edge, maxHeight: edge });
    } catch {
      return null;
    }
    try {
      let attempt = 0;
      for (const quality of QUALITY) {
        let fitted: Omit<Photo, 'name'> | null;
        try {
          fitted = await renderJpeg(context, asset.width, asset.height, edge, quality, attempt > 0);
        } catch {
          return null;
        }
        attempt += 1;
        if (fitted) return { ...fitted, name };
      }
    } finally {
      context.release();
    }
  }
  return null;
}

async function collect(result: ImagePickerResult): Promise<PhotoPick> {
  if (result.canceled) return { kind: 'cancelled' };
  const photos: Photo[] = [];
  let dropped = 0;
  for (const asset of result.assets) {
    const photo = await fitPhoto(asset);
    if (photo) photos.push(photo);
    else dropped += 1;
  }
  return { kind: 'picked', photos, dropped };
}

export async function takePhotos(source: PhotoSource, room: number): Promise<PhotoPick> {
  if (room < 1) return { kind: 'picked', photos: [], dropped: 0 };
  switch (source) {
    case 'camera': {
      const permission = await requestCameraPermissionsAsync();
      if (!permission.granted) return { kind: 'denied' };
      return collect(await launchCameraAsync({ mediaTypes: ['images'] }));
    }
    case 'library':
      return collect(await launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: room > 1,
        selectionLimit: room,
      }));
    default: {
      const _never: never = source;
      return _never;
    }
  }
}
