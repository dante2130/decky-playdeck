"""Package the built voice relay, frontend, and pinned Python dependencies."""
from importlib.metadata import distributions
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
files = ("plugin.json", "package.json", "main.py", "voice_push.py", "psn-push-intermediate.pem",
         "LICENSE", "README.md", "dist/index.js", "dist/party-voice-native")
if any(not (root / name).is_file() for name in files):
    raise SystemExit("Build the frontend and native relay before packaging.")
modules = root / "py_modules"
installed = {item.metadata["Name"].lower(): item.version for item in distributions(path=[str(modules)])}
for requirement in (root / "requirements-build.txt").read_text().splitlines():
    name, version = requirement.split("==")
    if installed.get(name) != version:
        raise SystemExit("Install dependencies with python3 -m pip install --target py_modules -r requirements-build.txt.")
with ZipFile(root / "PlayDeck.zip", "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, f"PlayDeck/{name}")
    for path in sorted(modules.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            archive.write(path, "PlayDeck/" + path.relative_to(modules).as_posix())
