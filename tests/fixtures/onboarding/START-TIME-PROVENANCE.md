# Synthetic macOS start-time producers

`start-time-producers.json` contains verbatim `_get_process_start_time` functions
from the three commits pinned in `tests/fixtures/hermes-compatibility/manifest.json`.
Each entry records the source path, line and full source-file SHA256. These are
source fixtures, never imports of Hermes or executions against a real process.
The harness makes `/proc` absent and substitutes `psutil.Process.create_time`.

The installed producer returns float epoch seconds unchanged. Stable and forward
return `int(round(create_time() * 100))`. Tests use independently specified expected
centiseconds below/at/above even and odd rounding ties, second carry, and fractional
seconds that are not binary-exact. The older seconds representation retains the
fraction rather than being treated as an integer or rounded to centiseconds.

The native conversion was cross-checked against psutil's macOS
`PSUTIL_TV2DOUBLE` in [5.9.0](https://github.com/giampaolo/psutil/blob/release-5.9.0/psutil/_psutil_osx.c),
[5.9.8](https://github.com/giampaolo/psutil/blob/release-5.9.8/psutil/arch/osx/proc.c)
and [7.0.0](https://github.com/giampaolo/psutil/blob/release-7.0.0/psutil/arch/osx/proc.c):
seconds plus microseconds divided by 1,000,000. No extra rounding of older seconds
is justified by these sources. Stable/forward pin psutil 7.2.2, whose
[macOS wrapper](https://github.com/giampaolo/psutil/blob/release-7.2.2/psutil/_psosx.py)
can additionally adjust creation time after system-clock changes. Such unmatched
records fail closed; this helper does not infer an adjustment from live clock or
boot metadata. Source inspection is not live sysctl/libproc equivalence proof.

After the initial producer-format match, all checks compare the exact native
seconds/microseconds pair retained at acquisition start. Tests reject a one-
microsecond generation change even inside the producer's rounding bucket, both
after socket enumeration and after reading the synthetic candidate. A rounded
persisted record cannot prove finer historical identity before acquisition starts.

The extracted Hermes functions are distributed under the following license:

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
