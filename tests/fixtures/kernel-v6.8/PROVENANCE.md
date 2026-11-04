# Linux v6.8 syscall and audit fixtures

Retrieved 2026-11-03 from the official Linux tag `v6.8` on GitHub:

| File | Upstream path | SHA-256 |
|---|---|---|
| `unistd.h` | `include/uapi/asm-generic/unistd.h` | `2807c5c2e1ad8128b37438f81cf9776b52fb664b48d93e2ea8edb06846eda90d` |
| `syscall_64.tbl` | `arch/x86/entry/syscalls/syscall_64.tbl` | `4c30abea9a4b69f3409bea7a0c910a8c8feb9a44b22a448b5c82f2bfdd8249c8` |
| `audit.h` | `include/uapi/linux/audit.h` | `db86160b09c1ef7c1ac2dd59a9d6b5d19a8494739dd8d78fc0464e8bc8ad8f55` |
| `elf-em.h` | `include/uapi/linux/elf-em.h` | `e72cca577a97d1fccc7f4e5d37b39b401a527a97f02e589255c247b63cb227d2` |

URLs: `https://raw.githubusercontent.com/torvalds/linux/v6.8/<path>`.

License: GPL-2.0 WITH Linux-syscall-note, as stated by the SPDX headers preserved in each
file. These files are test evidence only; they are not copied into any image or runtime.

`elf-em.h` is included because `audit.h` expresses `AUDIT_ARCH_*` with the `EM_*` machine
constants defined there. Tests use these files to independently check the syscall numbers,
audit architecture values and the emitted seccomp tables in `docker/desktop/bootstrap.py`.
