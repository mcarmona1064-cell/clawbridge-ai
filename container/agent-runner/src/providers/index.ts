// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.
//
// Both real providers ship in the same image; which one a session uses is
// decided by the host (session → agent group → container.json → default)
// and passed in as CLAWBRIDGE_PROVIDER.

import './claude.js';
import './codex.js';
import './mock.js';
