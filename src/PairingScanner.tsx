import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

function PairingScanner({
  open,
  onClose,
  onDetect,
}: {
  open: boolean;
  onClose: () => void;
  onDetect: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const video = videoRef.current;
    if (!video) return;
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (stopped) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play();
      } catch {
        if (!stopped) {
          setError("Camera is unavailable. Use the iOS Camera app to scan the code on the computer.");
        }
        return;
      }

      const tick = () => {
        if (stopped || !context) return;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(pixels.data, pixels.width, pixels.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) {
            onDetectRef.current(code.data);
            return;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      video.srcObject = null;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="pairing-scanner" role="dialog" aria-label="Scan pairing code">
      <video ref={videoRef} muted playsInline autoPlay />
      <div className="pairing-scanner-frame" aria-hidden="true" />
      <p>{error ?? "Point at the QR code on the computer"}</p>
      <button type="button" className="btn-ink" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

export default PairingScanner;
