/** What kind of viewer a vault file gets, by extension. */
export type MediaKind = 'image' | 'pdf' | 'audio' | 'video' | 'other';

const BY_EXT: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  pdf: 'pdf',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  aac: 'audio',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
};

export function mediaKind(path: string): MediaKind {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return BY_EXT[ext] ?? 'other';
}
