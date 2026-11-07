
## 2026-11-06 — Testing credential handling with a real CLI
- **Pattern:** a CLI given a placeholder credential fell back to the machine's stored login (macOS keychain) and sent real tokens to the test server.
- **Rule:** when testing how a CLI handles credentials, run it with an isolated, empty `HOME` (and no keychain access), and never print captured headers in full. Log only a prefix such as `cbp_` or `sk-ant-…`.
