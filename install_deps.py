#!/usr/bin/env python3
"""
Install documind dependencies (no admin required)
Downloads Ghostscript and GraphicsMagick to ~/Downloads/documind-deps/
"""

import subprocess
import zipfile
import shutil
import os
from pathlib import Path
import json


def download(url, dest, min_size=1000):
    """Download file using Windows curl.exe with redirect support"""
    print(f"Downloading from: {url}")
    result = subprocess.run(
        ["curl.exe", "-L", "-o", str(dest), "-A", "Mozilla/5.0",
         "--max-time", "300", "--ssl-no-revoke", url],
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        raise Exception(f"Download failed: {result.stderr}")
    if not os.path.exists(dest) or os.path.getsize(dest) < min_size:
        raise Exception(f"Downloaded file is too small or missing")
    size_mb = os.path.getsize(dest) / (1024 * 1024)
    print(f"Downloaded: {dest} ({size_mb:.1f} MB)")


def install():
    base_dir = Path.home() / "Downloads" / "documind-deps"
    base_dir.mkdir(parents=True, exist_ok=True)

    # -----------------------------------------------------------------------
    # Ghostscript
    # -----------------------------------------------------------------------
    gs_dir = base_dir / "ghostscript"
    has_gs = gs_dir.exists() and (
        any(gs_dir.glob("**/gswin64c.exe")) or any(gs_dir.glob("**/gswin64.exe"))
    )

    if not has_gs:
        print("=" * 50)
        print("Installing Ghostscript...")
        print("=" * 50)

        if gs_dir.exists():
            shutil.rmtree(gs_dir, ignore_errors=True)

        gs_api_url = "https://api.github.com/repos/ArtifexSoftware/ghostpdl-downloads/releases/tags/gs10040"
        api_result = subprocess.run(
            ["curl.exe", "-s", "--ssl-no-revoke", "-H", "Accept: application/vnd.github.v3+json", gs_api_url],
            capture_output=True, text=True
        )
        release_data = json.loads(api_result.stdout)

        # The Windows release is gs10040w64.exe (NSIS installer, no zip available)
        gs_url = None
        for asset in release_data.get("assets", []):
            if asset["name"] == "gs10040w64.exe":
                gs_url = asset["browser_download_url"]
                print(f"Found installer: {asset['name']}")
                break

        if not gs_url:
            raise Exception("Could not find gs10040w64.exe in release assets")

        gs_installer = base_dir / "gs_installer.exe"
        if gs_installer.exists() and gs_installer.stat().st_size > 1_000_000:
            print(f"Reusing existing installer: {gs_installer}")
        else:
            download(gs_url, gs_installer, min_size=10000)

        # Run the NSIS installer silently to our user directory.
        # __COMPAT_LAYER=RUNASINVOKER bypasses the elevation requirement
        # so the installer runs as the current user without UAC prompt.
        gs_dir.mkdir(exist_ok=True)
        print("Running silent install (bypassing elevation via RUNASINVOKER)...")
        env = os.environ.copy()
        env["__COMPAT_LAYER"] = "RUNASINVOKER"
        install_result = subprocess.run(
            [str(gs_installer), "/S", f"/D={gs_dir}"],
            capture_output=True, text=True, timeout=120, env=env
        )

        # Clean up installer
        try:
            gs_installer.unlink(missing_ok=True)
        except Exception:
            pass

        if any(gs_dir.glob("**/gswin64c.exe")):
            print("Ghostscript installed successfully!")
        else:
            # The NSIS silent install puts files directly in the target dir
            # Check if bin subfolder exists
            contents = list(gs_dir.iterdir()) if gs_dir.exists() else []
            print(f"Directory contents: {[c.name for c in contents]}")
            print("WARNING: gswin64c.exe not found. Silent install may have failed.")
            print("Try running the installer manually (no admin should be needed):")
            print(f"  Download from: {gs_url}")
            print(f"  Install to: {gs_dir}")
    else:
        print("Ghostscript already installed")

    # -----------------------------------------------------------------------
    # GraphicsMagick
    # -----------------------------------------------------------------------
    gm_dir = base_dir / "graphicsmagick"
    has_gm = gm_dir.exists() and any(gm_dir.glob("**/gm.exe"))

    if not has_gm:
        print()
        print("=" * 50)
        print("Installing GraphicsMagick...")
        print("=" * 50)

        if gm_dir.exists():
            shutil.rmtree(gm_dir, ignore_errors=True)

        gm_dir.mkdir(exist_ok=True)

        # GraphicsMagick Q16 win64 Inno Setup installer from SourceForge.
        # Use downloads.sourceforge.net for direct mirror download.
        gm_version = "1.3.45"
        gm_installer = base_dir / "gm_installer.exe"

        if gm_installer.exists() and gm_installer.stat().st_size > 5_000_000:
            print(f"Reusing existing installer: {gm_installer}")
        else:
            # SourceForge /download URLs serve HTML interstitials.
            # Use direct mirror URLs instead (format: <mirror>.dl.sourceforge.net).
            gm_file = f"GraphicsMagick-{gm_version}-Q16-win64-dll.exe"
            gm_path = f"project/graphicsmagick/graphicsmagick-binaries/{gm_version}/{gm_file}"
            sf_mirrors = ["deac-riga", "phoenixnap", "iweb", "netcologne", "kent", "jaist"]
            gm_urls = [f"https://{m}.dl.sourceforge.net/{gm_path}" for m in sf_mirrors]

            downloaded = False
            for url in gm_urls:
                try:
                    download(url, gm_installer, min_size=5_000_000)
                    downloaded = True
                    break
                except Exception as e:
                    print(f"  Failed: {e}")
                    continue

            if not downloaded:
                print("Could not download GraphicsMagick.")
                print("Please download manually from:")
                print(f"  https://sourceforge.net/projects/graphicsmagick/files/graphicsmagick-binaries/{gm_version}/")
                print(f"  Run the installer and set install path to: {gm_dir}")

        if gm_installer.exists() and gm_installer.stat().st_size > 5_000_000:
            # Run Inno Setup installer silently to user directory.
            # RUNASINVOKER bypasses elevation requirement.
            print("Running silent install (bypassing elevation via RUNASINVOKER)...")
            env = os.environ.copy()
            env["__COMPAT_LAYER"] = "RUNASINVOKER"
            try:
                subprocess.run(
                    [str(gm_installer), "/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES",
                     f"/DIR={gm_dir}", "/NOICONS"],
                    capture_output=True, text=True, timeout=120, env=env
                )
            except Exception as e:
                print(f"Silent install error: {e}")

            # Clean up installer
            try:
                gm_installer.unlink(missing_ok=True)
            except Exception:
                pass

            if any(gm_dir.glob("**/gm.exe")):
                print("GraphicsMagick installed successfully!")
            else:
                contents = list(gm_dir.iterdir()) if gm_dir.exists() else []
                print(f"Directory contents: {[c.name for c in contents]}")
                print("WARNING: gm.exe not found after installation.")
                print("You may need to install manually:")
                print(f"  https://sourceforge.net/projects/graphicsmagick/files/graphicsmagick-binaries/{gm_version}/")
                print(f"  Set install path to: {gm_dir}")
    else:
        print("GraphicsMagick already installed")

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    print()
    print("=" * 50)
    print(f"Dependencies directory: {base_dir}")
    print()

    gs_ok = gs_dir.exists() and (
        any(gs_dir.glob("**/gswin64c.exe")) or any(gs_dir.glob("**/gswin64.exe"))
    )
    gm_ok = gm_dir.exists() and any(gm_dir.glob("**/gm.exe"))

    print(f"  Ghostscript:    {'OK' if gs_ok else 'MISSING'}")
    print(f"  GraphicsMagick: {'OK' if gm_ok else 'MISSING'}")
    print("=" * 50)


if __name__ == "__main__":
    install()
