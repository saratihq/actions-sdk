export { type QrCodeResult, TEXT_TO_QRCODE_TYPE, textToQrcode } from './qrcode';

import { textToQrcode } from './qrcode';

/** Every QR Code action, for catalog builds and registration. */
export const qrcodeActions = [textToQrcode] as const;
