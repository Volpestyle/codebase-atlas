import { renderSVG } from "uqr";

export function pairingQrSvg(value: string): string {
  return renderSVG(value, {
    border: 2,
    pixelSize: 8,
    blackColor: "#0a0a0a",
    whiteColor: "#ffffff",
  });
}
