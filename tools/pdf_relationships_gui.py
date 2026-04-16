#!/usr/bin/env python3
"""
Desktop GUI for PDF↔DWG link batch (relationships.xlsx or folder of files).

Requires: pip install pymupdf openpyxl
Run: python tools/pdf_relationships_gui.py
"""

from __future__ import annotations

import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

_TOOLS = Path(__file__).resolve().parent
if str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))

from run_relationships_pdf_links import (  # noqa: E402
    run_excel_batch,
    run_folder_batch,
)


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("PDF ↔ DWG links (co-located / Adept-friendly)")
        self.geometry("720x520")
        self.minsize(640, 440)

        root_dir = Path(__file__).resolve().parents[1]
        self._mode = tk.StringVar(value="excel")
        self._xlsx = tk.StringVar(value=str(root_dir / "relationships.xlsx"))
        self._base = tk.StringVar(value="")
        self._input_folder = tk.StringVar(value="")
        self._output = tk.StringVar(value=str(root_dir / "linked_pdf_output"))
        self._absolute = tk.BooleanVar(value=False)
        self._bootstrap = tk.BooleanVar(value=False)
        self._labels = tk.BooleanVar(value=True)

        pad = {"padx": 8, "pady": 4}
        frm = ttk.Frame(self, padding=10)
        frm.pack(fill=tk.BOTH, expand=True)

        ttk.Label(
            frm,
            text=(
                "Pairs PDF + DWG with the same base name (e.g. drawing.pdf + drawing.dwg).\n"
                "Default: file:./ChildName.dwg links (put the DWG next to the PDF when you deploy)."
            ),
            wraplength=680,
        ).pack(anchor=tk.W, **pad)

        mode = ttk.LabelFrame(frm, text="Source", padding=8)
        mode.pack(fill=tk.X, **pad)
        ttk.Radiobutton(
            mode,
            text="Excel: relationships.xlsx (column A = filenames)",
            variable=self._mode,
            value="excel",
        ).pack(anchor=tk.W)
        ttk.Radiobutton(
            mode,
            text="Folder: all .pdf + .dwg in one folder (matched by name)",
            variable=self._mode,
            value="folder",
        ).pack(anchor=tk.W)

        ex = ttk.LabelFrame(frm, text="Excel options", padding=8)
        ex.pack(fill=tk.X, **pad)
        r1 = ttk.Frame(ex)
        r1.pack(fill=tk.X)
        ttk.Label(r1, text="Spreadsheet:", width=14).pack(side=tk.LEFT)
        ttk.Entry(r1, textvariable=self._xlsx, width=58).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(r1, text="Browse…", command=self._pick_xlsx).pack(side=tk.LEFT, padx=4)
        r2 = ttk.Frame(ex)
        r2.pack(fill=tk.X, pady=(6, 0))
        ttk.Label(r2, text="Source PDF folder:", width=18).pack(side=tk.LEFT)
        ttk.Entry(r2, textvariable=self._base, width=56).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(r2, text="Browse…", command=self._pick_base).pack(side=tk.LEFT, padx=4)
        ttk.Label(
            ex,
            text=(
                "Leave empty: each output is a new minimal PDF with the link only. "
                "Or pick the folder where your real .pdf files are: those pages are used as the parent, "
                "then *_linked.pdf is written to Output."
            ),
            foreground="#444",
            wraplength=660,
        ).pack(anchor=tk.W, pady=(4, 0))

        fo = ttk.LabelFrame(frm, text="Folder options", padding=8)
        fo.pack(fill=tk.X, **pad)
        r3 = ttk.Frame(fo)
        r3.pack(fill=tk.X)
        ttk.Label(r3, text="Input folder:", width=14).pack(side=tk.LEFT)
        ttk.Entry(r3, textvariable=self._input_folder, width=58).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(r3, text="Browse…", command=self._pick_input_folder).pack(side=tk.LEFT, padx=4)

        out = ttk.LabelFrame(frm, text="Output", padding=8)
        out.pack(fill=tk.X, **pad)
        r4 = ttk.Frame(out)
        r4.pack(fill=tk.X)
        ttk.Label(r4, text="Output folder:", width=14).pack(side=tk.LEFT)
        ttk.Entry(r4, textvariable=self._output, width=58).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(r4, text="Browse…", command=self._pick_output).pack(side=tk.LEFT, padx=4)

        opts = ttk.Frame(frm)
        opts.pack(fill=tk.X, **pad)
        ttk.Checkbutton(
            opts,
            text="Use full file:// paths (needs real files on disk for every pair)",
            variable=self._absolute,
        ).pack(anchor=tk.W)
        ttk.Checkbutton(
            opts,
            text="Excel only: create stub PDF/DWG under “Source PDF folder” first (testing)",
            variable=self._bootstrap,
        ).pack(anchor=tk.W)
        ttk.Checkbutton(opts, text="Draw blue filename labels on the page", variable=self._labels).pack(
            anchor=tk.W
        )

        ttk.Button(frm, text="Run", command=self._run).pack(pady=10)
        self._log = tk.Text(frm, height=12, wrap=tk.WORD, state=tk.DISABLED)
        self._log.pack(fill=tk.BOTH, expand=True)

    def _append_log(self, line: str) -> None:
        self._log.configure(state=tk.NORMAL)
        self._log.insert(tk.END, line + "\n")
        self._log.see(tk.END)
        self._log.configure(state=tk.DISABLED)

    def _pick_xlsx(self) -> None:
        p = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx"), ("All", "*.*")])
        if p:
            self._xlsx.set(p)

    def _pick_base(self) -> None:
        p = filedialog.askdirectory()
        if p:
            self._base.set(p)

    def _pick_input_folder(self) -> None:
        p = filedialog.askdirectory()
        if p:
            self._input_folder.set(p)

    def _pick_output(self) -> None:
        p = filedialog.askdirectory()
        if p:
            self._output.set(p)

    def _run(self) -> None:
        out = Path(self._output.get().strip())
        if not self._output.get().strip():
            messagebox.showerror("Output", "Choose an output folder.")
            return

        def work() -> None:
            def log(msg: str) -> None:
                self.after(0, lambda m=msg: self._append_log(m))

            try:
                if self._mode.get() == "folder":
                    inp = Path(self._input_folder.get().strip())
                    if not inp.is_dir():
                        self.after(0, lambda: messagebox.showerror("Folder", "Pick a valid input folder."))
                        return
                    run_folder_batch(
                        inp,
                        out,
                        absolute_paths=self._absolute.get(),
                        labels=self._labels.get(),
                        log=log,
                    )
                else:
                    xlsx = Path(self._xlsx.get().strip())
                    if not xlsx.is_file():
                        self.after(0, lambda: messagebox.showerror("Excel", "Spreadsheet not found."))
                        return
                    base_s = self._base.get().strip()
                    base = Path(base_s) if base_s else None
                    if self._bootstrap.get() and base is None:
                        self.after(
                            0,
                            lambda: messagebox.showerror(
                                "Bootstrap", "Set “Source PDF folder” for stub creation."
                            ),
                        )
                        return
                    if self._absolute.get() and base is None:
                        self.after(
                            0,
                            lambda: messagebox.showerror(
                                "Absolute paths",
                                "Set “Source PDF folder” to the folder that contains the real PDF and DWG files.",
                            ),
                        )
                        return
                    run_excel_batch(
                        xlsx,
                        out,
                        base=base,
                        absolute_paths=self._absolute.get(),
                        bootstrap_stubs=self._bootstrap.get() and base is not None,
                        labels=self._labels.get(),
                        log=log,
                    )
                self.after(0, lambda: messagebox.showinfo("Done", "Finished. See log above."))
            except ValueError as e:
                self.after(0, lambda err=str(e): messagebox.showerror("Error", err))
            except Exception as e:  # noqa: BLE001
                self.after(0, lambda err=str(e): messagebox.showerror("Error", err))

        self._log.configure(state=tk.NORMAL)
        self._log.delete("1.0", tk.END)
        self._log.configure(state=tk.DISABLED)
        threading.Thread(target=work, daemon=True).start()


def main() -> None:
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
