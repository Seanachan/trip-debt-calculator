/** A scan that did not work. `message` is shown to the person as is, in 繁中. */
export class ReceiptScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptScanError";
  }
}
