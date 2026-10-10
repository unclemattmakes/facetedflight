"""Where the 2016 Unity project is, asked once -- the Python half.

`tools/legacy-root.mjs` is the same contract for everything that runs under
Node. Two of this repo's tools are Python and cannot import it:

  * `tools/assets/convert-fbx.py` runs inside **Blender's** interpreter, which
    has no Node and no npm.
  * `tools/terrain/unity_mesh.py` reads the 7.15 GB baked-terrain oracle with
    UnityPy, which is a Python library.

There is NO DEFAULT path (public-repo plan step 3): ``FF2_LEGACY`` is read from
the process environment, or failing that from the gitignored ``.env`` beside
``package.json`` (documented in ``.env.example``). Unset, ``legacy_root()``
raises with a message that says what to set; ``legacy_available()`` is the form
that does not raise. `tests/unit/legacy-root.test.ts` keeps both languages to
the same contract.

**STRICTLY READ-ONLY.** CI asserts no file under this root has an mtime newer
than the run. Nothing in this repository may write there: not a temp file, not
a `.meta`, not a Blender autosave. `convert-fbx.py` reads FBX from here and
writes glTF only to its `--out`.
"""

from __future__ import annotations

import os
import re

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEGACY_UNSET_MESSAGE = (
    "FF2_LEGACY is not set. Set it to the 2016 Unity project (the folder that "
    "contains Assets/); extraction needs the original game's project, which is "
    "not distributed. Put FF2_LEGACY=<path> in the gitignored .env beside "
    "package.json (see .env.example) or export it in your shell."
)


class LegacyRootUnsetError(RuntimeError):
    """FF2_LEGACY is neither in the environment nor in .env."""


def _env_value(name: str) -> str | None:
    """``name`` from the environment, else from ``.env`` at the repo root."""
    from_shell = os.environ.get(name, "").strip()
    if from_shell:
        return from_shell
    try:
        with open(os.path.join(_REPO, ".env"), encoding="utf-8-sig") as f:
            text = f.read()
    except OSError:
        return None
    for raw in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", raw)
        if not m or m.group(1) != name:
            continue
        value = re.sub(r"^([\"'])(.*)\1$", r"\2", m.group(2)).strip()
        if value:
            return value
    return None


def legacy_root() -> str:
    """The Unity project root: ``$FF2_LEGACY``. Raises when it is not set."""
    root = _env_value("FF2_LEGACY")
    if not root:
        raise LegacyRootUnsetError(LEGACY_UNSET_MESSAGE)
    return root


def legacy_available() -> bool:
    """True when ``FF2_LEGACY`` is set and the read-only project is mounted here."""
    root = _env_value("FF2_LEGACY")
    return bool(root) and os.path.isdir(root)


def legacy_path(*parts: str) -> str:
    """A path inside the Unity project, with forward slashes on the way out.

    Every provenance string in the generated trees uses forward slashes, and a
    Windows backslash would make ``pnpm extract:check`` fail on a machine that
    produced identical DATA.
    """
    return os.path.join(legacy_root(), *parts).replace(os.sep, "/")
