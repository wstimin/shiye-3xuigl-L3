export type QrEncoder = (text: string, options: { width: number; margin: number }) => Promise<string>;

export function createNodeQrImage(link: string, encode: QrEncoder) {
  return encode(link, { width: 260, margin: 1 });
}
