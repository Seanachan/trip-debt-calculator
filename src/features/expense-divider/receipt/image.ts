// Gets a phone photo into a form the model accepts and that is cheap to send:
// JPEG (the API takes no HEIC, which iPhones shoot by default), long edge at
// most MAX_EDGE. Browser only; decoding goes through <img>, which applies the
// EXIF rotation and, on Safari, reads HEIC.

import { ReceiptScanError } from "./errors";

/** Two 768-px tiles across: enough for receipt print, a few hundred tokens per tile. */
const MAX_EDGE = 1536;
const JPEG_QUALITY = 0.85;

export interface PreparedImage {
  /** Base64, without the `data:` prefix. */
  data: string;
  mimeType: "image/jpeg";
}

const UNREADABLE_PHOTO = "這張照片讀不了，換一張或手動填吧。";

export async function prepareImage(file: File): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new ReceiptScanError(UNREADABLE_PHOTO);
    });

    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new ReceiptScanError(UNREADABLE_PHOTO);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) throw new ReceiptScanError(UNREADABLE_PHOTO);
    return { data: await toBase64(blob), mimeType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new ReceiptScanError(UNREADABLE_PHOTO));
    reader.readAsDataURL(blob);
  });
}
