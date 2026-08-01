import { toBuffer } from 'qrcode';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { dropdown, type FileInput, longText, number } from '../../core/props';

/** QR Code utility — a no-auth action backed by `qrcode` (MIT). */

type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export const TEXT_TO_QRCODE_TYPE = 'qrcode.text_to_qrcode';
export interface QrCodeResult {
  file: FileInput;
  name: string;
  mimetype: string;
  size: number;
}

export const textToQrcode = defineAction({
  type: TEXT_TO_QRCODE_TYPE,
  name: 'Text to QR Code',
  description: 'Encode text into a QR code PNG image.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Content', required: true }),
    errorCorrectionLevel: dropdown<ErrorCorrectionLevel, false>({
      label: 'Error Correction Level',
      required: false,
      defaultValue: 'M',
      options: [
        { label: 'Low (~7%)', value: 'L' },
        { label: 'Medium (~15%)', value: 'M' },
        { label: 'Quartile (~25%)', value: 'Q' },
        { label: 'High (~30%)', value: 'H' },
      ],
    }),
    margin: number({ label: 'Quiet-zone margin (modules)', required: false, defaultValue: 4 }),
  },
  run: async ({ props }): Promise<QrCodeResult> => {
    if (props.text.length === 0) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'Content must not be empty.',
        retryable: false,
      });
    }
    const data = await toBuffer(props.text, {
      errorCorrectionLevel: props.errorCorrectionLevel ?? 'M',
      margin: props.margin ?? 4,
    });
    const name = 'qr-code.png';
    return {
      file: { filename: name, data, mimeType: 'image/png' },
      name,
      mimetype: 'image/png',
      size: data.byteLength,
    };
  },
});
