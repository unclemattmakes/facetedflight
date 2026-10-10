// Type declarations for unity-light.mjs (DEV-454). Same convention as
// `tools/perf/png-diff.d.mts`: the tool stays plain JavaScript and the test
// side gets real types.

/** Unity's `GammaToLinearSpace` for one channel. */
export declare const unityGammaToLinear: (v: number) => number

/** `GammaToLinearSpace(m_Color x intensity) / intensity`, rounded to six places. */
export declare const unity54LightLinear: (
  color: { readonly r: number; readonly g: number; readonly b: number },
  intensity: number,
) => [number, number, number]
