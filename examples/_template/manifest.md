# Input manifest

Every external input this case depends on. Anyone re-running the case uses this
to obtain the same data — whether it's committed via LFS or must be downloaded.

| Input | Location in case | Source | Committed? | Notes |
|-------|------------------|--------|-----------|-------|
| <name> | `data/<file>` | <URL / DOI> | LFS / link-only | <license, size, checksum> |

## Notes

- **Committed via LFS:** file lives under `data/` and is fetched with `git lfs pull`.
- **Link-only:** too large or license-encumbered to store; download from Source into `data/` before running.
