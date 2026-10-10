// src/boot/app/head-scratch.ts: the HEAD's three volatile scratch objects, shared
// by the frame and by the menus' aim (`boot/app/hangar/menus.ts`). APP-SPLIT phase 4.
//
// Moved verbatim from the tail of `boot/app.ts`, docs and all. There is ONE of
// each, as there was: trap 19 is about a scratch SHARED across instances, and
// these are filled and spent inside one synchronous call by whichever reader
// runs, exactly as before the move.

import * as THREE from 'three'

/** Volatile. The HEAD's world position, refreshed once per frame. */
export const cameraWorld = new THREE.Vector3()

/**
 * Volatile. The HEAD's world facing, for the two gaze rays that need one.
 *
 * Written only on the frames the holotables or the pause plate are up — the
 * rest of the frame wants the eye POINT and takes it through
 * `readHeadPosition`, so this one is not refreshed where nothing reads it.
 *
 * *The head's*, not the camera's, and DEV-199 is the whole of the difference:
 * every branch that places the eye sets the camera's LOCAL pose to identity so
 * that the rig can carry it, which in a session throws away the pose the
 * runtime wrote there — so `camera.getWorldQuaternion()` returns the rig's aim
 * and a gaze built from it never moves when you turn your head.
 * `render/head-pose.ts` is the one place that knows the difference.
 */
export const _headQuat = new THREE.Quaternion()

/**
 * Volatile. Where the HEAD is LOOKING, in world space — the gaze ray.
 *
 * Refreshed only on the frames the holotables or the pause plate are up, which
 * are the only things that read it. Valid inside one synchronous call, like
 * every other scratch here — and built with `headForward(_headQuat, ...)`
 * rather than `camera.getWorldDirection()`, which is DEV-199's whole subject.
 */
export const gazeDirection = new THREE.Vector3()
