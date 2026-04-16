#!/usr/bin/env python3
"""
Add external file links on a parent PDF pointing to child files (DWG, etc.).

Each child is referenced by a file:// URI on a chosen page—files are NOT embedded;
they stay on disk (xref-style external references).

Requires: pip install pymupdf

Usage (absolute paths on this machine):
  python tools/pdf_set_child_file_links.py --pdf parent.pdf --child a.dwg -o out.pdf

Usage (no full paths — co-located child next to the saved PDF):
  python tools/pdf_set_child_file_links.py -o out.pdf --relative-name drawing.dwg
  python tools/pdf_set_child_file_links.py --pdf existing.pdf -o out.pdf --relative-name child.dwg

PyMuPDF insert_link (LINK_URI): uri should use a disambiguating prefix (file://, http://, ...).
See https://pymupdf.readthedocs.io/en/latest/page.html#Page.insert_link
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import quote

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Install PyMuPDF: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


def path_to_file_uri(p: Path) -> str:
    p = p.resolve()
    uri = p.as_uri()
    if not uri.startswith("file:"):
        raise ValueError(f"Unexpected URI form: {uri}")
    return uri


def relative_child_uri(filename: str) -> str:
    """
    Link target co-located with the PDF (same folder). No absolute path required.
    Uses file:./ + percent-encoded basename (PyMuPDF expects a disambiguating file: prefix).
    """
    # Encode spaces and special chars; keep common filename characters unescaped.
    enc = quote(filename, safe="!$&'()*+,-.0123456789=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~")
    return f"file:./{enc}"


def add_child_links_by_filename(
    output: Path,
    child_filenames: list[str],
    *,
    parent_pdf: Path | None = None,
    page: int = 0,
    margin: float = 36.0,
    row_height: float = 22.0,
    link_width: float = 400.0,
    link_height: float = 18.0,
    labels: bool = True,
) -> None:
    """
    Add file:./ChildName links — resolves next to the saved PDF when viewed (no full paths).
    If parent_pdf is None or missing, creates a one-page blank parent PDF.
    """
    if not child_filenames:
        raise ValueError("At least one child filename is required")

    if parent_pdf is not None and parent_pdf.is_file():
        doc = fitz.open(parent_pdf)
    else:
        doc = fitz.open()
        doc.new_page()
    try:
        if page < 0 or page >= doc.page_count:
            raise ValueError(f"Invalid page {page}; document has {doc.page_count} page(s)")
        pg = doc[page]
        x0 = margin
        y = margin
        w, h = link_width, link_height
        for name in child_filenames:
            uri = relative_child_uri(name)
            rect = fitz.Rect(x0, y, x0 + w, y + h)
            pg.insert_link({"kind": fitz.LINK_URI, "from": rect, "uri": uri})
            if labels:
                pg.insert_text((x0, y + h - 3), name, fontsize=10, color=(0, 0, 0.8))
            y += row_height
            if y + h > pg.rect.height - margin:
                print(
                    "Warning: ran out of vertical space on page; remaining children skipped.",
                    file=sys.stderr,
                )
                break
        output.parent.mkdir(parents=True, exist_ok=True)
        doc.save(output, garbage=4, deflate=True)
    finally:
        doc.close()


def add_child_file_links(
    parent: Path,
    children: list[Path],
    output: Path,
    *,
    page: int = 0,
    margin: float = 36.0,
    row_height: float = 22.0,
    link_width: float = 400.0,
    link_height: float = 18.0,
    labels: bool = True,
) -> None:
    """Open parent PDF, add file:// links to each child path, save to output."""
    if not parent.is_file():
        raise FileNotFoundError(f"Parent PDF not found: {parent}")
    if not children:
        raise ValueError("At least one child path is required")

    for c in children:
        if not c.is_file():
            print(f"Warning: child not found (link still added): {c}", file=sys.stderr)

    doc = fitz.open(parent)
    try:
        if page < 0 or page >= doc.page_count:
            raise ValueError(f"Invalid page {page}; document has {doc.page_count} page(s)")
        pg = doc[page]
        x0 = margin
        y = margin
        w, h = link_width, link_height
        for child in children:
            uri = path_to_file_uri(child)
            rect = fitz.Rect(x0, y, x0 + w, y + h)
            pg.insert_link({"kind": fitz.LINK_URI, "from": rect, "uri": uri})
            if labels:
                pg.insert_text((x0, y + h - 3), child.name, fontsize=10, color=(0, 0, 0.8))
            y += row_height
            if y + h > pg.rect.height - margin:
                print(
                    "Warning: ran out of vertical space on page; remaining children skipped.",
                    file=sys.stderr,
                )
                break
        output.parent.mkdir(parents=True, exist_ok=True)
        doc.save(output, garbage=4, deflate=True)
    finally:
        doc.close()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Add external file:// links from a PDF to child files (non-embedded)."
    )
    ap.add_argument(
        "--pdf",
        type=Path,
        default=None,
        help="Parent PDF path (optional with --relative-name; if omitted or missing, a blank one-page PDF is used)",
    )
    ap.add_argument(
        "--child",
        action="append",
        default=[],
        type=Path,
        help="Child file path (repeat for multiple)",
    )
    ap.add_argument(
        "--children-list",
        type=Path,
        help="Text file: one child path per line (# comments and blank lines ok)",
    )
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        required=True,
        help="Output PDF path",
    )
    ap.add_argument(
        "--page",
        type=int,
        default=0,
        help="0-based page index to place links (default: first page)",
    )
    ap.add_argument(
        "--margin",
        type=float,
        default=36.0,
        help="Left/top margin in points (default 36)",
    )
    ap.add_argument(
        "--row-height",
        type=float,
        default=22.0,
        help="Vertical spacing between link rows in points",
    )
    ap.add_argument(
        "--link-width",
        type=float,
        default=400.0,
        help="Clickable region width in points",
    )
    ap.add_argument(
        "--link-height",
        type=float,
        default=18.0,
        help="Clickable region height in points",
    )
    ap.add_argument(
        "--no-labels",
        action="store_true",
        help="Do not draw filename text on the link rows",
    )
    ap.add_argument(
        "--relative-name",
        action="append",
        default=[],
        metavar="FILENAME",
        help="Child basename only (repeat); uses file:./FILENAME — no absolute paths",
    )
    ap.add_argument(
        "--relative-list",
        type=Path,
        help="Text file: one child filename per line for file:./ links",
    )
    args = ap.parse_args()

    rel_names: list[str] = list(args.relative_name)
    if args.relative_list:
        text = args.relative_list.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            rel_names.append(line)

    if rel_names:
        parent_opt = args.pdf if args.pdf is not None and args.pdf.is_file() else None
        try:
            add_child_links_by_filename(
                args.output,
                rel_names,
                parent_pdf=parent_opt,
                page=args.page,
                margin=args.margin,
                row_height=args.row_height,
                link_width=args.link_width,
                link_height=args.link_height,
                labels=not args.no_labels,
            )
        except (FileNotFoundError, ValueError, OSError) as e:
            sys.exit(str(e))
        print(f"Wrote {args.output} with relative links to {len(rel_names)} name(s).")
        return

    if args.pdf is None or not args.pdf.is_file():
        sys.exit("Parent PDF not found: provide a valid --pdf for absolute-path mode")
    parent = args.pdf

    children: list[Path] = list(args.child)
    if args.children_list:
        text = args.children_list.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            children.append(Path(line))
    if not children:
        sys.exit("Provide --child/--children-list, or use --relative-name / --relative-list")

    try:
        add_child_file_links(
            parent,
            children,
            args.output,
            page=args.page,
            margin=args.margin,
            row_height=args.row_height,
            link_width=args.link_width,
            link_height=args.link_height,
            labels=not args.no_labels,
        )
    except (FileNotFoundError, ValueError, OSError) as e:
        sys.exit(str(e))
    print(f"Wrote {args.output} with links to {len(children)} path(s).")


if __name__ == "__main__":
    main()
