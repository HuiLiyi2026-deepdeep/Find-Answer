# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent

datas = [(str(ROOT / "frontend" / "dist"), "web")]
binaries = []
hiddenimports = []

for package in ("uvicorn", "keyring", "pypdf", "multipart", "python_multipart", "dotenv"):
    hiddenimports += [
        name for name in collect_submodules(package) if ".test" not in name
    ]

chroma_datas, chroma_binaries, chroma_hidden = collect_all(
    "chromadb", filter_submodules=lambda name: ".test" not in name
)
datas += chroma_datas
binaries += chroma_binaries
hiddenimports += chroma_hidden

for package in ("pythonnet", "clr_loader"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

hiddenimports += [
    "webview.platforms.winforms",
    "webview.platforms.edgechromium",
    "clr",
]

a = Analysis(
    [str(ROOT / "backend" / "desktop.py")],
    pathex=[str(ROOT / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "tkinter"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="FindAnswer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="FindAnswer",
)
