"""Extract selected PDF pages locally. Stdout is JSON; no network or source writes."""

import json
import sys
import os


def limit_memory():
    """Bound memory before pypdf opens untrusted compressed streams."""
    limit = 512 * 1024 * 1024
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        return

    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits),
                    ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
    kernel.CreateJobObjectW.restype = ctypes.c_void_p
    kernel.SetInformationJobObject.argtypes = (ctypes.c_void_p, ctypes.c_int,
                                               ctypes.c_void_p, wintypes.DWORD)
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "cannot create PDF memory limit")
    settings = ExtendedLimits()
    settings.BasicLimitInformation.LimitFlags = 0x00000100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
    settings.ProcessMemoryLimit = limit
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(settings), ctypes.sizeof(settings)):
        raise OSError(ctypes.get_last_error(), "cannot set PDF memory limit")
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "cannot apply PDF memory limit")
    global _memory_job
    _memory_job = job


limit_memory()

try:
    from pypdf import PdfReader
except ImportError as exc:
    raise SystemExit("pypdf is required for local PDF extraction") from exc


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: pdf_extract.py FILE.pdf PAGES_JSON")
    reader = PdfReader(sys.argv[1], strict=True)
    if reader.is_encrypted:
        raise SystemExit("encrypted PDF is not supported")
    pages = json.loads(sys.argv[2])
    if not isinstance(pages, list) or not all(type(n) is int for n in pages):
        raise SystemExit("pages must be an integer array")
    total = len(reader.pages)
    if not pages or len(set(pages)) != len(pages) or sorted(pages) != pages:
        raise SystemExit("pages must be nonempty, unique, and sorted")
    if any(n < 1 or n > total for n in pages):
        raise SystemExit("page outside PDF")

    results = []
    for number in pages:
        extracted = ""
        images = 0
        error = None
        try:
            page = reader.pages[number - 1]
            contents = page.get_contents()
            if contents and len(contents.get_data()) > 20 * 1024 * 1024:
                raise ValueError("page content stream exceeds 20 MiB")
            extracted = page.extract_text(extraction_mode="layout") or ""
        except Exception as exc:
            error = str(exc)[:300]
        if error is None:
            try:
                images = len(page.images)
            except Exception as exc:
                error = f"image inspection failed: {exc}"[:300]
        results.append({
            "pdfPageIndex": number,
            "printedPageLabel": "unknown",
            "text": extracted,
            "imageCount": images,
            "error": error,
        })

    print(json.dumps({"totalPages": total, "pages": results}))


if __name__ == "__main__":
    main()
