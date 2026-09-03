const ESCAPE = 0x1b;
const CSI_INTRODUCER = 0x5b; // [
const ZERO = 0x30;
const DEVICE_ATTRIBUTES_FINAL = 0x63; // c

// Tessera implements a modern terminal, but its browser renderer does not
// implement every facility associated with the historical VT100 Advanced
// Video Option (notably blinking text). Advertise the conservative VT100-family
// identity with no optional hardware capabilities instead.
export const primaryDeviceAttributesResponse = "\x1b[?1;0c";

// ghostty-web 0.4.0 handles status and cursor-position reports, but its bundled
// parser does not answer Primary Device Attributes. Keep this recognizer beside
// the Ghostty adapter so output still passes to Ghostty byte-for-byte while the
// missing response is emitted through the terminal's normal input channel.
export class PrimaryDeviceAttributesQueryParser {
  constructor() {
    this.state = "text";
  }

  write(data) {
    if (!data || data.length === 0) {
      return [];
    }

    const binary = data instanceof Uint8Array;
    const completionOffsets = [];
    for (let index = 0; index < data.length; index += 1) {
      const code = binary ? data[index] : data.charCodeAt(index);

      if (this.state === "text") {
        if (code === ESCAPE) {
          this.state = "escape";
        }
        continue;
      }

      if (this.state === "escape") {
        if (code === CSI_INTRODUCER) {
          this.state = "csi";
        } else if (code !== ESCAPE) {
          this.state = "text";
        }
        continue;
      }

      if (this.state === "csi") {
        if (code === DEVICE_ATTRIBUTES_FINAL) {
          completionOffsets.push(index + 1);
          this.state = "text";
        } else if (code === ZERO) {
          this.state = "csiZero";
        } else if (code === ESCAPE) {
          this.state = "escape";
        } else {
          this.state = "text";
        }
        continue;
      }

      if (code === DEVICE_ATTRIBUTES_FINAL) {
        completionOffsets.push(index + 1);
        this.state = "text";
      } else if (code === ESCAPE) {
        this.state = "escape";
      } else {
        this.state = "text";
      }
    }
    return completionOffsets;
  }

  reset() {
    this.state = "text";
  }
}
