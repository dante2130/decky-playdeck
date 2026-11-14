"""Build the Decky local-install ZIP after compiling the frontend."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
files = ("plugin.json", "package.json", "main.py", "LICENSE", "README.md", "dist/index.js")
if any(not (root / name).is_file() for name in files):
    raise SystemExit("Run pnpm build before packaging.")
with ZipFile(root / "PlayDeck.zip", "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, f"PlayDeck/{name}")
