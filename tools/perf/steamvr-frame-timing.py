"""tools/perf/steamvr-frame-timing.py: log SteamVR's own per-frame compositor timing.

The numbers SteamVR's Advanced Frame Timing graph draws, one CSV row per
compositor frame, read through OpenVR's IVRCompositor::GetFrameTimings as a
BACKGROUND application (it never starts SteamVR, takes no scene focus and
draws nothing). Run it beside `pnpm perf:worn-trace` so the Chrome trace,
the game's capture and the compositor's view of the same flight line up
(DEV-993).

    python tools/perf/steamvr-frame-timing.py <out.csv> [seconds]

Needs the `openvr` package (pip) and SteamVR already running.
"""

import csv
import ctypes
import sys
import time

import openvr

FIELDS = [
    'm_nFrameIndex', 'm_nNumFramePresents', 'm_nNumMisPresented', 'm_nNumDroppedFrames',
    'm_nReprojectionFlags', 'm_flSystemTimeInSeconds', 'm_flPreSubmitGpuMs',
    'm_flPostSubmitGpuMs', 'm_flTotalRenderGpuMs', 'm_flCompositorRenderGpuMs',
    'm_flCompositorRenderCpuMs', 'm_flCompositorIdleCpuMs', 'm_flClientFrameIntervalMs',
    'm_flPresentCallCpuMs', 'm_flWaitForPresentCpuMs', 'm_flSubmitFrameMs',
    'm_flWaitGetPosesCalledMs', 'm_flNewPosesReadyMs', 'm_flNewFrameReadyMs',
    'm_flCompositorUpdateStartMs', 'm_flCompositorUpdateEndMs', 'm_flCompositorRenderStartMs',
    'm_nNumVSyncsReadyForUse', 'm_nNumVSyncsToFirstView', 'm_flTransferLatencyMs',
    'm_flMegaPixelsPerSecond', 'm_flHmdRecommendedMegaPixelsPerSecond',
]


def main() -> int:
    out = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 240.0
    openvr.init(openvr.VRApplication_Background)
    fields = [k for k in FIELDS if hasattr(openvr.Compositor_FrameTiming, k)]
    comp = openvr.VRCompositor()
    batch = (openvr.Compositor_FrameTiming * 128)()
    batch[0].m_nSize = ctypes.sizeof(openvr.Compositor_FrameTiming)
    last = -1
    rows = 0
    end = time.time() + seconds
    with open(out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['wall_unix'] + fields)
        print(f'logging SteamVR frame timing to {out} for {seconds:.0f} s', flush=True)
        while time.time() < end:
            batch[0].m_nSize = ctypes.sizeof(openvr.Compositor_FrameTiming)
            n, _ = comp.getFrameTimings(batch)
            now = time.time()
            for i in range(n):
                t = batch[i]
                if t.m_nFrameIndex <= last:
                    continue
                last = t.m_nFrameIndex
                w.writerow([f'{now:.3f}'] + [getattr(t, k) for k in fields])
                rows += 1
            f.flush()
            time.sleep(0.25)
    openvr.shutdown()
    print(f'{rows} frames written', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
