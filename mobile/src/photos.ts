export type PhotoSource = 'library' | 'camera';

/** JPEG already small enough for one share of a phone frame. */
export type Photo = {
  readonly name: string;
  readonly media: 'image/jpeg';
  readonly data: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
};
