# Porting notes

Traps we hit while bringing a 2016 Unity game to three.js and WebXR, written down for anyone doing
something similar. Most of them are not specific to this game. Each one cost real time, because
in most cases the failure looked like something else: a missing feature, a rendering bug, a
network problem.

## Reading data out of a Unity project

**A public field's initializer is not shipped behavior.** The number in the C# source (`public
float resetDelay = 10`) is only what the field gets when a component is created in code. A
shipped game takes the value from the serialized component on the prefab it instantiates, with the
scene's per-instance overrides on top. The chain to trace is scene, then the prefab the scene
instantiates (follow the prefab's GUID), then the value on that prefab, then the scene's
modifications. A field that is private and not serialized can only come from the source, and
should be tagged as such. In this project one boundary-reset delay is 13 in all thirteen
missions while the source says 10, and the distance within which props stay live was more than four
times the source's value.

**There are two YAML dialects, and the old one reads as absence.** A parser that handles one
returns nothing for the other, which looks exactly like a scene that contains nothing. We hit it
twice in one sitting: an object's components listed as `- 4: {fileID: N}` (the class number is
the key) as well as `- component: {...}`, and a material's colors written as `data: first/second`
with no leading dash as well as `- first: ... second: ...`. If a Unity asset seems to be missing
something structural, check the dialect before believing it.

**A prefab placed in a scene is invisible to a name search.** Unity writes it as a prefab-instance
block plus a stripped transform. The GameObject names and colliders live in the `.prefab` file,
not in the scene, so grepping the scene for a name finds nothing and a sweep of every collider in
the scene finds nothing. The gate that ends a run was missing from our first extraction for this
reason. When something ought to exist and does not appear, inventory the prefab instances by their
source GUID before concluding it is absent.

**"Enabled" is not "live."** To count what a player can actually reach (rings, colliders,
boundaries), walk the whole parent chain and require every ancestor to be active as well as the
component to be enabled. Without that walk one mission reported 77 rings instead of 21, and a
"boundary enabled" flag on a deactivated object produced an out-of-bounds rule that never ran.

**A trigger fires on an edge.** A Unity trigger's exit callback runs only for a collider that was
inside. A port that asks "is the ship outside the boundary right now?" agrees with Unity
everywhere except where it matters: a ship that respawns outside the sphere never fires an exit,
so Unity never starts the countdown, while the level test restarts it forever. Model the event,
not the state.

**Some prefabs are decoys.** Two prefabs for the same ship had identical physics but opposite
values for one flag, and one was used by scenes that were not part of the shipped game. Find the
prefab the shipped scene actually instantiates, by following the reference, and never read a
constant from the look-alike.

**Fields that nobody reads exist.** Some serialized values are tuned, shipped and dead; others are
stale keys for fields that no longer exist. Check that the shipped code reads a field before
building behavior on it.

**A generator component is not a generated forest.** A scatter component's job is to produce
objects, in the editor, and the result is serialized on the component. An empty list is a pass
nobody ran, and a disabled component is a pass switched off. We drew five scatter passes across
four environments on the strength of components that had parameters, when two of the environments
had never scattered anything. When a component's job is to produce objects, count the objects.

**Unity addresses textures differently from the PNG on disk.** `GetPixelBilinear` reads the
imported texture, not the file. A 1025-pixel map is rescaled to 1024 at import when the texture is
not power-of-two, and texels are addressed as `u * width`, not `u * (width - 1)`. Together those
moved terrain height by up to 30 meters. Go through an import step that reproduces both.

**A terrain's transform is a corner, and the missing offset is a parent.** The terrain generator
places vertices from zero at the object's transform; the 2048 m offset that looks like a centering
convention on one island is a plain parent object. A different island has no such parent and a
third has one. No single offset rule works; compose the parent chain.

**Check a rule where its alternatives disagree.** Two of our early rules were checked, true
everywhere anyone looked, and wrong, because the case where the right and wrong explanation give
different answers was never loaded. If every environment agrees with your rule, find the one where
it would differ. And when you fix one instance, re-derive all of them.

**Unity's rotation order is `YXZ`.** A three.js `Euler` set to `'YXZ'` reproduces Unity's
`eulerAngles`. Using the wrong order is invisible in any test that rotates around one axis at a
time, and shows up as a lean around the wrong pivot.

**World gravity was not 9.81.** It was -32, and every mass, drag and thrust in the game was tuned
against it. One vehicle flies with gravity switched off by a launch script; a body that has not
launched falls.

## Geometry and assets

**Units: centimeters versus meters.** An FBX exports at 0.01 scale. Bake the unit scale in at
conversion time.

**A converted mesh can be mirrored and nobody notices.** Every mesh out of our first converter
came out mirrored in X, and therefore inside-out, because a mirror reverses winding. Three assets
carried the bug unnoticed because a cockpit and a hexagonal gate are both left-right symmetric.
What caught it was an arrow whose prefab surrounded it with Unity-native geometry (built-in cubes,
no importer): its arm ends missed their end caps by 4.8 m instead of 0.6 m. **When you add an
asymmetric mesh, find something in its own prefab to measure it against.** And test the geometry,
not the rotation: a distance or an aspect ratio is true independent of what you believed, while a
quaternion assertion is your belief written twice.

**Handedness bugs are a class.** The mirror above, a ship's yaw, every gate's 90-degree roll and
every ghost's yaw were four separate orientation bugs in this project, hidden by symmetric geometry
and by pairs of errors that compose into something that looks right. Where the question is
"which way does this face," render it from six angles and look.

**`lookAt` aims +z; a mesh that came through a Unity import points -z.** The Z flip is a
conjugation, so an object that was forward in Unity arrives facing the other way. Aim one with
`lookAt` and it flies backward. Both conventions are live in the same renderer and both are
correct; the tell is where the mesh came from.

**`Color32` alpha decodes to 1/255.** A vertex-colored mesh then renders almost fully transparent
in any glTF consumer that honors the alpha of `COLOR_0`. Force alpha to 1 on export or emit three
components.

**Port what a generator does to the attributes, not only the vertices.** The terrain generator
stamps each edge skirt with the normal of the interior triangle beside it. We shipped the skirt
geometry without that and every position-based test passed, because the positions are identical
either way. The symptom was a pale dashed line along every seam, mistaken for a fog artifact.

**The collision surface is not what you see.** A height field built for collision differs from the
rendered, jittered, 8 m facet mesh by far more than the jitter: bilinear sampling of a 4 m map
against an 8 m triangulation of it gives errors up to 20 meters on steep terrain. A spot check on
flat ground cannot see this. Sample steep.

**Own the generator when you cannot ship the output.** The original's baked terrain was gigabytes
of Unity binary, unshippable, so the generator is reimplemented. It must reproduce the original's
bugs, including a quad-diagonal choice that reads the wrong component, because they are in the
silhouette. The reference data is kept for diffing: sweep every chunk against it rather than
sampling a convenient one. A chunk that matched to 4 mm hid two real bugs because it sat on open
sea.

## three.js and WebXR

**`WebGLRenderer`, not WebGPU, and `renderer.setAnimationLoop`.** The headset drives the frames
inside a session.

**A camera's `position` is local.** In a cockpit the camera is a child of the XR rig, so
`camera.position` is the head pose inside the rig, not the world position. Anything compared with
world space needs `getWorldPosition()`. A fog calculation that read the local one while the shader
used the world one drew a pink line of full fog at exactly eye level.

**`grip.matrixWorld` is stale inside the XR frame callback.** three.js updates the local pose from
the XR data but does not recompute the world matrix until the next render. Call
`updateWorldMatrix(true, false)` first.

**XR velocities are in reference space.** Throw or impulse velocities from an input source must be
rotated by the rig's orientation before use.

**Layers 1 and 2 are the left and right eyes.** The XR manager builds the eye cameras by masking
off layer 1 and layer 2, so an object on either layer is absent from the other eye, not dim.
Our entire readable UI shipped monocular for a time and survived every test, because every test
rendered through one camera. A monocular bug cannot exist in a monocular harness. Use layers 3
and above. Note also that a raycaster tests layer 0 only, so anything you moved to another layer
can draw and be undetectable to a ray.

**A light's layers decide whether the camera collects it at all.** Three gathers lights only
inside the layer test for the camera, so a light restricted to a layer the camera does not
enable is absent, not dim. It looks identical at 3x and 60x intensity.

**The program cache key holds less than you assume.** It is built from the shader id, the names
in `material.defines` (in insertion order), numeric and boolean parameters, the output color
space, light counts and `customProgramCacheKey()`. It does not include `onBeforeCompile`. Two
materials that differ only in their patch share one program, and whichever compiled first wins.
Consequences, each of which shipped as a bug:

- Install every shader patch through a helper that requires a cache tag and chains the previous
  hook. Never assign `onBeforeCompile` directly.
- The defines are walked in insertion order, so `{A, B}` and `{B, A}` are two programs for one
  shader. Delete-then-re-add moves a key to the end and makes the key a function of the run's
  history. One variant compiled a shader mid-flight for 318 ms that way. Assign in place.
- `Material.copy` carries `side` and plain fields but resets `defines` and carries neither hook.
  A clone that delegates `onBeforeCompile` back to its base covers the function and not the
  field, so `material.fog` diverged and two textually identical shaders compiled twice.
- A light count is in the key. Anything that hides a light recompiles every lit material in the
  frame; one keypress cost 15 programs until lamps stopped leaving the scene.
- Do not sort the defines to decide whether two materials match. It reports "same" for materials
  that compile separately.

**A vertex shader and a fragment shader are two symbol tables.** A uniform declared in the
fragment prelude and used in the vertex shader links to nothing, and `VALIDATE_STATUS` is false.
Typecheck, lint, tests and build all pass. See the link check in
[running-and-testing.md](running-and-testing.md).

**Desktop Chrome honors neither `requestViewportScale` nor `setFoveation`.** The OpenXR backend
never opts into the first and never forwards the second, so in a session the only resolution lever
is the framebuffer scale at session start. `setPixelRatio` is flat-screen only.

**`isSessionSupported('immersive-vr')` can start the machine's OpenXR runtime.** On a machine
where that is a full VR platform, every page load launches it. Offer a way to skip the probe.

**XR controllers are invisible to `navigator.getGamepads()` until a session starts.** They arrive
as `XRInputSource.gamepad` with the `xr-standard` mapping once the session is running, so a
pre-session gamepad check cannot decide whether a headset has thumbsticks.

**Avoid `SharedArrayBuffer`.** It needs cross-origin isolation headers, which constrain every
embed and asset. Workers here use transferable `ArrayBuffer`s.

**`dom-overlay` is not reliably granted** by headset browsers. Do not depend on it.

## Testing traps

**A test that compares two of your own devices has tested neither.** "VR and flat input agree" stays
green when both are wrong. The keyboard and the menu had each been compared to nothing: W climbed
while the stick dived, and pulling a stick back moved a menu selection up, for the life of the
port. Compare against something outside the code: the data, the original's source, or a
measurement.

**A test that re-derives its expectation the way the code does has not tested the code.**
Assert the relationship (a path is a prefix of another) rather than the value.

**A generated number nobody reads is documentation.** A constant that said "control scheme a"
sat on the sheet while the code implemented a layout that was no scheme at all. Import the key and
assert against it.

**Derived numbers need the same provenance as extracted ones.** "The gates sit up to 24.6 m off
the racing line" was the distance to the nearest vertex of a coarse polyline, not to the line. The
true figure was 0.4 m, and a tuning constant built on the wrong one cost seven seconds a lap.
Say what a number is the distance of, and check the units and the frame.

**A shared scratch object is a bug waiting for a second instance.** One input struct shared by
every AI racer was only partly rewritten on one branch, so a finished racer flew on with the other
racer's frozen stick. No single-object test can see it. The guard is: step a second one and assert
the first did not move.

**A guard that classifies text is answered by prose about it.** Source-scanning tests match
substrings, so a comment explaining a rule can change the verdict on the file it sits in. Describe
the marker rather than spelling it, and run the guard after writing the comment.

**A skipped test looks like a pass in a summary.** Read the skip's reason. A test that retries
until it lands on a stored tick and then skips had skipped every time for days, with the reason
printed on the line above.

**`describe.skipIf` skips the tests, not the describe body.** Disk work placed above the guard
runs during collection and throws where the files are absent, which is exactly the machine the
guard was for.

**Do not make the harness take a different code path.** A `?pointerlock=0` switch so the suite
stops fighting the browser, or a mock so a slow thing is fast, produces a suite that proves
something about a build nobody plays. A spec may do what a player does (press Escape to release
the pointer). It may not add a branch to the game. We shipped a pink sky and no assets to the one
path a human takes because the test config quietly set an environment variable the dev server did
not have.
